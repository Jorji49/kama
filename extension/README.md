# Kama — AI Prompt Optimizer

> Turn rough ideas into world-class AI prompts. 100% local. Zero config. Your data never leaves your machine.

![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/AhmetKayraKama.kama-ai-prompt-optimizer)
![License](https://img.shields.io/github/license/Jorji49/kama)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-blue?logo=buymeacoffee&logoColor=white)](https://www.buymeacoffee.com/AhmetKayraKama)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

---

## What is Kama?

Kama is a VS Code extension that transforms your rough ideas into structured, AI-optimized prompts — tailored for Claude, GPT, Gemini, Grok, Codex, and o3.

Type something like *"add OAuth login with Google"* and get a detailed, context-aware prompt that knows your project's tech stack, file structure, and active code.

**No API keys. No cloud. No data leaves your computer.**

---

## ⚡ Quick Start

### Prerequisites

- **Python 3.10+** — [Download](https://www.python.org/downloads/) (check "Add to PATH")

> That's it. No build tools, no Docker, no external services.

### Install

1. Install **Kama** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AhmetKayraKama.kama-ai-prompt-optimizer)
2. Open a project folder
3. Click the **Kama** icon in the sidebar
4. Start typing your ideas

Kama auto-starts the Brain server, installs dependencies, and is ready in seconds.

---

## How It Works

```
Your Idea → Security Audit → Context Scan → Prompt Engine → Quality Score → Your AI Agent
```

1. **You type** a rough idea in the Kama sidebar
2. **Security Auditor** checks for injection risks and credential leaks
3. **Context Scanner** reads your project structure, languages, and tech stack
4. **Active File** context from your editor is included automatically
5. **Prompt Engine** generates a detailed, AI-family-optimized prompt
6. **Quality Scorer** grades the output (A+ to D)
7. **One click** sends it to your AI agent (Cursor, Copilot, Claude, etc.)

---

## Features

| Feature | Description |
|---------|-------------|
| **Vibe-to-Prompt** | Type a rough idea, get a production-ready prompt |
| **Agent Selector** | Optimized output for Claude, GPT, Gemini, Grok, Codex, o3 |
| **Smart Context** | Auto-detects your project's languages, frameworks, and structure |
| **Active File Awareness** | Reads your currently open file for relevant prompts |
| **Prompt History** | Search, star, and restore past prompts (100 entries) |
| **Prompt Chains** | Build multi-step workflows — each vibe extends the previous |
| **Send to Agent** | One click sends the prompt to your IDE's AI assistant |
| **Quality Scoring** | Every prompt gets an A+ to D grade |
| **Security Auditing** | Injection detection, credential leak scanning, sanitization |
| **Model Management** | Download and switch local GGUF models from the sidebar |
| **Keyboard Shortcut** | `Ctrl+Shift+K` — prompt from current file or selection |
| **Multi-IDE Support** | Cursor, Windsurf, Claude Code, GitHub Copilot, VS Code |

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `kama.model` | `llama3.2-1b` | Local GGUF model for AI-powered generation |
| `kama.brainServerUrl` | `http://127.0.0.1:8420` | Brain server URL |
| `kama.maxContextFiles` | `30` | Max project files to scan |
| `kama.autoSendToAgent` | `false` | Auto-send prompt to agent after generation |
| `kama.temperature` | `0.1` | Generation temperature (0.0–1.0) |
| `kama.maxTokens` | `2048` | Max tokens for generated prompts |

---

## Local AI Models (Optional)

Kama works out of the box using template-based prompt generation — no extra downloads needed.

For higher-quality AI-powered generation, install a local GGUF model from the sidebar:

| Model | Size | Speed | Quality |
|-------|------|-------|---------|
| **llama3.2-1b** | 1.3 GB | ⚡ Fast | Good |
| **llama3.2-3b** | 2.0 GB | Medium | ⭐ Great |
| **phi3.5-mini** | 2.4 GB | Slower | Excellent |
| **gemma2-2b** | 1.6 GB | Medium | Great |

> Models download to `~/.kama/models/`. A C/C++ compiler is required for local model inference (Visual Studio Build Tools on Windows, gcc/clang on Linux/macOS).

---

## Privacy & Security

- **Zero cloud dependency** — All processing runs locally on your machine
- **No telemetry** — We don't collect any usage data
- **No API keys** — Everything works offline
- **CORS restricted** — Brain API only accepts localhost requests
- **Input sanitization** — Injection and credential leak detection on every request
- **SHA-256 verification** — Downloaded models are integrity-checked
- **Rate limiting** — Per-client limits on all endpoints
- **Body size limits** — Requests over 1 MB are rejected

---

## Architecture

```
kama/
├── brain/                        # Python backend (FastAPI)
│   ├── sslm_engine.py            # Server + endpoints
│   ├── llm_backend.py            # GGUF model management
│   ├── prompt_optimizer.py       # AI-specific prompt builder
│   ├── prompt_knowledge_base.py  # Community prompt patterns
│   ├── context_scanner.py        # Project analysis
│   ├── security_auditor.py       # Security gate
│   ├── hardware_profiler.py      # Hardware-aware model recommendations
│   └── config.py                 # Environment configuration
└── extension/                    # VS Code extension (TypeScript)
    └── src/
        ├── extension.ts               # Entry point + auto-start
        ├── providers/SidebarProvider.ts # Webview UI + streaming
        ├── services/BrainClient.ts     # HTTP/SSE client
        └── utils/config.ts            # Settings
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Brain won't start | Verify Python 3.10+: `python --version`. Check the "Kama Brain" terminal for errors. |
| Shows "Offline" | Wait 10–15 seconds on first launch. Click "Start Brain Server" if needed. |
| Model download stuck | Check internet connection. Delete `~/.kama/models/` to retry. |
| Port conflict | Brain auto-finds an alternate port if 8420 is busy. |

---

## Contributing

1. Fork the repo
2. `git clone` and open `extension/` in VS Code
3. `npm install` in the `extension/` directory
4. Press `F5` to launch Extension Development Host
5. Submit a PR

---

## Support

If Kama saves you time, consider supporting the project:

<a href="https://www.buymeacoffee.com/AhmetKayraKama" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="40"></a>

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

---

## License

[MIT](LICENSE.md) — Made by [Ahmet Kayra Kama](https://github.com/Jorji49)
