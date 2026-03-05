"""
Kama Brain v4.0 - AI-Specific Prompt Engine

Transforms user vibes into world-class, AI-family-optimized prompts.
Each target AI (Claude, GPT, Gemini, Grok, Codex) gets tailored output.

Pipeline: Security Audit → Context Scan → AI-Specific Generation →
          Sanitization → Quality Scoring → Fingerprinting

Architecture: 100% LOCAL - llama-cpp-python (GGUF), no Ollama, no external APIs.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
import json
import queue
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager

import llm_backend
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator

from config import settings
from context_scanner import scan_workspace, ProjectContext
from hardware_profiler import profile_system, detect_hardware
from prompt_knowledge_base import (
    get_enhanced_system_prompt,
    get_relevant_patterns,
    build_pattern_context,
    PROMPT_PATTERNS,
    CATEGORY_ENHANCEMENTS,
)
from prompt_optimizer import (
    build_optimized_prompt,
    sanitize_generated_prompt,
    score_prompt_quality,
    get_language_security_rules,
    fingerprint_prompt,
)
from security_auditor import audit_vibe, Verdict

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
log = logging.getLogger("brain")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Modern lifespan handler - replaces deprecated on_event('startup')."""
    # Startup: auto-load or auto-download the default model
    await asyncio.to_thread(llm_backend.auto_load)
    yield
    # Shutdown: explicitly free the model before Python tears down modules
    log.info("Shutting down — releasing model…")
    await asyncio.to_thread(llm_backend.unload_model)


app = FastAPI(title="Kama Brain", version="4.0.0", lifespan=lifespan)

# ── Security: CORS restricted to localhost + VS Code extension origins ──
# Note: allow_origins expects exact strings or "*". Port-wildcards are not
# supported, so we rely on allow_origin_regex for flexible matching.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=r"^(https?://(127\.0\.0\.1|localhost)(:\d+)?|vscode-webview://.*)$",
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept"],
    allow_credentials=False,
)


# ── Security: Request body size limit (1 MB) ──
_MAX_BODY_BYTES = 1_048_576  # 1 MB


@app.middleware("http")
async def _limit_body_size(request: Request, call_next):
    """Reject requests with bodies larger than _MAX_BODY_BYTES."""
    cl = request.headers.get("content-length")
    if cl and int(cl) > _MAX_BODY_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Request body too large"})
    return await call_next(request)


# ── Security: Rate limiting (per-client, in-memory) ──

_rate_limits: dict[str, list[float]] = defaultdict(list)
_RATE_WINDOW = 60.0   # seconds
_RATE_MAX_VIBE = 30   # max vibe requests per window
_RATE_MAX_GENERAL = 120  # max general requests per window
_RATE_CLEANUP_INTERVAL = 300.0  # seconds between full cleanups
_rate_last_cleanup = 0.0


def _client_key(request: Request, prefix: str) -> str:
    """Build a per-client rate-limit key from client IP + endpoint prefix."""
    # X-Forwarded-For only relevant if behind a proxy - for localhost this is simply 127.0.0.1
    ip = request.client.host if request.client else "unknown"
    return f"{prefix}:{ip}"


def _check_rate(key: str, limit: int) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    global _rate_last_cleanup
    now = time.monotonic()

    # Periodic full cleanup to prevent memory leak from stale keys
    if now - _rate_last_cleanup > _RATE_CLEANUP_INTERVAL:
        stale = [k for k, v in _rate_limits.items() if not v or now - v[-1] > _RATE_WINDOW]
        for k in stale:
            del _rate_limits[k]
        _rate_last_cleanup = now

    bucket = _rate_limits[key]
    # Prune old entries
    _rate_limits[key] = [t for t in bucket if now - t < _RATE_WINDOW]
    if len(_rate_limits[key]) >= limit:
        return False
    _rate_limits[key].append(now)
    return True


# ── Agent guides (reinforcement lines for llama - injected after system prompt) ──

_GUIDES: dict[str, str] = {
    "claude": "TARGET: Claude. Write a clean natural-language prompt - no XML templates, no scaffolding.",
    "gpt": "TARGET: GPT. Write a clean natural-language prompt - no markdown headers, no template structure.",
    "gpt-codex": "TARGET: Codex. Write a clean technical spec in natural prose - no scaffolding.",
    "gemini": "TARGET: Gemini. Write a clean natural-language prompt - thorough but no tables or scaffolding.",
    "grok": "TARGET: Grok. Ultra-concise, under 300 words. No templates.",
    "o3": "TARGET: o3/o4. Encourage deep reasoning naturally. No template scaffolding.",
    "auto": "Write a clean, natural-language prompt for any AI. No templates, no scaffolding, no headers.",
}

# ── Task type → adaptive temperature map ─────────────────────────────
_TASK_TEMPS: list[tuple[list[str], float]] = [
    (["debug", "fix", "error", "bug", "crash", "trace","exception"], 0.05),
    (["refactor", "optimize", "improve", "clean"], 0.08),
    (["test", "unit test", "integration", "spec"], 0.07),
    (["explain", "document", "comment", "readme"], 0.15),
    (["design", "architecture", "plan", "structure"], 0.12),
    (["create", "build", "implement", "add", "generate"], 0.10),
]


def _adaptive_temperature(vibe: str) -> float:
    """Return an adaptive temperature based on task type detected in vibe."""
    low = vibe.lower()
    for keywords, temp in _TASK_TEMPS:
        if any(k in low for k in keywords):
            return temp
    return settings.KAMA_TEMPERATURE


def _adaptive_tokens(vibe: str) -> int:
    """Return adaptive token limit based on vibe length and complexity."""
    word_count = len(vibe.split())
    if word_count < 10:
        return min(settings.KAMA_MAX_TOKENS, 1024)
    if word_count < 30:
        return min(settings.KAMA_MAX_TOKENS, 1536)
    return min(settings.KAMA_MAX_TOKENS, 2048)

_FAMILY_NAMES: dict[str, str] = {
    "claude": "Claude (Anthropic)", "gpt": "GPT (OpenAI)", "gpt-codex": "GPT Codex (OpenAI)",
    "gemini": "Gemini (Google)", "grok": "Grok (xAI)",
    "o3": "OpenAI o3/o4 (Reasoning)", "auto": "Universal (Any Agent)",
}


# Allowed model name pattern: alphanumerics, hyphens, colons, dots (e.g. "gemma3:4b")
_MODEL_RE = re.compile(r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$')


def _validate_model_name(v: str) -> str:
    """Raise ValueError if the model name contains path-traversal or shell metacharacters."""
    if not _MODEL_RE.match(v):
        raise ValueError(f"Invalid model name: {v!r}")
    return v


def _safe_workspace(raw: str) -> str:
    """Resolve and whitelist-check a workspace path. Returns empty string if unsafe."""
    if not raw:
        return ""
    from pathlib import Path
    # Block UNC paths and Windows extended-length prefix
    stripped = raw.strip()
    if stripped.startswith("\\\\?\\") or stripped.startswith("\\\\.\\"):
        return ""
    if stripped.startswith("\\\\") and not stripped[2:].startswith("?"):
        return ""  # UNC network paths
    try:
        p = Path(raw).resolve()
    except Exception:
        return ""
    # Must be a real directory
    if not p.is_dir():
        return ""
    # Block absolute system paths — case-insensitive on Windows
    blocked = {"/etc", "/proc", "/sys", "/dev", "/root", "/var",
               "c:\\windows", "c:\\system32", "c:\\program files",
               "c:\\program files (x86)", "c:\\programdata"}
    s = str(p)
    s_cmp = s.lower() if os.name == "nt" else s
    if any(s_cmp.startswith(b) for b in blocked):
        return ""
    # Block paths containing null bytes or shell metacharacters
    if any(c in s for c in ('\x00', '&', ';', '|', '`', '$', '(', ')')):
        return ""
    return s


class VibeRequest(BaseModel):
    vibe: str = Field(..., min_length=1, max_length=16384)
    workspace_path: str = Field("", max_length=4096)
    agent: str = Field("auto", max_length=64)
    chain_context: str = Field("", max_length=32768)
    active_file: str = Field("", max_length=65536)
    active_file_name: str = Field("", max_length=512)
    active_file_language: str = Field("", max_length=64)

    @field_validator('agent')
    @classmethod
    def validate_agent(cls, v: str) -> str:
        allowed = set(_GUIDES.keys()) | {'auto'}
        normalized = v.lower().strip()
        return normalized if normalized in allowed else 'auto'


class PromptResponse(BaseModel):
    prompt: str
    context_summary: str = ""
    model_used: str = ""
    generation_time_ms: int = 0
    agent_used: str = ""
    quality_score: float = 0.0
    quality_grade: str = ""
    security_verdict: str = "PASS"
    prompt_fingerprint: str = ""


# ── Endpoints ─────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    model_id = llm_backend.current_model() or settings.KAMA_MODEL
    llama_ok = llm_backend._llama_cpp_available()
    s = llm_backend.setup_state()
    if s["active"]:
        return {
            "status": "setup",
            "model": model_id,
            "version": "4.0.0",
            "llama_available": llama_ok,
            "setup_status": s["status"],
            "setup_pct": s["pct"],
            "setup_model": s["model_id"],
        }
    if s["status"] == "error" and not llm_backend.is_loaded():
        return {
            "status": "setup_error",
            "model": model_id,
            "version": "4.0.0",
            "llama_available": llama_ok,
            "error": s["error"],
        }
    if not llama_ok:
        return {
            "status": "ok",
            "model": "template",
            "version": "4.0.0",
            "llama_available": False,
        }
    return {"status": "ok", "model": model_id, "version": "4.0.0", "llama_available": llama_ok}


@app.get("/hardware")
async def hardware_profile(request: Request):
    """Detect PC hardware and recommend the best local AI model."""
    if not _check_rate(_client_key(request, "hardware"), _RATE_MAX_GENERAL):
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
    try:
        installed: list[str] = [e["id"] for e in llm_backend.get_installed()]
        profile = await asyncio.to_thread(profile_system, installed)
        hw = profile.hardware
        return {
            "hardware": {
                "os": f"{hw.os_name} {hw.os_version}",
                "cpu": hw.cpu_name,
                "cpu_cores": hw.cpu_cores,
                "cpu_physical": hw.cpu_physical,
                "ram_gb": hw.ram_gb,
                "gpu": hw.gpu_name,
                "vram_gb": hw.vram_gb,
                "has_cuda": hw.has_cuda,
                "has_metal": hw.has_metal,
            },
            "recommendations": [
                {
                    "name": r.name,
                    "reason": r.reason,
                    "tier": r.tier,
                    "quality_tier": r.quality_tier,
                    "speed_tier": r.speed_tier,
                    "ram_required": r.ram_required,
                    "already_installed": r.already_installed,
                }
                for r in profile.recommendations
            ],
            "warning": profile.warning,
            "summary": profile.summary,
        }
    except Exception as e:
        log.error("Hardware profile error: %s", e)
        return JSONResponse(status_code=500, content={"detail": "Hardware detection failed"})


@app.get("/agents")
async def list_agents():
    return {"agents": [{"id": k, "name": v} for k, v in _FAMILY_NAMES.items()]}


class ContextRequest(BaseModel):
    workspace_path: str = Field("", max_length=4096)


@app.post("/context")
async def scan_context_endpoint(req: ContextRequest, request: Request):
    """Scan workspace and return detected languages/tech stack for the UI."""
    if not _check_rate(_client_key(request, "context"), _RATE_MAX_GENERAL):
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
    safe_ws = _safe_workspace(req.workspace_path)
    if not safe_ws:
        return {"languages": [], "tech_stack": "", "manifest": ""}
    try:
        ctx = await asyncio.to_thread(scan_workspace, safe_ws)
        return {
            "languages": ctx.languages_detected,
            "tech_stack": _ctx(ctx),
            "manifest": ctx.manifest_name or "",
        }
    except Exception as e:
        log.error("Context scan error: %s", e)
        return {"languages": [], "tech_stack": "", "manifest": ""}


@app.get("/knowledge-base")
async def knowledge_base(request: Request):
    """Expose analyzed prompt patterns from prompts.chat community."""
    if not _check_rate(_client_key(request, "kb"), _RATE_MAX_GENERAL):
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
    return {
        "total_patterns": len(PROMPT_PATTERNS),
        "categories": list(CATEGORY_ENHANCEMENTS.keys()),
        "patterns": [
            {
                "name": p.name,
                "category": p.category,
                "role": p.role,
                "capabilities_count": len(p.capabilities),
                "tags": p.tags,
            }
            for p in PROMPT_PATTERNS
        ],
    }


@app.get("/knowledge-base/{category}")
async def knowledge_base_category(category: str, request: Request):
    """Get patterns and enhancement rules for a specific category."""
    if not _check_rate(_client_key(request, "kb"), _RATE_MAX_GENERAL):
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})
    patterns = [p for p in PROMPT_PATTERNS if p.category == category or category in p.tags]
    enhancements = CATEGORY_ENHANCEMENTS.get(category, {})
    return {
        "category": category,
        "patterns": [
            {
                "name": p.name,
                "role": p.role,
                "task_template": p.task_template,
                "capabilities": p.capabilities,
                "rules": p.rules,
                "output_format": p.output_format,
            }
            for p in patterns
        ],
        "enhancements": enhancements,
    }


class ScoreRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=32768)


class ScoreResponse(BaseModel):
    total_score: float
    grade: str
    dimensions: dict
    fingerprint: str


@app.post("/prompt/score", response_model=ScoreResponse)
async def score_prompt_endpoint(req: ScoreRequest):
    """Score any prompt for quality and return detailed dimensions."""
    q = score_prompt_quality(req.prompt)
    fp = fingerprint_prompt(req.prompt)
    return ScoreResponse(
        total_score=q.total_score,
        grade=q.grade,
        dimensions={
            "role_clarity": q.role_score,
            "task_clarity": q.task_clarity_score,
            "structure": q.structure_score,
            "security": q.security_score,
            "actionability": q.actionability_score,
        },
        fingerprint=fp,
    )


class OptimizeRequest(BaseModel):
    vibe: str = Field(..., min_length=1, max_length=16384)
    family: str = Field("auto")
    tech_stack: str = Field("")
    language: str = Field("")


class OptimizeResponse(BaseModel):
    prompt: str
    family: str
    quality_score: float
    quality_grade: str
    fingerprint: str
    sanitized_issues: list[str]


@app.post("/prompt/optimize", response_model=OptimizeResponse)
async def optimize_prompt_endpoint(req: OptimizeRequest, request: Request):
    """Generate an optimized prompt for a specific AI family without LLM."""
    if not _check_rate(_client_key(request, "optimize"), _RATE_MAX_GENERAL):
        return JSONResponse(status_code=429, content={"detail": "Rate limit exceeded"})

    # Security check first
    audit = audit_vibe(req.vibe)
    if audit.verdict == Verdict.FAIL:
        return JSONResponse(status_code=400, content={"detail": f"Security issue: {audit.summary()}"})
    lang_rules = get_language_security_rules(req.language) if req.language else []
    extra = "\n".join(f"- {r}" for r in lang_rules) if lang_rules else ""
    prompt = build_optimized_prompt(
        vibe=req.vibe, family=req.family, tech_stack=req.tech_stack,
        language_hint=req.language, extra_rules=extra,
    )
    prompt, issues = sanitize_generated_prompt(prompt)
    quality = score_prompt_quality(prompt)
    fp = fingerprint_prompt(prompt)

    return OptimizeResponse(
        prompt=prompt,
        family=req.family,
        quality_score=quality.total_score,
        quality_grade=quality.grade,
        fingerprint=fp,
        sanitized_issues=issues,
    )


@app.get("/models")
async def list_models():
    installed = llm_backend.get_installed()
    models = [{"id": m["id"], "name": m["name"], "size_mb": m.get("size_mb", 0)} for m in installed]
    return {"models": models, "current": llm_backend.current_model() or settings.KAMA_MODEL}


@app.get("/models/available")
async def available_models():
    return {"catalog": llm_backend.get_catalog()}


class PullModelRequest(BaseModel):
    model: str = Field(..., min_length=1, max_length=256)

    @field_validator('model')
    @classmethod
    def validate_model(cls, v: str) -> str:
        # For GGUF catalog IDs the _MODEL_RE pattern still covers alphanumerics + hyphens
        if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$', v):
            raise ValueError(f"Invalid model id: {v!r}")
        return v


@app.post("/models/pull")
async def pull_model(req: PullModelRequest):
    """Download a GGUF model with SSE progress events."""
    model_id = req.model
    log.info("Downloading GGUF model: %s", model_id)

    q_: queue.Queue = queue.Queue()

    def _download_sync():
        def _progress(pct: int, status: str):
            q_.put({"status": status, "pct": pct})

        ok = llm_backend.download_model(model_id, _progress)
        if ok:
            q_.put({"status": "done", "pct": 100})
        else:
            q_.put({"status": "error", "pct": 0})
        q_.put(None)  # sentinel

    async def _stream():
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, _download_sync)
        while True:
            try:
                item = await asyncio.to_thread(q_.get, timeout=600)
            except Exception:
                yield f"data: {json.dumps({'status': 'error', 'message': 'Download timeout'})}\n\n"
                break
            if item is None:
                break
            yield f"data: {json.dumps(item)}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


class SetModelRequest(BaseModel):
    model: str = Field(..., min_length=1, max_length=256)

    @field_validator('model')
    @classmethod
    def validate_model(cls, v: str) -> str:
        return _validate_model_name(v)


@app.post("/model")
async def set_model(req: SetModelRequest):
    model_id = req.model
    log.info("Switching model to: %s", model_id)
    ok = await asyncio.to_thread(llm_backend.load_model, model_id)
    if not ok:
        return JSONResponse(status_code=400, content={"detail": f"Model '{model_id}' not available. Download it first."})
    settings.KAMA_MODEL = model_id
    return {"status": "ok", "model": model_id}


@app.post("/vibe/stream")
async def vibe_stream(req: VibeRequest, request: Request):
    """Stream prompt generation via SSE - delivers tokens as they arrive."""
    request_id = uuid.uuid4().hex[:8]
    SEP = "\n\n"

    if not _check_rate(_client_key(request, "vibe"), _RATE_MAX_VIBE):
        async def _rate_limited():
            yield "data: " + json.dumps({"type": "error", "message": "Rate limit exceeded"}) + SEP
        return StreamingResponse(_rate_limited(), media_type="text/event-stream")

    family = req.agent.lower().strip() if req.agent else "auto"
    if family not in _GUIDES:
        family = "auto"

    audit = audit_vibe(req.vibe)
    if audit.verdict == Verdict.FAIL:
        async def _sec_fail():
            yield "data: " + json.dumps({"type": "error", "message": audit.summary()}) + SEP
        return StreamingResponse(_sec_fail(), media_type="text/event-stream")

    ctx_hint = ""
    safe_ws = _safe_workspace(req.workspace_path)
    if safe_ws:
        ctx = await asyncio.to_thread(scan_workspace, safe_ws)
        ctx_hint = _ctx(ctx)

    async def _stream_gen():
        t0 = time.monotonic()
        user_msg = req.vibe.strip()

        # Add tech stack context to system prompt if detected
        tech_context = ""
        if ctx_hint:
            tech_context = f"\nDetected project tech stack: {ctx_hint}.\nMention these technologies in the context/tech-stack section of the prompt, but focus the prompt on what the user is ASKING for."

        patterns = get_relevant_patterns(req.vibe)
        pattern_ctx = build_pattern_context(patterns)
        if pattern_ctx:
            user_msg += f"\n{pattern_ctx}"

        # Chain context - previous prompt in a multi-step workflow
        if req.chain_context:
            user_msg += f"\n\nPREVIOUS PROMPT IN THIS CHAIN (build upon it, extend or refine - do NOT repeat it verbatim):\n{req.chain_context[:8000]}"

        # Active file context - code from the user's currently open editor
        if req.active_file:
            fname = req.active_file_name or "untitled"
            flang = req.active_file_language or ""
            snippet = req.active_file[:12000]
            user_msg += f"\n\nUSER'S CURRENTLY OPEN FILE ({fname}, {flang}):\n```{flang}\n{snippet}\n```\nIncorporate awareness of this code into the prompt when relevant."

        system = get_enhanced_system_prompt(category_hint=req.vibe, family=family)
        agent_line = _GUIDES.get(family, _GUIDES["auto"])
        system += "\n" + agent_line
        if tech_context:
            system += "\n" + tech_context

        temp = _adaptive_temperature(req.vibe)
        max_tokens = _adaptive_tokens(req.vibe)

        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user_msg},
        ]

        full_text = ""
        used_fallback = False
        try:
            if not llm_backend.is_loaded():
                raise RuntimeError("No model loaded")

            # Stream tokens asynchronously - run generator in thread pool
            token_q: queue.Queue = queue.Queue()

            def _run_stream():
                try:
                    for tok in llm_backend.generate_stream(messages, max_tokens, temp):
                        token_q.put(tok)
                except Exception as ex:
                    token_q.put(ex)
                finally:
                    token_q.put(None)

            loop = asyncio.get_running_loop()
            fut = loop.run_in_executor(None, _run_stream)

            while True:
                tok = await asyncio.to_thread(token_q.get)
                if tok is None:
                    break
                if isinstance(tok, Exception):
                    raise tok
                full_text += tok
                yield "data: " + json.dumps({"type": "token", "text": tok}) + SEP
                await asyncio.sleep(0)

            await fut
        except Exception as e:
            log.error("[%s] Stream error: %s", request_id, e)
            full_text = _fallback(req.vibe, ctx_hint, family)
            used_fallback = True

        full_text = _clean(full_text)
        full_text, _ = sanitize_generated_prompt(full_text)
        quality = score_prompt_quality(full_text)
        # Only fall back to template for truly degenerate output (empty/gibberish)
        if quality.total_score < 5 and len(full_text.strip()) < 10:
            full_text = build_optimized_prompt(vibe=req.vibe, family=family, tech_stack=ctx_hint)
            quality = score_prompt_quality(full_text)
            used_fallback = True

        fp = fingerprint_prompt(full_text)
        ms = int((time.monotonic() - t0) * 1000)
        done_payload = {
            "type": "fallback" if used_fallback else "done",
            "prompt": full_text,
            "ms": ms,
            "model": llm_backend.current_model(),
            "agent": family,
            "quality": quality.total_score,
            "grade": quality.grade,
            "security": audit.verdict.value,
            "fingerprint": fp,
        }
        yield "data: " + json.dumps(done_payload) + SEP
        log.info("[%s] Stream done %d chars / %dms / family=%s", request_id, len(full_text), ms, family)

    return StreamingResponse(_stream_gen(), media_type="text/event-stream")


@app.post("/vibe", response_model=PromptResponse)
async def vibe(req: VibeRequest, request: Request) -> PromptResponse:
    request_id = uuid.uuid4().hex[:8]

    if not _check_rate(_client_key(request, "vibe"), _RATE_MAX_VIBE):
        return PromptResponse(
            prompt="⚠️ Rate limit exceeded. Please wait a moment before trying again.",
            security_verdict="WARN",
            model_used=llm_backend.current_model(),
        )

    family = req.agent.lower().strip() if req.agent else "auto"
    if family not in _GUIDES:
        family = "auto"

    log.info("[%s] Vibe [%s]: %s", request_id, family, req.vibe[:100])
    t0 = time.monotonic()

    # ── 1. Security audit on raw vibe input ──────────────────────────
    audit = audit_vibe(req.vibe)
    if audit.verdict == Verdict.FAIL:
        log.warning("Security FAIL: %s", audit.summary())
        return PromptResponse(
            prompt=f"⚠️ Security issue detected:\n{audit.summary()}\n\nPlease rephrase your request.",
            security_verdict="FAIL",
            model_used=llm_backend.current_model(),
            generation_time_ms=0,
            agent_used=family,
        )

    # ── 2. Scan workspace context ────────────────────────────────────
    ctx_hint = ""
    safe_ws = _safe_workspace(req.workspace_path)
    if safe_ws:
        ctx = await asyncio.to_thread(scan_workspace, safe_ws)
        ctx_hint = _ctx(ctx)
    elif req.workspace_path:
        log.warning("[%s] Rejected workspace path: %s", request_id, req.workspace_path[:100])

    # ── 3. Generate prompt (AI-specific) ─────────────────────────────
    prompt = await _gen(req.vibe, ctx_hint, family)

    # ── 4. Sanitize generated prompt ─────────────────────────────────
    prompt, sanitize_issues = sanitize_generated_prompt(prompt)
    if sanitize_issues:
        log.warning("Sanitized %d issues in generated prompt", len(sanitize_issues))

    # ── 5. Quality score ─────────────────────────────────────────────
    quality = score_prompt_quality(prompt)

    # If quality is too low and model generated something, use optimized fallback
    if quality.total_score < 20 and len(prompt) > 20:
        log.warning("Quality too low (%.0f), upgrading with optimizer", quality.total_score)
        lang_hint = ctx_hint.split("/")[0].strip() if ctx_hint else ""
        prompt = build_optimized_prompt(
            vibe=req.vibe, family=family,
            tech_stack=ctx_hint,
            language_hint=lang_hint,
        )
        quality = score_prompt_quality(prompt)

    # ── 6. Fingerprint for traceability ──────────────────────────────
    fp = fingerprint_prompt(prompt)

    ms = int((time.monotonic() - t0) * 1000)
    log.info(
        "[%s] Done %d chars / %dms / family=%s / quality=%s (%.0f) / fp=%s",
        request_id, len(prompt), ms, family, quality.grade, quality.total_score, fp,
    )

    return PromptResponse(
        prompt=prompt,
        context_summary=ctx_hint,
        model_used=llm_backend.current_model(),
        generation_time_ms=ms,
        agent_used=family,
        quality_score=quality.total_score,
        quality_grade=quality.grade,
        security_verdict=audit.verdict.value,
        prompt_fingerprint=fp,
    )


# ── Prompt generation (AI-Specific + Knowledge Base + Security) ───────
# DESIGN: Each AI family gets its own optimized system prompt.
# Knowledge base provides category-aware patterns.
# Security layer sanitizes both input AND output.
# Quality scorer ensures minimum quality threshold.


async def _gen(vibe: str, ctx_hint: str, family: str) -> str:
    """Generate AI-optimized prompt. Each family gets tailored instructions."""
    user_msg = vibe.strip()

    # Add tech stack context to system prompt if detected
    tech_context = ""
    if ctx_hint:
        tech_context = f"\nDetected project tech stack: {ctx_hint}.\nMention these technologies in the context/tech-stack section of the prompt, but focus the prompt on what the user is ASKING for."

    # Find relevant patterns from knowledge base
    patterns = get_relevant_patterns(vibe)
    pattern_ctx = build_pattern_context(patterns)
    if pattern_ctx:
        user_msg += f"\n{pattern_ctx}"

    # Build AI-SPECIFIC system prompt (different for each target AI)
    system = get_enhanced_system_prompt(category_hint=vibe, family=family)
    agent_line = _GUIDES.get(family, _GUIDES["auto"])
    system += "\n" + agent_line
    if tech_context:
        system += "\n" + tech_context

    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_msg},
    ]

    try:
        if not llm_backend.is_loaded():
            log.warning("No model loaded, using optimized fallback")
            return _fallback(vibe, ctx_hint, family)

        temp = _adaptive_temperature(vibe)
        max_tokens = _adaptive_tokens(vibe)
        raw = await asyncio.to_thread(
            llm_backend.generate,
            messages,
            max_tokens,
            temp,
        )

        cleaned = _clean(raw.strip())

        if _is_bad(cleaned):
            log.warning("Bad output detected, using fallback")
            return _fallback(vibe, ctx_hint, family)

        if len(cleaned) < 40:
            log.warning("Output too short (%d chars), using fallback", len(cleaned))
            return _fallback(vibe, ctx_hint, family)

        return cleaned

    except Exception as e:
        log.error("LLM error: %s", e)
        return _fallback(vibe, ctx_hint, family)


def _clean(text: str) -> str:
    """Strip fences, preambles, trailing artifacts, cursor blocks."""
    text = re.sub(r"```[\w]*\n?", "", text).strip()
    text = re.sub(
        r"^(Here is|Here's|Below is|The following|Sure|Okay|Of course|Certainly|I'll)[^\n]*\n+",
        "", text, flags=re.IGNORECASE
    ).strip()
    text = re.sub(r"\n*(END EXAMPLE|END|---)\s*$", "", text).strip()
    # Strip llama-cpp cursor block characters and other Unicode artifacts
    text = re.sub(r"[\u2580-\u259F]+\s*$", "", text).strip()
    text = text.rstrip("\u258c\u2588\u2592\u2591\u2593")
    return text


def _is_bad(text: str) -> bool:
    """Detect conversational or code output - trigger fallback."""
    low = text.lower()

    # Model acting as assistant instead of prompt engineer
    bad_phrases = [
        "how can i help", "please provide", "what programming language",
        "what would you like", "i'd be happy", "i can help", "let me know",
        "could you please", "tell me more", "what specific", "please share",
        "i need more", "can you provide", "what is the purpose",
        "are there any specific", "i'll help you",
    ]
    if any(p in low for p in bad_phrases):
        return True

    # Code instead of prompt (2+ code markers in first 200 chars)
    code_marks = [
        "import ", "from ", "def ", "class ", "function ", "const ", "let ",
        "return ", "export ", "<!doctype", "<html", "console.log(",
    ]
    head = low[:200]
    if sum(1 for m in code_marks if m in head) >= 2:
        return True

    return False


def _fallback(vibe: str, ctx_hint: str, family: str) -> str:
    """AI-optimized deterministic prompt when model fails or is too slow.

    Uses build_optimized_prompt() from prompt_optimizer to produce
    world-class, AI-family-specific prompts even without the LLM.
    """
    # Extract language from ctx_hint (format: "python / FastAPI")
    lang_hint = ctx_hint.split("/")[0].strip() if ctx_hint else ""
    lang_rules = get_language_security_rules(lang_hint) if lang_hint else []
    extra = "\n".join(f"- {r}" for r in lang_rules) if lang_rules else ""

    return build_optimized_prompt(
        vibe=vibe,
        family=family,
        tech_stack=ctx_hint,
        language_hint=lang_hint,
        extra_rules=extra,
    )


# ── Context detection ─────────────────────────────────────────────────

_MARKERS: dict[str, str] = {
    "next.config.js": "Next.js", "next.config.ts": "Next.js",
    "nuxt.config.ts": "Nuxt", "angular.json": "Angular",
    "svelte.config.js": "SvelteKit", "astro.config.mjs": "Astro",
    "vite.config.ts": "Vite", "vite.config.js": "Vite",
    "tailwind.config.js": "Tailwind", "manage.py": "Django",
    "app.py": "Flask/FastAPI", "pubspec.yaml": "Flutter",
    "Cargo.toml": "Rust", "go.mod": "Go", "CMakeLists.txt": "C/C++",
    "Dockerfile": "Docker", "Gemfile": "Ruby", "composer.json": "PHP",
    "pom.xml": "Java", "build.gradle.kts": "Kotlin",
    "tsconfig.json": "TypeScript", "package.json": "Node.js",
}


def _ctx(c: ProjectContext) -> str:
    parts: list[str] = []
    if c.language_hint:
        parts.append(c.language_hint)
    files = set(c.file_tree or [])
    for marker, name in _MARKERS.items():
        if marker in files and name not in parts:
            parts.append(name)
            break
    # Append detected languages not already represented
    for lang in (c.languages_detected or []):
        if len(parts) >= 5:
            break
        if lang.lower() not in " ".join(parts).lower():
            parts.append(lang)
    return " / ".join(parts[:5]) if parts else ""


if __name__ == "__main__":
    import sys
    import socket
    import uvicorn

    # ── Windows: use SelectorEventLoop for reliable signal handling ──
    # ProactorEventLoop (default on Windows) doesn't support
    # add_signal_handler(), which can cause uvicorn to miss shutdown
    # signals or exit immediately after startup.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    # ── Dependency self-check: fail fast with clear message ──────────
    _missing = []
    for _mod in ("fastapi", "uvicorn", "pydantic", "starlette", "psutil", "dotenv"):
        try:
            __import__(_mod)
        except ImportError:
            _missing.append(_mod)
    if _missing:
        log.error("Missing dependencies: %s", ", ".join(_missing))
        log.error("Run: pip install -r requirements.txt")
        sys.exit(1)

    # llama_cpp is optional — Brain starts without it, model load will fail gracefully
    try:
        __import__("llama_cpp")
    except ImportError:
        log.warning(
            "llama-cpp-python not installed — model loading disabled. "
            "Install: pip install --prefer-binary "
            "--extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu "
            "llama-cpp-python==0.3.2"
        )

    use_reload = "--reload" in sys.argv
    port = settings.PORT

    # Try to kill whatever holds the port, then try binding
    def _port_free(p: int) -> bool:
        """Check if a port is free by trying to BIND to it.

        On Windows, socket.close() after a failed connect() can hang
        indefinitely. Using bind() avoids that entirely.
        We do NOT set SO_REUSEADDR so bind correctly fails if something
        is already listening on the port.
        """
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((settings.HOST, p))
            return True    # bind succeeded → port is free
        except OSError:
            return False   # bind failed → port is busy
        finally:
            try:
                s.close()
            except OSError:
                pass

    if not _port_free(port):
        # Try to gracefully shut down the old server by hitting its health endpoint
        log.info("Port %d busy — attempting to reach existing brain…", port)
        try:
            import urllib.request
            urllib.request.urlopen(f"http://{settings.HOST}:{port}/health", timeout=2)
        except Exception:
            pass
        # Wait for the old process to release the port (Windows needs extra time)
        import time as _time
        for _ in range(20):            # up to 10 s
            _time.sleep(0.5)
            if _port_free(port):
                break
        # If still occupied, try alternate port
        if not _port_free(port):
            for alt in range(port + 1, port + 10):
                if _port_free(alt):
                    log.warning("Port %d busy, using %d instead", port, alt)
                    port = alt
                    break

    log.info("Brain v4.0 | %s | :%d | reload=%s", settings.KAMA_MODEL, port, use_reload)
    try:
        # When reload is disabled, pass the app object directly.
        # This avoids re-importing the module and ensures the
        # WindowsSelectorEventLoopPolicy is respected on Windows.
        # String import format is only needed for --reload mode.
        app_target = "sslm_engine:app" if use_reload else app
        uvicorn.run(
            app_target,
            host=settings.HOST,
            port=port,
            reload=use_reload,
            timeout_keep_alive=30,
            loop="asyncio",
        )
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except SystemExit:
        pass
    finally:
        # Ensure model is freed before Python tears down modules
        llm_backend.unload_model()
        log.info("Brain shut down gracefully.")
