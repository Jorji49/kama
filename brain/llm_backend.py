"""
Kama LLM Backend - llama-cpp-python direct inference

Replaces Ollama entirely. GGUF models live in ~/.kama/models/.
All agent guides / system prompts are injected at call-time - no external server needed.
"""

from __future__ import annotations

import atexit
import logging
import os
import threading
import urllib.request
from pathlib import Path
from typing import Generator

log = logging.getLogger("llm_backend")

# ── Storage directory ─────────────────────────────────────────────────
MODELS_DIR = Path.home() / ".kama" / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# ── Curated GGUF catalog - CPU-optimised Q4_K_M quantisation ─────────
GGUF_CATALOG: list[dict] = [
    {
        "id": "llama3.2-3b",
        "name": "Llama 3.2 3B",
        "file": "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
        "url": (
            "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF"
            "/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf"
        ),
        "size": "2.0 GB",
        "desc": "⭐ Best Pick - Fast, sharp, low RAM. Ideal for CPU.",
        "tier": "recommended",
    },
    {
        "id": "phi3.5-mini",
        "name": "Phi-3.5 Mini Instruct",
        "file": "Phi-3.5-mini-instruct-Q4_K_M.gguf",
        "url": (
            "https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF"
            "/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf"
        ),
        "size": "2.4 GB",
        "desc": "🧠 Microsoft 3.8B. Excellent structured prompt generation.",
        "tier": "quality",
    },
    {
        "id": "llama3.2-1b",
        "name": "Llama 3.2 1B",
        "file": "Llama-3.2-1B-Instruct-Q8_0.gguf",
        "url": (
            "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF"
            "/resolve/main/Llama-3.2-1B-Instruct-Q8_0.gguf"
        ),
        "size": "1.3 GB",
        "desc": "⚡ Ultra-fast 1B. Minimal RAM. Instant responses.",
        "tier": "fast",
    },
    {
        "id": "gemma2-2b",
        "name": "Gemma 2 2B",
        "file": "gemma-2-2b-it-Q4_K_M.gguf",
        "url": (
            "https://huggingface.co/bartowski/gemma-2-2b-it-GGUF"
            "/resolve/main/gemma-2-2b-it-Q4_K_M.gguf"
        ),
        "size": "1.6 GB",
        "desc": "🔷 Google 2B. Great speed/quality balance.",
        "tier": "fast",
    },
]

# ── Runtime state ─────────────────────────────────────────────────────
_llm = None
_current_model_id: str = ""
_load_lock = threading.Lock()

# Setup/download progress - polled by /health
_setup: dict = {
    "active": False,   # True while downloading
    "pct": 0,
    "model_id": "",
    "status": "",      # "downloading" | "loading" | "done" | "error"
    "error": "",
}


def setup_state() -> dict:
    """Return a snapshot of the current setup state."""
    return dict(_setup)


# ── Catalog helpers ───────────────────────────────────────────────────

def get_catalog() -> list[dict]:
    """Return catalog with live installed status and file size."""
    results = []
    for entry in GGUF_CATALOG:
        f = MODELS_DIR / entry["file"]
        size_mb = round(f.stat().st_size / 1_048_576) if f.exists() else 0
        results.append({**entry, "installed": f.exists(), "size_mb": size_mb})
    return results


def get_installed() -> list[dict]:
    return [m for m in get_catalog() if m["installed"]]


def get_entry(model_id: str) -> dict | None:
    for e in GGUF_CATALOG:
        if e["id"] == model_id:
            return e
    return None


def model_file_path(model_id: str) -> Path | None:
    entry = get_entry(model_id)
    if not entry:
        return None
    p = MODELS_DIR / entry["file"]
    return p if p.exists() else None


def is_loaded() -> bool:
    return _llm is not None


def current_model() -> str:
    return _current_model_id


def any_model_available() -> str | None:
    """Return the id of any already-downloaded model, or None."""
    for e in GGUF_CATALOG:
        if (MODELS_DIR / e["file"]).exists():
            return e["id"]
    return None


# ── Model loading ─────────────────────────────────────────────────────

def unload_model() -> None:
    """Explicitly free the loaded model to avoid destructor issues at shutdown."""
    global _llm, _current_model_id
    with _load_lock:
        if _llm is not None:
            try:
                _llm.close()
            except Exception:
                pass
            _llm = None
            _current_model_id = ""
            log.info("Model unloaded.")


atexit.register(unload_model)


def load_model(model_id: str) -> bool:
    """
    Load a GGUF model into memory. Thread-safe.
    Returns True on success, False on failure.
    """
    global _llm, _current_model_id
    with _load_lock:
        try:
            from llama_cpp import Llama  # deferred - optional install

            p = model_file_path(model_id)
            if not p:
                log.error("Model file not found for '%s'", model_id)
                return False

            if _current_model_id == model_id and _llm is not None:
                return True  # already loaded

            # Unload previous model before loading new one
            if _llm is not None:
                try:
                    _llm.close()
                except Exception:
                    pass
            _llm = None
            _current_model_id = ""

            n_threads = max(1, (os.cpu_count() or 4) - 1)
            log.info("Loading '%s' (%s threads) …", model_id, n_threads)

            _llm = Llama(
                model_path=str(p),
                n_ctx=4096,
                n_threads=n_threads,
                n_gpu_layers=0,   # CPU-only
                verbose=False,
            )
            _current_model_id = model_id
            log.info("Model '%s' ready.", model_id)
            return True

        except Exception as exc:
            log.error("Failed to load '%s': %s", model_id, exc)
            _llm = None
            _current_model_id = ""
            return False


def auto_load() -> bool:
    """
    Called at startup - load the first available downloaded model.
    If no model is downloaded, automatically downloads llama3.2-1b in a
    background thread (non-blocking). Returns True only if a model was
    immediately loaded from disk.
    """
    mid = any_model_available()
    if mid:
        log.info("Auto-loading model '%s' …", mid)
        return load_model(mid)

    # No model on disk - kick off background auto-download of the smallest model
    default = "llama3.2-1b"
    log.info("First run: auto-downloading model '%s' in background …", default)
    t = threading.Thread(target=_auto_download_and_load, args=(default,), daemon=True)
    t.start()
    return False


def _auto_download_and_load(model_id: str) -> None:
    """Background thread: download then load a model, updating _setup state."""
    global _setup
    _setup["active"] = True
    _setup["model_id"] = model_id
    _setup["status"] = "downloading"
    _setup["pct"] = 0
    _setup["error"] = ""

    def _progress(pct: int, status: str) -> None:
        _setup["pct"] = pct
        _setup["status"] = status

    ok = download_model(model_id, _progress)
    if not ok:
        _setup["status"] = "error"
        _setup["error"] = f"Failed to download '{model_id}'"
        _setup["active"] = False
        log.error("Auto-download failed for '%s'", model_id)
        return

    _setup["status"] = "loading"
    _setup["pct"] = 100
    loaded = load_model(model_id)
    if loaded:
        _setup["status"] = "done"
        _setup["active"] = False
        log.info("Auto-setup complete: model '%s' ready.", model_id)
    else:
        _setup["status"] = "error"
        _setup["error"] = f"Downloaded but failed to load '{model_id}'"
        _setup["active"] = False


# ── Inference ─────────────────────────────────────────────────────────

def generate(
    messages: list[dict],
    max_tokens: int = 2048,
    temperature: float = 0.1,
) -> str:
    """Synchronous generation. Raises RuntimeError if no model is loaded."""
    if _llm is None:
        raise RuntimeError("No model loaded - download and select a model first.")
    resp = _llm.create_chat_completion(
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=False,
    )
    return resp["choices"][0]["message"]["content"] or ""  # type: ignore[index]


def generate_stream(
    messages: list[dict],
    max_tokens: int = 2048,
    temperature: float = 0.1,
) -> Generator[str, None, None]:
    """Streaming generation - yields text tokens as they arrive."""
    if _llm is None:
        raise RuntimeError("No model loaded - download and select a model first.")
    for chunk in _llm.create_chat_completion(
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        stream=True,
    ):
        token: str = chunk["choices"][0]["delta"].get("content", "")  # type: ignore[index]
        if token:
            yield token


# ── Download ──────────────────────────────────────────────────────────

def download_model(
    model_id: str,
    progress_cb=None,  # Callable[[int, str], None] | None
) -> bool:
    """
    Download a GGUF model to MODELS_DIR.
    progress_cb(pct: int, status: str) called every ~1 MB.
    Returns True on success.
    """
    entry = get_entry(model_id)
    if not entry:
        log.error("Unknown model id: '%s'", model_id)
        return False

    dest = MODELS_DIR / entry["file"]
    if dest.exists():
        log.info("Model '%s' already downloaded", model_id)
        if progress_cb:
            progress_cb(100, "already_installed")
        return True

    tmp = dest.with_suffix(".tmp")
    url = entry["url"]
    log.info("Downloading '%s' from HuggingFace …", model_id)

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Kama/4.0"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            chunk_size = 1_048_576  # 1 MB chunks

            with open(tmp, "wb") as f:
                while True:
                    data = resp.read(chunk_size)
                    if not data:
                        break
                    f.write(data)
                    downloaded += len(data)
                    if progress_cb and total > 0:
                        pct = min(99, int(downloaded / total * 100))
                        progress_cb(pct, "downloading")

        tmp.rename(dest)
        if progress_cb:
            progress_cb(100, "done")
        log.info(
            "Download complete: %s (%.1f MB)",
            dest.name,
            dest.stat().st_size / 1_048_576,
        )
        return True

    except Exception as exc:
        log.error("Download failed for '%s': %s", model_id, exc)
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        if progress_cb:
            progress_cb(0, "error")
        return False
