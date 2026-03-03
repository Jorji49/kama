# Changelog

All notable changes to Aether Prompt Generator will be documented in this file.

## [2.0.0] - 2026-03-04

### ⚡ Major — 100% Local, Zero Dependencies

Aether no longer requires Ollama. Everything runs locally with a bundled GGUF model via llama-cpp-python.

### Added
- **Plug & Play** — Brain server auto-starts, model auto-downloads on first activation
- **Streaming output** — Watch prompts generated token-by-token in real time
- **Language selector** — Multiple-choice language picker (30 languages) always visible in sidebar
- **Download progress** — Live progress bar during model download (shown in sidebar)
- **Python check** — Warns users if Python is not installed and offers download link
- **Bundled Brain** — Python backend files included in extension package (no separate install needed)
- **Language persistence** — Selected languages saved across sessions

### Changed
- **Removed Ollama dependency** — Replaced with llama-cpp-python (direct GGUF inference)
- **Default model** — Now `llama3.2-1b` (1.3 GB, auto-downloads from HuggingFace)
- **Model catalog** — Updated to GGUF models: llama3.2-1b, llama3.2-3b, phi3.5-mini, gemma2-2b
- **Settings renamed** — `aether.ollamaModel` → `aether.model`, `aether.ollamaTemperature` → `aether.temperature`, `aether.ollamaMaxTokens` → `aether.maxTokens`
- **Health check** — Smarter status: shows "Connected", "Downloading 42%", "Starting…", or "Offline"
- **Auto-start** — Extension auto-launches Brain on first failed health check (no manual "Start Brain" needed)
- **CSP hardened** — Added `img-src` directive to Content Security Policy

### Fixed
- Webview race condition: `postMessage` before JS ready (added `ready` signal + retry)
- Duplicate `querySelectorAll('.tab')` call that broke all webview JavaScript
- Health check returned object but was treated as boolean — fixed type handling
- Footer showed "ollama" text — now shows "aether"
- Status only sent on first online transition — now sent on every health check cycle

### Removed
- Ollama auto-start code (no longer needed)
- `ollama` Python package dependency
- All Ollama references from documentation and UI

## [1.0.2] - 2026-02-07

### Fixed
- Bug: `_fallback()` passed `list[str]` instead of `str` for security rules — caused crashes on fallback prompts
- `num_predict` was hard-capped at 768 tokens even with higher settings — now respects up to 2048
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
- Initial release of Aether Prompt Generator
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
