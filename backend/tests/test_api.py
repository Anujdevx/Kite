"""Backend contract tests. No network: LiteLLM's own `mock_response` stands in for the
provider, so LiteLLM's real cache and our real failover loop are what is under test."""
import os
import uuid

import litellm
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/app.db")
    monkeypatch.setenv("LLM_API_KEYS", "test-key-1,test-key-2")
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "true")
    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def fake_provider(monkeypatch):
    """Wrap litellm.acompletion so the provider answers with a mock (after a 200 ms 'network'
    delay) instead of calling Gemini. `fail` maps an api_key to the exception it should raise."""
    real = litellm.acompletion
    calls, fail = [], {}

    async def fake(**kwargs):
        calls.append(kwargs["api_key"])
        if kwargs["api_key"] in fail:
            kwargs["mock_response"] = fail[kwargs["api_key"]]
        else:
            kwargs["mock_response"] = "reply to: " + kwargs["messages"][-1]["content"]
        kwargs["mock_delay"] = 0.2
        return await real(**kwargs)

    monkeypatch.setattr(litellm, "acompletion", fake)
    return calls, fail


def sid():
    return "s-" + uuid.uuid4().hex[:8]


def msg():
    return "question " + uuid.uuid4().hex  # unique, so tests never share cache entries


def chat(client, session_id, message, **extra):
    headers = extra.pop("headers", {})
    return client.post("/chat", json={"session_id": session_id, "message": message, **extra}, headers=headers)


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "keys_configured": 2, "cache_enabled": True}


def test_chat_live_inference_shape(client):
    s, m = sid(), msg()
    r = chat(client, s, m)
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == s
    assert body["reply"] == "reply to: " + m
    meta = body["metadata"]
    assert meta["resolution_source"] == "LIVE_INFERENCE"
    assert meta["model"] == "gemini/gemini-2.5-flash-lite"
    assert meta["key_id"] == "key_1"
    assert meta["fallback_attempts"] == 0
    for f in ("latency_ms", "input_tokens", "output_tokens"):
        assert isinstance(meta[f], int)


def test_same_first_message_in_new_session_is_cache_hit(client, fake_provider):
    calls, _ = fake_provider
    m = msg()
    live = chat(client, sid(), m).json()
    hit = chat(client, sid(), m).json()
    assert live["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert hit["metadata"]["resolution_source"] == "LLM_CACHE"
    assert hit["reply"] == live["reply"]  # identical text
    assert hit["metadata"]["key_id"] is None
    assert hit["metadata"]["fallback_attempts"] == 0
    # tokens are the usage stored with the cached response
    assert hit["metadata"]["input_tokens"] == live["metadata"]["input_tokens"]
    assert hit["metadata"]["output_tokens"] == live["metadata"]["output_tokens"]
    assert hit["metadata"]["latency_ms"] < live["metadata"]["latency_ms"]
    assert len(calls) == 2  # LiteLLM is still called; it answers from cache without the provider


def test_different_message_never_from_cache(client):
    chat(client, sid(), msg())
    r = chat(client, sid(), msg()).json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_different_system_prompt_is_a_different_cache_key(client):
    m = msg()
    chat(client, sid(), m)
    r = chat(client, sid(), m, system_prompt="Answer like a pirate.").json()
    assert r["metadata"]["resolution_source"] == "LIVE_INFERENCE"


def test_multi_turn_history_and_persistence(client, fake_provider):
    s, m1, m2 = sid(), msg(), msg()
    chat(client, s, m1)
    chat(client, s, m2)
    hist = client.get(f"/sessions/{s}/messages").json()
    assert hist["session_id"] == s
    assert [x["role"] for x in hist["messages"]] == ["user", "assistant", "user", "assistant"]
    assert hist["messages"][2]["content"] == m2
    assert "metadata" not in hist["messages"][0]
    assert hist["messages"][1]["metadata"]["resolution_source"] == "LIVE_INFERENCE"
    assert all(x["role"] != "system" for x in hist["messages"])
    # other sessions are separate
    other = sid()
    chat(client, other, msg())
    assert len(client.get(f"/sessions/{other}/messages").json()["messages"]) == 2


def test_history_is_sent_to_the_llm(client, monkeypatch):
    seen = []
    real = litellm.acompletion

    async def spy(**kwargs):
        seen.append(kwargs["messages"])
        return await real(**kwargs)

    monkeypatch.setattr(litellm, "acompletion", spy)
    s, m1, m2 = sid(), msg(), msg()
    chat(client, s, m1)
    chat(client, s, m2, system_prompt="Be terse.")
    roles = [x["role"] for x in seen[-1]]
    assert roles == ["system", "user", "assistant", "user"]
    assert seen[-1][0]["content"] == "Be terse."
    assert seen[-1][1]["content"] == m1 and seen[-1][3]["content"] == m2


def test_history_survives_app_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/persist.db")
    monkeypatch.setenv("LLM_API_KEYS", "a,b")
    from app.main import app

    s = sid()
    with TestClient(app) as c:
        chat(c, s, msg())
    with TestClient(app) as c:  # new lifespan = "container restart" on the same file
        assert len(c.get(f"/sessions/{s}/messages").json()["messages"]) == 2


def test_tokens_are_per_request_not_running_total(client):
    s = sid()
    first = chat(client, s, msg()).json()["metadata"]
    second = chat(client, s, msg()).json()["metadata"]
    # The provider reports usage per call; we must not add the previous turn's tokens to it.
    assert second["input_tokens"] == first["input_tokens"]
    assert second["output_tokens"] == first["output_tokens"]


@pytest.mark.parametrize("status", ["429", "500", "502", "503"])
def test_simulated_failure_on_key_1_fails_over_to_key_2(client, status):
    s = sid()
    r = chat(client, s, msg(), headers={"X-Simulate-Failure": f"key_1={status}"})
    assert r.status_code == 200
    meta = r.json()["metadata"]
    assert meta["key_id"] == "key_2"
    assert meta["fallback_attempts"] == 1
    assert meta["resolution_source"] == "LIVE_INFERENCE"
    assert r.json()["reply"].startswith("reply to:")  # a real answer, not an error in a 200


def test_simulated_failover_still_uses_live_keys_for_cached_prompt(client):
    m = msg()
    chat(client, sid(), m)
    r = chat(client, sid(), m, headers={"X-Simulate-Failure": "key_1=429"}).json()
    assert r["metadata"]["key_id"] == "key_2"


def test_all_keys_failing_returns_503_and_writes_nothing(client):
    s = sid()
    for header in ("*=429", "key_1=429,key_2=500"):
        r = chat(client, s, msg(), headers={"X-Simulate-Failure": header})
        assert r.status_code == 503
        assert r.json() == {"detail": "all providers unavailable"}
    assert client.get(f"/sessions/{s}/messages").status_code == 404


def test_real_provider_429_fails_over(client, fake_provider):
    """Not the header hook: LiteLLM itself raises RateLimitError for key_1."""
    calls, fail = fake_provider
    fail["test-key-1"] = litellm.RateLimitError(message="quota exceeded", llm_provider="gemini", model="x")
    r = chat(client, sid(), msg()).json()
    assert r["metadata"]["key_id"] == "key_2"
    assert r["metadata"]["fallback_attempts"] == 1


def test_real_provider_5xx_on_every_key_is_503(client, fake_provider):
    _, fail = fake_provider
    for k in ("test-key-1", "test-key-2"):
        fail[k] = litellm.ServiceUnavailableError(message="down", llm_provider="gemini", model="x")
    r = chat(client, sid(), msg())
    assert r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}


def test_per_key_models_across_providers(client, monkeypatch):
    monkeypatch.setenv("LLM_MODELS", "groq/llama-3.3-70b-versatile,nvidia_nim/meta/llama-3.3-70b-instruct")
    first = chat(client, sid(), msg()).json()["metadata"]
    assert (first["key_id"], first["model"]) == ("key_1", "groq/llama-3.3-70b-versatile")
    over = chat(client, sid(), msg(), headers={"X-Simulate-Failure": "key_1=503"}).json()["metadata"]
    assert (over["key_id"], over["model"]) == ("key_2", "nvidia_nim/meta/llama-3.3-70b-instruct")


def test_mismatched_llm_models_fails_fast(monkeypatch):
    from app import llm

    monkeypatch.setenv("LLM_API_KEYS", "a,b")
    monkeypatch.setenv("LLM_MODELS", "groq/x")
    with pytest.raises(RuntimeError):
        llm.key_pool()


def test_simulation_header_ignored_when_disabled(client, monkeypatch):
    monkeypatch.setenv("ENABLE_FAILURE_SIMULATION", "false")
    r = chat(client, sid(), msg(), headers={"X-Simulate-Failure": "*=429"})
    assert r.status_code == 200 and r.json()["metadata"]["key_id"] == "key_1"


def test_malformed_simulation_header_is_422(client):
    r = chat(client, sid(), msg(), headers={"X-Simulate-Failure": "key_1=418"})
    assert r.status_code == 422 and "detail" in r.json()


@pytest.mark.parametrize(
    "body",
    [
        {"session_id": "s-1"},
        {"message": "hi"},
        {"session_id": "", "message": "hi"},
        {"session_id": "s-1", "message": ""},
        {"session_id": "s-1", "message": "   "},
        {"session_id": "s-1", "message": "x" * 4001},
        {"session_id": "x" * 129, "message": "hi"},
    ],
)
def test_validation_422(client, body):
    r = client.post("/chat", json=body)
    assert r.status_code == 422 and "detail" in r.json()


def test_4000_chars_after_trim_is_ok(client):
    assert chat(client, sid(), "  " + "y" * 3999 + uuid.uuid4().hex[:1] + "  ").status_code == 200


def test_malformed_json_422(client):
    r = client.post("/chat", content=b"{not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422 and "detail" in r.json()


def test_failed_validation_writes_nothing(client):
    client.post("/chat", json={"session_id": "s-bad", "message": ""})
    assert client.get("/sessions/s-bad/messages").status_code == 404


def test_unknown_session_404(client):
    r = client.get("/sessions/does-not-exist/messages")
    assert r.status_code == 404 and r.json() == {"detail": "session not found"}


@pytest.mark.skipif(not os.getenv("LIVE_LLM_TESTS"), reason="set LIVE_LLM_TESTS=1 and real LLM_API_KEYS")
def test_live_gemini(tmp_path, monkeypatch):
    """Optional: hits the real provider with the keys in your environment."""
    monkeypatch.setattr(litellm, "acompletion", litellm.acompletion)
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path}/live.db")
    from app.main import app

    with TestClient(app) as c:
        m = "In one word, what is the capital of France? " + uuid.uuid4().hex[:6]
        live = chat(c, sid(), m).json()
        hit = chat(c, sid(), m).json()
        assert live["metadata"]["resolution_source"] == "LIVE_INFERENCE"
        assert hit["metadata"]["resolution_source"] == "LLM_CACHE" and hit["reply"] == live["reply"]
        assert hit["metadata"]["latency_ms"] < live["metadata"]["latency_ms"]
        assert live["metadata"]["input_tokens"] > 0 and live["metadata"]["output_tokens"] > 0
