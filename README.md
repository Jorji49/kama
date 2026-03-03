# Aether — AI Prompt Optimizer

> Transform rough ideas into perfect AI prompts. 100% local, no API keys needed — your data stays private.

![Visual Studio Marketplace](https://img.shields.io/visual-studio-marketplace/v/AhmetKayraKama.aether-prompt-generator)
![License](https://img.shields.io/github/license/Jorji49/aether)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support-blue?logo=buymeacoffee&logoColor=white)](https://www.buymeacoffee.com/AhmetKayraKama)
[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

## What is Aether?

Aether turns your rough ideas into production-ready AI prompts. Type something like *"create a login page with OAuth"* and get a structured, context-aware prompt optimized for your target AI agent — all running **100% locally** on your machine.

**No API keys. No cloud. No data leaves your computer.**

## Features

- **Vibe-to-Prompt** — Type a rough idea, get a fully structured AI prompt in seconds
- **100% Local & Private** — Runs entirely on your machine using a local GGUF model (~1.2 GB)
- **Plug & Play** — Installs with one click. Python backend and model download automatically on first use
- **Streaming Output** — Watch your prompt being generated token-by-token in real time
- **Multi-IDE Support** — Works with Cursor, Windsurf, Claude Code, GitHub Copilot, and VS Code
- **Smart Context Scanning** — Automatically analyzes your project structure, languages and tech stack
- **Language Selector** — Choose target languages (Python, TypeScript, Go, Rust…) for more accurate prompts
- **Agent Selector** — Pick your target AI (Claude, GPT, Gemini, Grok, Codex) for optimized prompt formatting
- **Quality Scoring** — Every prompt gets a quality grade (A+ to D) with a score
- **Security Auditing** — Prompts are checked for injection risks and sensitive data leaks
- **Model Management** — Download, switch, and manage local GGUF models from the sidebar
- **Send to Agent** — One click sends the generated prompt directly to your IDE's AI assistant

## Quick Start

### Prerequisites

- **Python 3.10+** — [Download](https://www.python.org/downloads/) (check "Add to PATH" during install)
- **16 GB RAM recommended** (8 GB minimum)

> **That's it.** No Ollama, no Docker, no external services needed.

### Setup

1. Install **Aether** from the VS Code Marketplace
2. Open any project folder
3. Click the **Aether** icon in the Activity Bar (left sidebar)
4. Aether will automatically:
   - Start the Brain server in the background
   - Install Python dependencies
   - Download a local AI model (~1.2 GB, one-time)
5. Start typing your ideas!

## How It Works

```
Your Idea → Aether Brain → Local LLM (GGUF) → Optimized Prompt → Your AI Agent
```

1. **You type** a rough idea in the Aether sidebar
2. **Context Scanner** analyzes your project (files, structure, tech stack, languages)
3. **Prompt Optimizer** crafts a detailed, structured prompt using the local LLM
4. **Quality Auditor** scores the output and checks for security issues
5. **One click** sends the prompt to your AI agent (Cursor, Copilot, Claude, etc.)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `aether.brainServerUrl` | `http://127.0.0.1:8420` | Brain server URL |
| `aether.model` | `llama3.2-1b` | Local GGUF model for prompt generation |
| `aether.maxContextFiles` | `30` | Max project files to scan for context |
| `aether.autoSendToAgent` | `false` | Auto-send prompt to AI agent after generation |
| `aether.temperature` | `0.1` | Generation temperature (0.0–1.0) |
| `aether.maxTokens` | `2048` | Max tokens for generated prompts |

## Available Models

| Model | Size | Speed | Quality | Notes |
|-------|------|-------|---------|-------|
| **llama3.2-1b** | 1.3 GB | ⚡⚡⚡⚡ | ⭐⭐ | Default — fast, low RAM |
| **llama3.2-3b** | 2.0 GB | ⚡⚡⚡ | ⭐⭐⭐ | Recommended for quality |
| **phi3.5-mini** | 2.4 GB | ⚡⚡ | ⭐⭐⭐⭐ | Best reasoning |
| **gemma2-2b** | 1.6 GB | ⚡⚡⚡ | ⭐⭐⭐ | Strong multilingual |

Models are downloaded automatically to `~/.aether/models/` on first use. You can switch models from the sidebar.

## Privacy

- **Zero cloud dependency** — All processing happens on your local machine
- **No telemetry** — We don't collect any usage data
- **No API keys needed** — Works entirely with a bundled local model
- **Your code stays yours** — Context scanning never leaves your machine
- **Models stored locally** — In `~/.aether/models/`, you own everything

## Architecture

```
aether/
├── brain/                        # Python backend (bundled)
│   ├── sslm_engine.py            # FastAPI server
│   ├── llm_backend.py            # Local GGUF model management
│   ├── prompt_optimizer.py       # Prompt generation engine
│   ├── prompt_knowledge_base.py  # Best practices & patterns
│   ├── context_scanner.py        # Project analysis
│   ├── security_auditor.py       # Security checks
│   └── config.py                 # Configuration
└── extension/                    # VS Code extension (TypeScript)
    └── src/
        ├── extension.ts               # Entry point + auto-start
        ├── providers/SidebarProvider.ts # UI + streaming
        ├── services/BrainClient.ts     # HTTP client
        └── utils/config.ts            # Settings
```

## Commands

| Command | Description |
|---------|-------------|
| `Aether: Send Vibe` | Enter a prompt idea via input box |
| `Aether: Start Brain` | Start the local Brain server |
| `Aether: Send to Agent` | Send a prompt to your AI assistant |

## Troubleshooting

### Brain server won't start
- Make sure Python 3.10+ is installed: `python --version`
- Check if port 8420 is available
- Try restarting VS Code

### Model download stuck
- Check your internet connection (model downloads from HuggingFace)
- Models are cached in `~/.aether/models/` — delete the folder to re-download

### Extension shows "Offline"
- The Brain auto-starts on activation. Wait 10-15 seconds for first-time setup
- Check the **"Aether Brain"** terminal in VS Code for errors
- The extension auto-discovers ports 8420–8429

## Support

If you find Aether useful, consider supporting the project:

<a href="https://www.buymeacoffee.com/AhmetKayraKama" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="40"></a>

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-%E2%9D%A4-pink?logo=github)](https://github.com/sponsors/Jorji49)

## License

[MIT](LICENSE.md) — Made by [Ahmet Kayra Kama](https://github.com/Jorji49)
