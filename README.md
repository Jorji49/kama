# Kama - AI Prompt Optimizer

> Transform rough ideas into perfect AI prompts. 100% local, no API keys needed — your data stays private.

![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/AhmetKayraKama.kama-ai-prompt-optimizer)
![License](https://img.shields.io/github/license/Jorji49/kama)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-blue?logo=buymeacoffee&logoColor=white)](https://www.buymeacoffee.com/AhmetKayraKama)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

## What is Kama?

Kama turns your rough ideas into production-ready AI prompts. Type something like *"create a login page with OAuth"* and get a structured, context-aware prompt optimized for your target AI — all running **100% locally** on your machine.

**No API keys. No cloud. No data leaves your computer.**

## Features

### Core
- **Vibe-to-Prompt** — Type a rough idea, get a fully structured AI prompt in seconds
- **100% Local & Private** — Runs entirely on your machine using a local GGUF model (~1.3 GB)
- **Plug & Play** — One-click install. Brain server + model download automatically on first use
- **Streaming Output** — Watch prompts being generated token-by-token in real time
- **Smart Context** — Automatically scans your project structure, languages, and tech stack

### Prompt Tools
- **Prompt History & Favorites** — Full history with search, star favorites, delete items. Persistent across sessions (up to 100 entries)
- **Prompt Chains** — Chain prompts together for multi-step workflows. Click the Chain button on any prompt, then your next vibe builds on the previous one
- **Active File Context** — Kama reads your currently open file and feeds it to the AI for more relevant prompts
- **Keyboard Shortcut** — `Ctrl+Shift+K` generates a prompt from your current file or selection
- **Onboarding Tutorial** — 4-slide walkthrough for first-time users

### Agent & Model Support
- **Multi-IDE Support** — Works with Cursor, Windsurf, Claude Code, GitHub Copilot, and VS Code
- **Agent Selector** — Pick your target AI (Claude, GPT, Gemini, Grok, Codex, o3) for optimized prompt formatting
- **Model Management** — Download, switch, and manage local GGUF models from the sidebar
- **Send to Agent** — One click sends the generated prompt directly to your IDE's AI assistant

### Quality & Security
- **Quality Scoring** — Every prompt gets a quality grade (A+ to D)
- **Security Auditing** — Prompts checked for injection risks and sensitive data leaks
- **Prompt Sanitization** — Dangerous patterns automatically removed
- **Rate Limiting** — Per-client, in-memory rate limiting on all endpoints
- **Request Size Limits** — Bodies over 1 MB are rejected to prevent abuse

## Quick Start

### Prerequisites

- **Python 3.10+** — [Download](https://www.python.org/downloads/) (check "Add to PATH" during install)
- **8 GB RAM minimum** (16 GB recommended)

> **That's it.** No Ollama, no Docker, no external services needed.

### Setup

1. Install **Kama** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=AhmetKayraKama.kama-ai-prompt-optimizer)
2. Open any project folder
3. Click the **Kama** icon in the Activity Bar (left sidebar)
4. Kama will automatically:
   - Start the Brain server in the background
   - Create a Python virtual environment
   - Install Python dependencies
   - Download a local AI model (~1.3 GB, one-time)
5. Start typing your ideas!

## How It Works

```
Your Idea -> Kama Brain -> Local LLM (GGUF) -> Optimized Prompt -> Your AI Agent
```

1. **You type** a rough idea in the Kama sidebar
2. **Security Auditor** checks input for injection/credential leaks
3. **Context Scanner** analyzes your project (files, structure, tech stack)
4. **Active File** context from your currently open editor is included
5. **Local LLM** generates a detailed, AI-optimized prompt (streamed token-by-token)
6. **Quality Scorer** grades the output (A+ to D)
7. **Prompt Sanitizer** strips dangerous patterns
8. **One click** sends the prompt to your AI agent (Cursor, Copilot, Claude, etc.)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `kama.brainServerUrl` | `http://127.0.0.1:8420` | Brain server URL |
| `kama.model` | `llama3.2-1b` | Local GGUF model for prompt generation |
| `kama.maxContextFiles` | `30` | Max project files to scan for context |
| `kama.autoSendToAgent` | `false` | Auto-send prompt to AI agent after generation |
| `kama.temperature` | `0.1` | Generation temperature (0.0-1.0) |
| `kama.maxTokens` | `2048` | Max tokens for generated prompts |

## Available Models

| Model | Size | Speed | Quality | Notes |
|-------|------|-------|---------|-------|
| **llama3.2-1b** | 1.3 GB | ⚡ Fast | Good | Default, low RAM |
| **llama3.2-3b** | 2.0 GB | Medium | ⭐ Great | Recommended for quality |
| **phi3.5-mini** | 2.4 GB | Slower | Excellent | Best reasoning |
| **gemma2-2b** | 1.6 GB | Medium | Great | Strong multilingual |

Models download automatically to `~/.kama/models/` on first use. Switch models from the sidebar.

## Commands

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Kama: Send Vibe` | - | Enter a prompt idea via input box |
| `Kama: Start Brain` | - | Start the local Brain server |
| `Kama: Send to Agent` | - | Send a prompt to your AI assistant |
| `Kama: Generate Prompt from Selection` | `Ctrl+Shift+K` | Generate prompt from current file/selection |

## Privacy & Security

- **Zero cloud dependency** — All processing happens locally
- **No telemetry** — We don't collect any usage data
- **No API keys** — Works entirely with a bundled local model
- **Your code stays yours** — Context scanning never leaves your machine
- **Models stored locally** — In `~/.kama/models/`, you own everything
- **CORS restricted** — Brain API only accepts requests from localhost
- **Input sanitization** — Injection and credential leak detection on every request
- **Download verification** — Model files are SHA-256 verified after download

## Architecture

```
kama/
├── brain/                        # Python backend (bundled with VSIX)
│   ├── sslm_engine.py            # FastAPI server + endpoints
│   ├── llm_backend.py            # Local GGUF model management
│   ├── prompt_optimizer.py       # AI-specific prompt builder
│   ├── prompt_knowledge_base.py  # Community prompt patterns
│   ├── context_scanner.py        # Project analysis
│   ├── security_auditor.py       # Security gate
│   ├── hardware_profiler.py      # Hardware-aware model recommendations
│   └── config.py                 # Environment-driven configuration
└── extension/                    # VS Code extension (TypeScript)
    └── src/
        ├── extension.ts               # Entry point + auto-start + IDE detection
        ├── providers/SidebarProvider.ts # Webview UI + streaming + history
        ├── services/BrainClient.ts     # HTTP/SSE client
        └── utils/config.ts            # Settings
```

## Troubleshooting

### Brain server won't start
- Make sure Python 3.10+ is installed: `python --version`
- Check if port 8420 is available
- Try restarting VS Code
- Check the **"Kama Brain"** terminal in VS Code for errors

### Model download stuck
- Check your internet connection (models download from HuggingFace)
- Models are cached in `~/.kama/models/` — delete the folder to re-download

### Extension shows "Offline"
- The Brain auto-starts on activation. Wait 10-15 seconds for first-time setup
- Click **"Start Brain Server"** in the offline banner

## Contributing

1. Fork the repo
2. Clone your fork and open the `extension/` folder in VS Code
3. `npm install` in the `extension/` directory
4. Press `F5` to launch Extension Development Host
5. Make changes and submit a PR

## Support

If you find Kama useful, consider supporting the project:

<a href="https://www.buymeacoffee.com/AhmetKayraKama" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="40"></a>

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

## License

[MIT](LICENSE.md) — Made by [Ahmet Kayra Kama](https://github.com/Jorji49)
