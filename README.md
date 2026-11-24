# Kite: LLM chatbot with key failover and response caching

Built for the Lyftr AI full-stack assignment.

React frontend, FastAPI backend, LiteLLM gateway (key pool + built-in cache), SQLite history. Each key can point at a different provider/model, so failover also survives a whole-provider outage. Deployed with open-weight models on two providers: `openai/gpt-oss-120b` on Groq (key_1) and `nvidia/nemotron-3.5-lightning-30b-a3b` on NVIDIA NIM (key_2). Both are reasoning models, so `output_tokens` includes their reasoning tokens: that is what the provider bills, and it is reported as-is.

```
Browser (React, Vite)                 FastAPI backend                         Providers
┌──────────────────────┐  POST /chat  ┌──────────────────────────────────┐
│ chat-input           │ ───────────► │ validate (Pydantic) ─► 422       │
│ assistant-message    │              │ load history (SQLite)            │
│  meta-source/model/  │ ◄─────────── │ messages = system+history+new    │
│  latency/tokens      │   reply +    │ for key_1..key_n:                │  key_1 ─► Groq      
└──────────────────────┘   metadata   │   litellm.acompletion(cache on)  │  key_2 ─► NVIDIA NIM
                                      │   error? next key                │
                                      │ all failed ─► 503                │
                                      │ save user+assistant (1 txn)      │
                                      └──────────────┬───────────────────┘
                                                     │ /data/app.db (Docker volume)
```

## 1. Live URLs

- Frontend: `[add after deploy]`
- Backend: `[add after deploy]` (try `/health`)
- Repository: https://github.com/Anujdevx/Kite

## 2. Run locally: with Docker and without

**With Docker** (backend on :8000, frontend on :3000):

```bash
cp .env.example .env      # then put 2+ real keys in LLM_API_KEYS
make up                   # docker compose up --build -d
make down
```

SQLite lives in the named volume `appdata` mounted at `/data`, so history survives `make down && make up`.

**Without Docker** (Python 3.12+, Node 20+):

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
set -a; source ../.env; set +a
export DATABASE_URL=sqlite:///./app.db
uvicorn app.main:app --port 8000
```

```bash
cd frontend
npm install
npm run dev               # http://localhost:3000, talks to VITE_API_URL (default http://localhost:8000)
```

**Tests** (no network or keys needed; LiteLLM's `mock_response` stands in for the provider):

```bash
cd backend && python -m pytest -q
# optional, against the real provider with the keys in your env:
LIVE_LLM_TESTS=1 python -m pytest -q -k live
```

### Environment variables

| Variable | Meaning |
|---|---|
| `LLM_API_KEYS` | Comma-separated key pool, at least 2. Ids are `key_1`, `key_2`, ... in this order |
| `LLM_MODELS` | Optional: one LiteLLM model per key, same order as `LLM_API_KEYS` (e.g. `groq/...,nvidia_nim/...`). Startup fails if the counts differ |
| `LLM_MODEL` | Model for every key when `LLM_MODELS` is empty, default `gemini/gemini-2.5-flash-lite` |
| `DATABASE_URL` | SQLite location, e.g. `sqlite:////data/app.db` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins |
| `ENABLE_FAILURE_SIMULATION` | `true` enables the `X-Simulate-Failure` header |
| `DEFAULT_SYSTEM_PROMPT` | Used when a session has none |
| `LLM_TIMEOUT_SECONDS` | Per-key timeout before failing over, default 30 |
| `VITE_API_URL` | Frontend build-time backend URL |

## 3. Design decisions: key fallback, caching, SQLite session storage

### Key fallback

`backend/app/llm.py` walks the key pool **in order** and calls `litellm.acompletion(model=key_model, api_key=key, num_retries=0)` for each key. Each key carries its own model (`LLM_MODELS`), so the pool can span providers: keys on one account usually share a quota, but keys on two providers fail independently. `model` in the response is the model that actually answered. Any provider failure moves on to the next key: LiteLLM maps provider errors to typed exceptions (`RateLimitError` for 429 and quota, `InternalServerError`, `BadGatewayError`, `ServiceUnavailableError` for 5xx, plus timeouts and auth errors). Only when every key has failed does the API return `503 {"detail": "all providers unavailable"}`. `fallback_attempts` counts the keys that failed before the one that answered.

- **Why `num_retries=0`:** retrying a key that just returned 429 burns time against the same exhausted quota. Moving to the next key is the retry.
- **Why also fail over on 401 and timeouts:** a revoked or hanging key is as useless as a rate-limited one, and the user should still get an answer. This is a superset of the spec (429, quota, 5xx).
- **Why an explicit loop instead of LiteLLM's `Router`:** the Router's fallback relies on cooldowns, which are process-wide state. The spec requires simulated failures to affect *one request only* and to report exactly which key answered (`key_id`). An ordered loop is deterministic, about 30 lines long, and still uses LiteLLM for every call, every error mapping and the cache.
- **Failure simulation:** `X-Simulate-Failure: key_1=429` raises the *same LiteLLM exception class* a real 429 produces, inside the same `try` block, so the demo exercises the real failover path. It is honoured only when `ENABLE_FAILURE_SIMULATION=true`. A malformed header returns 422.
- **Request path in the response:** `metadata.attempts` (an extra field, allowed by the contract) lists each key that failed before the answer, e.g. `[{"key_id": "key_1", "status": 429, "error": "RateLimitError"}]`. The UI draws it as `key_1 ✕ 429 → key_2 ✓`. `/health` also lists key ids and models (never the keys).
- **Reasoning off on NVIDIA:** Nemotron thinks by default. I measured about 1,000 hidden tokens and up to 30 s per reply, which is enough to hit the per-key timeout and turn a failover into a 503. NVIDIA calls send `chat_template_kwargs.enable_thinking=false` (about 40 tokens, about 1 s). The dict is deep-copied per call because LiteLLM mutates `extra_body` in place.
- **Nothing is stored on failure:** the user message and the assistant reply are written in **one SQLite transaction**, only after the LLM succeeded. A 422 or 503 never leaves a half turn in history.

### Caching

LiteLLM's built-in cache (`litellm.cache = Cache(type="local")`, in memory) with `caching=True` on every call.

- **Cache key:** LiteLLM hashes the call parameters: model + the full `messages` list (system prompt + history + new message). The API key is *not* part of it, so a reply cached via `key_1` is served even when `key_1` is down.
- The same first message in a new session gives an identical message list, so it is an `LLM_CACHE` hit. A different message, a different system prompt or any history changes the key, so it gets `LIVE_INFERENCE`.
- **Hit detection:** LiteLLM sets `response._hidden_params["cache_hit"]`. On a hit the reply text and token usage are the stored ones, `key_id` is `null` and `fallback_attempts` is 0.
- **Simulated requests skip the cache *read*** (`cache={"no-cache": True}`, still written), so `key_1=429` always shows a real failover to `key_2`, even for a prompt that is already cached.
- **Trade-off:** an in-memory cache is per process and empty after a restart. For several replicas or restart survival, switch to `Cache(type="disk")` (one line). Redis is excluded by the brief.

### SQLite session storage

- `messages` table exactly as specified, plus an index on `(session_id, id)` and a small `sessions` table holding each session's system prompt. The schema is created on startup (`CREATE TABLE IF NOT EXISTS`).
- Plain stdlib `sqlite3`, one short-lived connection per operation: no ORM for three queries.
- History is read from SQLite on every request, so the client sends only the new message and a server restart loses nothing.
- `GET /sessions/{id}/messages` returns the history oldest first, without the system prompt, and returns 404 for an unknown session.
- **Tokens are per request:** `input_tokens`/`output_tokens` are the provider's `usage` for this one call (system + history + new message in, this reply out). Nothing is summed across turns.
- **Latency** is measured server-side with `time.perf_counter()` across the whole request (DB read, LLM, failover).

## 4. Verification: how to see failover, cache hits and per-message token usage

Set `B` to the backend URL (local: `http://localhost:8000`).

```bash
curl $B/health
# {"status":"ok","keys_configured":2,"cache_enabled":true}

# Live, then a cache hit from a NEW session with the same first message (faster, same reply, key_id null)
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-a","message":"What is the capital of France?"}'
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-b","message":"What is the capital of France?"}'

# Failover: key_1 fails, key_2 answers (key_id "key_2", fallback_attempts 1)
curl -s -X POST $B/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: key_1=429' -d '{"session_id":"s-c","message":"Name a river in Paris"}'

# Every key fails: 503, nothing added to history
curl -s -X POST $B/chat -H 'Content-Type: application/json' -H 'X-Simulate-Failure: *=429' -d '{"session_id":"s-d","message":"hi"}'
curl -s $B/sessions/s-d/messages          # {"detail":"session not found"}

# Multi-turn memory + stored history
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-a","message":"And what river runs through it?"}'
curl -s $B/sessions/s-a/messages

# 422
curl -s -X POST $B/chat -H 'Content-Type: application/json' -d '{"session_id":"s-a","message":"   "}'
```

**In the UI:**
- Every assistant reply shows `source`, `model`, `latency`, `in`/`out` tokens, a token bar, and the path the request took (`key_1 ✓`, `key_1 ✕ 429 → key_2 ✓` or `cache ✓`). `{ } inspect` shows the raw JSON.
- The **key-pool rail** (right edge, or a strip above the chat on narrow screens) lights up whatever answered the last request: the cache node amber on a hit, a failed key red with its status code, and the answering key green.
- The empty chat offers one-click starters: a normal question, *Simulate a Groq outage* (`key_1=429`), *Simulate a total outage* (`*=429`), and after **New chat**, *Ask again* with the previous first message, which should come back as a cache hit.
- Cache hits are labelled "replayed from cache in N ms" and compared with the average live latency on the page.
- *Session settings* (the gear icon) holds the system prompt and a failover selector that sends `X-Simulate-Failure` with every message.

**Automated:** `cd backend && python -m pytest -q` covers health, response shape, cache hit (identical text, same tokens, `key_id` null, faster), per-key models across providers, cache misses for different messages and system prompts, multi-turn history sent to the LLM, history surviving an app restart, per-request tokens, failover on simulated 429/500/502/503 and on real LiteLLM `RateLimitError`, 503 with nothing written, simulation off when disabled, 422 cases (missing, empty, whitespace, over 4000 chars, malformed JSON, bad header) and the 404.

## 5. Setup Used: your editor and AI tools

- Editor: `[fill in]`
- AI tools: Claude Code for scaffolding, tests and docs. I reviewed and directed the design decisions above.

## 6. Bonus features (if any)

- **Key-pool rail:** a live map of cache, then key_1, then key_2, showing which one answered each request. It makes failover and caching visible without reading JSON.
- **Per-reply request path** (`metadata.attempts`), **cache replay label** with a live-latency comparison, **per-request token bar**, **client-side stopwatch** while waiting, and a **raw JSON inspector**. Each one displays real data from the response; nothing is simulated in the UI.
- **One-click demo starters** for a normal question, a Groq outage, a total outage, and the same first message again to show a cache hit.
- **Failover test selector** in session settings (`X-Simulate-Failure` without curl), plus a health badge.
- **Per-session system prompt** (`system-prompt-input`), stored in SQLite so later turns keep it.
- **Failover also covers timeouts and invalid keys**, not just 429/5xx.
- **Per-key models (`LLM_MODELS`):** the pool can mix providers, so a full provider outage still fails over.
- **Optional live test** against the real provider (`LIVE_LLM_TESTS=1`).

### Known limitations

- The cache is in-memory: per process, cleared on restart (see the trade-off above).
- On Render's free plan the container disk is ephemeral, so the deployed SQLite file resets on redeploy or after idle spin-down. The Docker volume setup (`make up`) persists properly; a paid Render disk mounted at `/data` would fix the deployed instance with no code change. The free instance also sleeps after 15 idle minutes, so the first request can take about 50 s.
- The backend image is about 450 MB, mostly LiteLLM's own dependencies. It is a multi-stage build on `python:3.13-slim`.
