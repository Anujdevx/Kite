import json
import logging
import os
import time
from contextlib import asynccontextmanager
from typing import Annotated

import litellm
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, StringConstraints

from app import db, llm

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("app")

DEFAULT_SYSTEM_PROMPT = os.getenv("DEFAULT_SYSTEM_PROMPT", "You are a helpful, concise assistant.")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    db.init_db()  # schema is created on startup
    pool = llm.key_pool()  # fails fast if LLM_MODELS and LLM_API_KEYS don't line up
    log.info("keys configured: %s", [(key_id, m) for key_id, _, m in pool])
    yield


app = FastAPI(title="Kite chatbot", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:3000").split(",") if o.strip()],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Simulate-Failure"],
)


@app.exception_handler(Exception)
async def unhandled(_req: Request, exc: Exception):
    # Never leak a stack trace or an HTML error page.
    log.exception("unhandled error", exc_info=exc)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


class ChatRequest(BaseModel):
    session_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    message: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=4000)]
    system_prompt: Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)] | None = None


@app.get("/health")
def health():
    try:
        db.ping()
    except Exception:
        return JSONResponse(status_code=503, content={"status": "error", "detail": "database unreachable"})
    keys = len(llm.api_keys())
    if keys == 0:
        return JSONResponse(status_code=503, content={"status": "error", "detail": "no API keys configured"})
    return {"status": "ok", "keys_configured": keys, "cache_enabled": litellm.cache is not None}


@app.post("/chat")
async def chat(req: ChatRequest, x_simulate_failure: Annotated[str | None, Header()] = None):
    started = time.perf_counter()

    simulate = {}
    if x_simulate_failure and os.getenv("ENABLE_FAILURE_SIMULATION", "false").lower() == "true":
        try:
            simulate = llm.parse_simulation(x_simulate_failure)
        except ValueError:
            raise HTTPException(422, "invalid X-Simulate-Failure header, expected e.g. key_1=429,key_2=500")

    stored_prompt, history = db.get_session(req.session_id) or (None, [])
    system_prompt = req.system_prompt or stored_prompt or DEFAULT_SYSTEM_PROMPT
    messages = (
        [{"role": "system", "content": system_prompt}]
        + [{"role": m["role"], "content": m["content"]} for m in history]
        + [{"role": "user", "content": req.message}]
    )

    try:
        result = await llm.complete(messages, simulate)
    except llm.AllProvidersFailed:
        # Nothing is written to history for a failed request.
        raise HTTPException(503, "all providers unavailable")

    reply = result.pop("reply")
    metadata = {**result, "latency_ms": int((time.perf_counter() - started) * 1000)}
    db.save_turn(req.session_id, system_prompt, req.message, reply, metadata)
    return {"session_id": req.session_id, "reply": reply, "metadata": metadata}


@app.get("/sessions/{session_id}/messages")
def session_messages(session_id: str):
    stored = db.get_session(session_id)
    if stored is None:
        raise HTTPException(404, "session not found")
    out = []
    for m in stored[1]:
        item = {"role": m["role"], "content": m["content"]}
        if m["metadata"]:
            item["metadata"] = json.loads(m["metadata"])
        out.append(item)
    return {"session_id": session_id, "messages": out}
