"""LiteLLM gateway: ordered key pool with per-request failover + LiteLLM's built-in cache."""
import logging
import os

import litellm
from litellm.caching.caching import Cache

log = logging.getLogger("llm")

litellm.suppress_debug_info = True
# LiteLLM's built-in in-memory cache. The cache key is built by LiteLLM from the call
# params: model + the full messages list (system + history + new message). The API key
# is NOT part of it, so a reply cached via key_1 is also served when key_2 is the one tried.
litellm.cache = Cache(type="local")

SIMULATED_ERRORS = {
    429: litellm.RateLimitError,
    500: litellm.InternalServerError,
    502: litellm.BadGatewayError,
    503: litellm.ServiceUnavailableError,
}


class AllProvidersFailed(Exception):
    pass


def model() -> str:
    return os.getenv("LLM_MODEL", "gemini/gemini-2.5-flash-lite")


def api_keys() -> list[str]:
    """Key ids are key_1, key_2, ... in LLM_API_KEYS order."""
    return [k.strip() for k in os.getenv("LLM_API_KEYS", "").split(",") if k.strip()]


def key_pool() -> list[tuple[str, str, str]]:
    """[(key_id, api_key, model)]. LLM_MODELS (optional, same order as LLM_API_KEYS) lets each
    key use its own provider/model, e.g. key_1 on Groq and key_2 on OpenRouter; otherwise
    every key uses LLM_MODEL."""
    keys = api_keys()
    models = [m.strip() for m in os.getenv("LLM_MODELS", "").split(",") if m.strip()] or [model()] * len(keys)
    if len(models) != len(keys):
        raise RuntimeError(f"LLM_MODELS has {len(models)} entries but LLM_API_KEYS has {len(keys)}")
    return [(f"key_{i}", k, m) for i, (k, m) in enumerate(zip(keys, models), start=1)]


def parse_simulation(header: str) -> dict[str, int]:
    """'key_1=429,key_2=500' -> {'key_1': 429, 'key_2': 500}; '*' means every key.
    Raises ValueError on anything malformed."""
    out = {}
    for pair in filter(None, (p.strip() for p in header.split(","))):
        key_id, sep, status = pair.partition("=")
        if not sep or int(status) not in SIMULATED_ERRORS:
            raise ValueError(pair)
        out[key_id.strip()] = int(status)
    return out


async def complete(messages: list[dict], simulate: dict[str, int] | None = None) -> dict:
    """Try each key in order. Any provider error (429, quota, 5xx, timeout, bad key)
    moves on to the next key; if every key fails, raise AllProvidersFailed."""
    simulate = simulate or {}
    failed = 0
    for key_id, key, key_model in key_pool():
        kwargs = {}
        if simulate:
            # A failover demo must actually exercise the keys, so skip the cache *read*
            # (the result is still written to the cache).
            kwargs["cache"] = {"no-cache": True}
        try:
            status = simulate.get(key_id, simulate.get("*"))
            if status:
                # Same exception class LiteLLM raises for a real provider 429/5xx.
                raise SIMULATED_ERRORS[status](
                    message=f"simulated HTTP {status}", llm_provider="simulation", model=key_model
                )
            resp = await litellm.acompletion(
                model=key_model,
                messages=messages,
                api_key=key,
                num_retries=0,  # failover is ours: next key, not the same key again
                timeout=float(os.getenv("LLM_TIMEOUT_SECONDS", "30")),
                caching=True,
                **kwargs,
            )
            reply = (resp.choices[0].message.content or "").strip()
            if not reply:
                raise ValueError("empty reply")
        except Exception as e:  # noqa: BLE001 - every provider failure means "try the next key"
            failed += 1
            # Log the class and status only: never the key, and never a message that might echo it.
            log.warning("%s failed: %s status=%s", key_id, type(e).__name__, getattr(e, "status_code", None))
            continue

        cache_hit = bool(resp._hidden_params.get("cache_hit"))
        return {
            "reply": reply,
            "resolution_source": "LLM_CACHE" if cache_hit else "LIVE_INFERENCE",
            "model": key_model,
            "input_tokens": resp.usage.prompt_tokens,
            "output_tokens": resp.usage.completion_tokens,
            "key_id": None if cache_hit else key_id,
            "fallback_attempts": 0 if cache_hit else failed,
        }
    raise AllProvidersFailed()
