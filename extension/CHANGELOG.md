# Changelog

All notable changes to Kama - AI Prompt Optimizer will be documented in this file.

## [3.0.1] - 2026-03-05

### Fixed
- **llama-cpp-python now optional** — Brain starts without a C/C++ compiler. Core dependencies (fastapi, uvicorn, pydantic) install independently; llama-cpp-python is attempted separately and fails gracefully
- **First-run install no longer blocked by build failures** — On systems without Visual Studio Build Tools, the Brain server starts normally and reports the missing LLM engine via the health endpoint
- **Health endpoint reports `no_llama` status** — Extension UI shows a clear error message when llama-cpp-python is not available instead of a generic failure

## [3.0.0] - 2026-03-05

### ⚡ Major — Security Hardening & Windows 11 Compatibility

A comprehensive security, stability, and platform compatibility overhaul. No breaking user-facing changes — all improvements are under the hood.

### Added
- **SHA-256 download verification** — Model files are checksummed after download and rejected if integrity check fails
- **Request body size limits** — Bodies over 1 MB rejected (HTTP 413) to prevent abuse
- **Rate limiting on knowledge-base endpoints** — `/knowledge-base` and `/knowledge-base/{category}` now rate-limited
- **Trusted domain validation** — Model downloads only allowed from `huggingface.co` (HTTPS)
- **UNC/extended path blocking** — `\\?\`, `\\.\ `, and `\\server\share` paths rejected in workspace scanner
- **Dependency self-check** — Brain fails fast with clear error message if any Python dependency is missing
- **Python venv isolation** — Brain runs inside a `.venv` virtual environment (auto-created on first launch)
- **Deps stamp versioning** — `requirements.txt` changes trigger automatic reinstall on next launch
- **Activation error boundary** — Extension activation wrapped in try/catch so failures show user-friendly error
- **Brain terminal cleanup on deactivate** — Python process killed when extension closes
- **Contributing guide** — Added to README

### Changed
- **Windows hardware detection** — Migrated from deprecated `wmic` to PowerShell `Get-CimInstance` (WMIC removed in Windows 11 24H2), with WMIC as automatic fallback
- **Windows event loop** — Forced `WindowsSelectorEventLoop` to fix uvicorn signal handling on Windows (ProactorEventLoop doesn't support `add_signal_handler`)
- **Port check rewrite** — Uses `bind()` instead of `connect()` to avoid Windows socket hang; waits up to 10s for old process to release port
- **SSRF prevention** — `BrainClient` constructor validates URL is `http://127.0.0.1` or `http://localhost` only
- **CSP hardened** — Replaced `'unsafe-inline'` for styles with `nonce`-based CSP; nonce now uses `crypto.randomBytes` instead of `Math.random`
- **XML injection prevention** — Context scanner escapes HTML entities in attribute values and CDATA sections
- **Thread-safe model state** — `_setup` dict protected by `_setup_lock`; inference uses atomic reference copy of `_llm`
- **Hardened error responses** — Hardware profile errors no longer leak exception details to client
- **Blocked system paths expanded** — Added `/var`, `C:\Program Files (x86)`, `C:\ProgramData`; case-insensitive matching on Windows
- **Config parsing** — `int()`/`float()` env var parsing wrapped in try/except to prevent crash on invalid values
- **Pinned Python dependencies** — Exact version pins for reproducible installs (`fastapi==0.135.1`, `uvicorn==0.41.0`, etc.)
- **llama-cpp-python bundled** — Now included in `requirements.txt` with CPU wheel index
- **Context scanning async** — `scan_workspace()` offloaded to thread pool via `asyncio.to_thread()` so it doesn't block the event loop
- **Auto-start threshold** — Uses `MAX_FAILS` constant instead of hardcoded `1`
- **IDE detection cached** — `detectIDE()` result cached to avoid repeated command probing
- **Import check expanded** — Dependency check now verifies all 7 critical imports, not just 2
- **All terminal kills** — Disposes ALL "Kama Brain" terminals on restart, not just the first one
- **Cross-platform file rename** — `tmp.rename()` → `tmp.replace()` (rename fails on Windows if destination exists)
- **README polish** — Added Rate Limiting and Request Size Limits to features; added Security & Privacy section; added Contributing guide; dash → em dash formatting throughout

### Removed
- **Unused `asyncio` import** — Removed from `security_auditor.py`

## [2.1.3] - 2026-03-04

### Fixed
- **Ctrl+C shutdown crash (final fix)** - Added `atexit` handler and explicit `finally` block cleanup so the llama model is always freed before Python tears down modules, even when Ctrl+C kills the event loop before lifespan shutdown runs

## [2.1.2] - 2026-03-04

### Fixed
- **Clean shutdown crash** - Model is now explicitly freed during ASGI lifespan shutdown, eliminating `TypeError: 'NoneType' object is not callable` and `CancelledError` tracebacks on exit
- **Model switch leak** - Switching models now properly `.close()`s the previous Llama instance instead of just dropping the reference

## [2.1.1] - 2026-03-04

### Fixed
- **Brain server crash on startup** - Replaced deprecated `@app.on_event("startup")` with modern FastAPI `lifespan` context manager. Server was starting then immediately shutting down with newer uvicorn/FastAPI versions
- **Start button resets during startup** - Button now stays blue/disabled ("Starting…") until the Brain is fully online or a 2-minute timeout expires. Previously, health check failures would reset the button to green, letting users click it repeatedly
- **Double brain start** - Pressing "Start Brain" while already starting now shows an info message instead of spawning another terminal
- **Unused imports** - Removed dead `import concurrent.futures` from `sslm_engine.py`
- **Hardware profiler recommending unavailable models** - `MODEL_CATALOG` now only contains the 4 models that can actually be downloaded through the app (was listing 14 models including Ollama-only ones like phi4, deepseek-r1, mistral)
- **Unused variable** - Removed dead `cpu_freq` assignment in `hardware_profiler.py`
- **Stale docstring** - Hardware profiler docstring updated from "Ollama" to "GGUF"
- **Extension brain copy out of sync** - `extension/brain/` files now match `brain/` exactly

## [2.1.0] - 2026-03-04

### Added
- **Prompt History & Favorites** - Full history view with search, star/unstar favorites, delete items. Persistent across sessions (up to 100 entries)
- **Prompt Chains** - Chain prompts together for multi-step workflows. Click 🔗 Chain on any prompt, then your next vibe builds on the previous one
- **Active File Context** - Kama reads your currently open file and sends it to the brain for more relevant, context-aware prompts
- **Keyboard Shortcut** - `Ctrl+Shift+K` (`Cmd+Shift+K` on Mac) generates a prompt from your current file or selection
- **Onboarding Tutorial** - 4-slide walkthrough shown on first launch
- **Clipboard toast** - Visual feedback when copying prompts from history

### Changed
- **System prompts rewritten** - All AI family prompts now use natural language style (no XML, no templates, no scaffolding)
- **Quality fallback threshold** - Only truly empty/degenerate LLM output triggers template fallback (previously too aggressive, replacing good LLM output with rigid templates)
- **Streaming events** - Backend now sends exactly one terminal event per stream (prevents history duplication)
- **Hardware profiler** - Model names now match the GGUF catalog IDs (llama3.2-1b, llama3.2-3b, gemma2-2b)
- **Default model** - Config default aligned to `llama3.2-1b` across all files
- **Python compat** - `asyncio.get_event_loop()` → `asyncio.get_running_loop()` for Python 3.12+ compatibility

### Fixed
- **History duplication** - Backend was sending both `fallback` and `done` events on error, causing double entries
- **History duplication on restore** - Session restore no longer re-saves items to persistent history
- **Chain button permanently dead** - `btn-ok` CSS `pointer-events:none` was never reset; now resets after 2s
- **Send to Agent button permanently dead** - Same root cause and fix as Chain button
- **Chain X not clearing backend** - Clicking X on chain bar now properly resets `_chainContext`
- **Chain bar stays visible** - Auto-hides after vibe is sent
- **Chain context lost on error** - Chain context now consumed only on stream success
- **Event handler leak** - `onDidChangeActiveTextEditor` now properly disposed on view dispose
- **Prefill race condition** - Retry loop (up to 3s) instead of fixed 300ms delay
- **Invisible status dot** - Blue background during "starting" state (was invisible due to missing CSS)
- **PowerShell dep check** - Uses `$LASTEXITCODE` instead of try/catch (catches non-terminating errors)

### Removed
- **Dead code** - Removed legacy `deep_review_with_sslm()` function and all Ollama references from security auditor
- **Dead variable** - Removed unused `_restoring` variable from webview restore handler
- **Language selector** - Removed in favor of automatic language detection from project context

## [2.0.0] - 2026-03-04

### ⚡ Major - 100% Local, Zero Dependencies

Kama no longer requires Ollama. Everything runs locally with a bundled GGUF model via llama-cpp-python.

### Added
- **Plug & Play** - Brain server auto-starts, model auto-downloads on first activation
- **Streaming output** - Watch prompts generated token-by-token in real time
- **Language selector** - Multiple-choice language picker (30 languages) always visible in sidebar
- **Download progress** - Live progress bar during model download (shown in sidebar)
- **Python check** - Warns users if Python is not installed and offers download link
- **Bundled Brain** - Python backend files included in extension package (no separate install needed)
- **Language persistence** - Selected languages saved across sessions

### Changed
- **Removed Ollama dependency** - Replaced with llama-cpp-python (direct GGUF inference)
- **Default model** - Now `llama3.2-1b` (1.3 GB, auto-downloads from HuggingFace)
- **Model catalog** - Updated to GGUF models: llama3.2-1b, llama3.2-3b, phi3.5-mini, gemma2-2b
- **Settings renamed** - `Kama.ollamaModel` → `Kama.model`, `Kama.ollamaTemperature` → `Kama.temperature`, `Kama.ollamaMaxTokens` → `Kama.maxTokens`
- **Health check** - Smarter status: shows "Connected", "Downloading 42%", "Starting…", or "Offline"
- **Auto-start** - Extension auto-launches Brain on first failed health check (no manual "Start Brain" needed)
- **CSP hardened** - Added `img-src` directive to Content Security Policy

### Fixed
- Webview race condition: `postMessage` before JS ready (added `ready` signal + retry)
- Duplicate `querySelectorAll('.tab')` call that broke all webview JavaScript
- Health check returned object but was treated as boolean - fixed type handling
- Footer showed "ollama" text - now shows "Kama"
- Status only sent on first online transition - now sent on every health check cycle

### Removed
- Ollama auto-start code (no longer needed)
- `ollama` Python package dependency
- All Ollama references from documentation and UI

## [1.0.2] - 2026-02-07

### Fixed
- Bug: `_fallback()` passed `list[str]` instead of `str` for security rules - caused crashes on fallback prompts
- `num_predict` was hard-capped at 768 tokens even with higher settings - now respects up to 2048
- Context window (`num_ctx`) increased from 2048 → 4096 for better prompt generation with larger vibes
- Security auditor vibe length warning raised from 4000 → 12000 chars

### Changed
- Default max tokens increased from 1024 → 2048
- Vibe input limit increased from 8192 → 16384 characters (backend)
- Prompt output area max-height increased from 400px → 600px
- Textarea max-height increased from 140px → 200px for longer inputs
- Max tokens setting range expanded: 512 – 8192 (was 256 – 4096)

### Added
- `.env.example` file for easy brain configuration

## [1.0.1] - 2026-02-07

### Fixed
- Brain folder discovery now checks 5 locations including user home directory
- Added manual folder picker when Brain is not found automatically
- Translated all Turkish UI text to English

## [1.0.0] - 2026-02-07

### Added
- Initial release of Kama - AI Prompt Optimizer
- Vibe-to-prompt generation with local AI model
- Smart project context scanning (files, structure, tech stack)
- Multi-IDE support: Cursor, Windsurf, Claude Code, GitHub Copilot, VS Code
- Agent selector panel with Claude, GPT, Gemini, and Grok model families
- Quality scoring and grading system (A+ to D)
- Security auditing for prompt injection and data leak detection
- One-click model download and management from sidebar
- Resilient health check with 3-failure threshold
- Chat history persistence across sessions
- Dark theme UI optimized for IDE sidebars
- Send-to-Agent with automatic IDE detection
- Clipboard fallback for unsupported environments
