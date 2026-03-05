# Changelog

All notable changes to Kama — AI Prompt Optimizer.

## [3.0.5] - 2026-03-05

### Fixed
- **Missing view icon** in `package.json` — resolved VS Code schema warning

### Changed
- **README rewritten** — cleaner structure with feature tables, reflects template-first approach, models listed as optional enhancement
- **CHANGELOG consolidated** — single clean file replacing patch-level noise

---

## [3.0.4] - 2026-03-05

### Removed
- Dead code cleanup — removed legacy `audit_prompt()`, unused `to_xml()`/`_esc_cdata()`, dead `no_llama`/`setupError`/`degraded` handlers, unused `isSetup` variable, unused imports (`Optional` × 3, `html` × 1)

### Fixed
- Python 3.16 deprecation — `WindowsSelectorEventLoopPolicy` only applied on Python < 3.16

---

## [3.0.3] - 2026-03-05

### Changed
- **Template mode is the default "Connected" experience** — Brain server reports "Connected" even without llama-cpp-python. True plug-and-play — no C++ compiler needed

---

## [3.0.0] - 2026-03-05

### ⚡ Major — Security Hardening & Windows 11 Compatibility

- **SHA-256 download verification** for model integrity
- **Request body size limits** (1 MB) and **rate limiting** on all endpoints
- **SSRF prevention** — BrainClient validates localhost-only URLs
- **CSP hardened** — `nonce`-based CSP replaces `'unsafe-inline'`
- **Thread-safe model state** with lock-protected inference
- **UNC/extended path blocking** in workspace scanner
- **Python venv isolation** with auto-created `.venv`
- **Pinned dependencies** for reproducible installs
- **Windows 11 hardware detection** — migrated from `wmic` to PowerShell `Get-CimInstance`
- **llama-cpp-python fully optional** — Brain starts without it, template fallback works

---

## [2.1.0] - 2026-03-04

### Added
- **Prompt History & Favorites** — search, star, delete, persistent across sessions
- **Prompt Chains** — multi-step workflows with context carried forward
- **Active File Context** — reads your open file for relevant prompts
- **Keyboard Shortcut** — `Ctrl+Shift+K` generates from current file/selection
- **Onboarding Tutorial** — 4-slide walkthrough for first-time users
- **Streaming output** — token-by-token prompt generation

### Fixed
- History duplication, chain button dead state, prefill race condition, terminal cleanup

---

## [2.0.0] - 2026-03-04

### ⚡ Major — 100% Local, Zero Dependencies

- Replaced Ollama with bundled llama-cpp-python (GGUF)
- Auto-downloads default model on first launch
- Live download progress bar in sidebar
- Python virtual environment auto-created

---

## [1.0.0] - 2026-02-07

### Initial Release
- Vibe-to-prompt generation with local AI
- Smart project context scanning
- Multi-IDE support: Cursor, Windsurf, Claude Code, GitHub Copilot, VS Code
- Agent selector: Claude, GPT, Gemini, Grok
- Quality scoring (A+ to D) and security auditing
- One-click model download and management
- Dark theme UI optimized for IDE sidebars
