/**
 * Kama - Main Extension Entry Point
 *
 * Multi-IDE support: Cursor, Claude Code, Windsurf/Antigravity, GitHub Copilot.
 * Resilient health check with 3-failure threshold.
 */

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { SidebarProvider } from "./providers/SidebarProvider";
import { BrainClient } from "./services/BrainClient";
import { KamaConfig } from "./utils/config";

// Cached IDE detection result (expensive to compute each time)
let _cachedIDE: "cursor" | "windsurf" | "claude-code" | "copilot" | "vscode" | null = null;

let brainClient: BrainClient;
let _healthInterval: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  try {
    brainClient = new BrainClient(KamaConfig.brainServerUrl);
    const sidebarProvider = new SidebarProvider(context.extensionUri, brainClient, context);

    // ── Register Sidebar ──────────────────────────────────────────────
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "kama.vibePanel",
        sidebarProvider,
        { webviewOptions: { retainContextWhenHidden: true } }
      )
    );

    // ── Commands ──────────────────────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand("kama.sendVibe", async () => {
        const input = await vscode.window.showInputBox({
          prompt: "Enter your vibe...",
          placeHolder: "e.g. create a login page, add dark mode",
        });
        if (input) { await sidebarProvider.handleVibe(input); }
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("kama.startBrain", async () => {
        // Find brain folder - search workspace first (dev), then bundled, then others
        let brainPath = "";
        const hasBrain = (dir: string) => fs.existsSync(path.join(dir, "sslm_engine.py"));

        // 1. Workspace folder (development - always prefer this for fresh code)
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (ws && hasBrain(path.join(ws, "brain"))) { brainPath = path.join(ws, "brain"); }

        // 2. Bundled inside extension package (marketplace install)
        if (!brainPath) {
          const bundled = path.join(context.extensionUri.fsPath, "brain");
          if (hasBrain(bundled)) { brainPath = bundled; }
        }

        // 3. Sibling of extension (monorepo)
        if (!brainPath) {
          const candidate = path.resolve(context.extensionUri.fsPath, "..", "brain");
          if (hasBrain(candidate)) { brainPath = candidate; }
        }

        // 4. Walk up from extension dir
        if (!brainPath) {
          let cur = path.resolve(context.extensionUri.fsPath);
          for (let i = 0; i < 4 && !brainPath; i++) {
            const c = path.join(cur, "brain");
            if (hasBrain(c)) { brainPath = c; }
            cur = path.dirname(cur);
          }
        }

        if (!brainPath) {
          const pick = await vscode.window.showErrorMessage(
            "Kama: Brain folder not found. Open the Kama project as your workspace.",
            "Browse..."
          );
          if (pick === "Browse...") {
            const result = await vscode.window.showOpenDialog({
              canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
              openLabel: "Select brain folder",
            });
            if (result?.[0]) {
              const sel = result[0].fsPath;
              if (hasBrain(sel)) { brainPath = sel; }
              else { vscode.window.showErrorMessage("Selected folder does not contain sslm_engine.py."); return; }
            }
          }
        }
        if (!brainPath) { return; }

        // ── Python check ──────────────────────────────────────────────
        const isWin = process.platform === "win32";
        const pythonCmd = isWin ? "python" : "python3";
        try {
          cp.execSync(`${pythonCmd} --version`, { timeout: 5000, stdio: "pipe" });
        } catch {
          vscode.window.showErrorMessage(
            "Kama requires Python 3.10+. Install Python from python.org and restart VS Code.",
            "Download Python"
          ).then(pick => {
            if (pick === "Download Python") {
              vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
            }
          });
          return;
        }

        // Prevent double-start: if brain is already starting, don't create another terminal
        if (isBrainStarting()) {
          vscode.window.showInformationMessage("Kama Brain is already starting. Please wait…");
          return;
        }

        // Sanitize brainPath: reject shell metacharacters to prevent command injection
        if (/[;&|`$(){}\[\]!#~<>*?\r\n]/.test(brainPath)) {
          vscode.window.showErrorMessage("Kama: Brain folder path contains invalid characters.");
          return;
        }

        // Kill ALL existing Kama Brain terminals to avoid stale sessions / port conflicts
        const existingTerminals = vscode.window.terminals.filter(t => t.name === "Kama Brain");
        for (const t of existingTerminals) { t.dispose(); }
        // Wait for the old terminal's process to fully exit and release port (Windows needs more time)
        await new Promise(r => setTimeout(r, existingTerminals.length > 0 ? 2000 : 200));

        // ── Venv: isolate brain dependencies from system Python ─────
        const venvDir = path.join(brainPath, ".venv");
        const venvPython = isWin
          ? path.join(venvDir, "Scripts", "python.exe")
          : path.join(venvDir, "bin", "python");

        // Create venv if it doesn't exist yet (first run)
        if (!fs.existsSync(venvPython)) {
          vscode.window.showInformationMessage("Kama: Setting up Python environment (first run)…");
          try {
            cp.execSync(`${pythonCmd} -m venv "${venvDir}"`, {
              timeout: 60_000,
              stdio: "pipe",
              cwd: brainPath,
            });
          } catch (e) {
            vscode.window.showErrorMessage(
              `Kama: Failed to create Python venv. ${e instanceof Error ? e.message : String(e)}`
            );
            return;
          }
        }

        const terminal = vscode.window.createTerminal({
          name: "Kama Brain",
          env: { "VIRTUAL_ENV": venvDir, "CONDA_PREFIX": "" },
        });

        const cdCmd = isWin ? `cd "${brainPath}"` : `cd '${brainPath}'`;
        // Use the venv Python for all operations
        // PowerShell needs & (call operator) to invoke a quoted path as a command
        const qVenvPython = isWin ? `& "${venvPython}"` : `'${venvPython}'`;
        // Check core imports (llama_cpp excluded — optional, needs C++ compiler)
        const depCheck = `${qVenvPython} -c "import fastapi, uvicorn, pydantic, starlette, psutil, dotenv"`;
        const pipInstall = `${qVenvPython} -m pip install --prefer-binary -r requirements.txt`;
        // llama-cpp-python installed separately — if it fails (no C++ compiler), brain still starts
        const llamaInstall = `${qVenvPython} -m pip install --prefer-binary --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu llama-cpp-python==0.3.2`;
        const startCmd = `${qVenvPython} sslm_engine.py`;

        // Version stamp: force reinstall when requirements.txt changes
        // This ensures extension updates with new deps always get picked up.
        const reqPath = path.join(brainPath, "requirements.txt");
        const stampPath = path.join(venvDir, ".deps-stamp");
        let needsInstall = false;
        try {
          const reqContent = fs.readFileSync(reqPath, "utf-8");
          const currentStamp = reqContent.trim();
          const savedStamp = fs.existsSync(stampPath) ? fs.readFileSync(stampPath, "utf-8").trim() : "";
          if (currentStamp !== savedStamp) { needsInstall = true; }
        } catch { needsInstall = true; }

        // Write stamp update command (runs after successful pip install)
        const writeStampCmd = isWin
          ? `${qVenvPython} -c "import shutil,sys; open(r'${stampPath.replace(/'/g, "''")}','w').write(open(r'${reqPath.replace(/'/g, "''")}').read().strip())"`
          : `${qVenvPython} -c "open('${stampPath}','w').write(open('${reqPath}').read().strip())"`;

        if (isWin) {
          if (needsInstall) {
            // Force install core deps + try llama-cpp-python (may fail without C++ compiler) + stamp + start
            terminal.sendText(`${cdCmd} ; ${pipInstall} ; ${llamaInstall} 2>$null ; ${writeStampCmd} ; ${startCmd}`);
          } else {
            // Quick import check, install only if broken
            terminal.sendText(`${cdCmd} ; ${depCheck} 2>$null ; if ($LASTEXITCODE -ne 0) { ${pipInstall} ; ${llamaInstall} 2>$null ; ${writeStampCmd} } ; ${startCmd}`);
          }
        } else {
          if (needsInstall) {
            terminal.sendText(`${cdCmd} && ${pipInstall} && (${llamaInstall} || true) && ${writeStampCmd} && ${startCmd}`);
          } else {
            terminal.sendText(`${cdCmd} && (${depCheck} 2>/dev/null || (${pipInstall} && (${llamaInstall} || true) && ${writeStampCmd})) && ${startCmd}`);
          }
        }
        terminal.show(true); // Show terminal so user can see startup progress
        markBrainStarting();
        sidebarProvider.updateBrainStatus(false, true);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand("kama.sendToAgent", async (prompt: string) => {
        await sendPromptToAgent(prompt);
      })
    );

    // ── Generate from Selection ───────────────────────────────────────
    context.subscriptions.push(
      vscode.commands.registerCommand("kama.generateFromSelection", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showInformationMessage("Kama: No active editor.");
          return;
        }
        const sel = editor.selection;
        const text = editor.document.getText(sel);
        const fileName = editor.document.fileName.split(/[\\/]/).pop() ?? "file";
        const lang = editor.document.languageId;

        let prefill: string;
        if (text.trim()) {
          prefill = `Regarding this ${lang} code from ${fileName}:\n\`\`\`${lang}\n${text.slice(0, 3000)}\n\`\`\`\n`;
        } else {
          // No selection - just open the sidebar with file context hint
          prefill = `Regarding ${fileName} (${lang}):\n`;
        }

        // Focus the sidebar and prefill - retry until webview is ready
        await vscode.commands.executeCommand("kama.vibePanel.focus");
        const maxWait = 3000;
        const step = 200;
        for (let waited = 0; waited < maxWait; waited += step) {
          await new Promise(r => setTimeout(r, step));
          if ((sidebarProvider as any)._view) { break; }
        }
        sidebarProvider.prefillInput(prefill);
      })
    );

    // ── Resilient Health Check + Auto-start ──────────────────────────
    // On first activation: if brain is unreachable, auto-start it silently.
    // During model setup: poll every 5 s and report download progress to UI.
    // _brainStartingAt: timestamp when startBrain was invoked - keeps UI in
    // "starting" state until brain responds OK or a generous timeout elapses.
    let failCount = 0;
    let wasOnline = false;
    let _autoStarted = false;
    let _brainStartingAt = 0;          // 0 = not starting
    const MAX_FAILS = 3;
    const START_TIMEOUT_MS = 120_000;   // 2 min - covers download + model load

    /** Mark brain as "starting" - called by the startBrain command. */
    function markBrainStarting(): void {
      _brainStartingAt = Date.now();
    }

    /** True while we're waiting for the brain to come online after startBrain. */
    function isBrainStarting(): boolean {
      return _brainStartingAt > 0 && Date.now() - _brainStartingAt < START_TIMEOUT_MS;
    }

    /** Clear the starting flag (brain came online or timed out). */
    function clearBrainStarting(): void {
      _brainStartingAt = 0;
    }

    async function doHealthCheck(): Promise<void> {
      try {
        const h = await brainClient.healthCheck();
        if (h.ok) {
          failCount = 0;
          wasOnline = true;
          clearBrainStarting();
          sidebarProvider.updateBrainStatus(true);
        } else if (h.setup) {
          failCount = 0;
          sidebarProvider.updateBrainStatus(false, true, h.setupPct, h.setupModel);
        } else {
          failCount++;
          if (wasOnline && failCount >= MAX_FAILS) {
            wasOnline = false;
          }
          // If we recently triggered startBrain, keep showing "starting" state
          if (isBrainStarting()) {
            sidebarProvider.updateBrainStatus(false, true);
          } else {
            sidebarProvider.updateBrainStatus(false);
            if (!_autoStarted && failCount >= MAX_FAILS) {
              _autoStarted = true;
              vscode.commands.executeCommand("kama.startBrain");
            }
          }
        }
      } catch {
        failCount++;
        if (isBrainStarting()) {
          sidebarProvider.updateBrainStatus(false, true);
        } else {
          sidebarProvider.updateBrainStatus(false);
          if (!_autoStarted && failCount >= MAX_FAILS) {
            _autoStarted = true;
            vscode.commands.executeCommand("kama.startBrain");
          }
        }
      }
    }

    doHealthCheck();
    _healthInterval = setInterval(doHealthCheck, 5_000);
    context.subscriptions.push({ dispose: () => { if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; } } });

    console.log("[Kama] Activated - 100% local mode.");
  } catch (err) {
    console.error("[Kama] Activation failed:", err);
    vscode.window.showErrorMessage(`Kama activation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function sendPromptToAgent(prompt: string): Promise<void> {
  await vscode.env.clipboard.writeText(prompt);

  // Detect which IDE we're running in and use the best strategy
  const ide = await detectIDE();

  try {
    switch (ide) {
      case "cursor":
        await sendToCursor(prompt);
        return;
      case "windsurf":
        await sendToWindsurf(prompt);
        return;
      case "claude-code":
        await sendToClaudeCode(prompt);
        return;
      case "copilot":
        await sendToCopilot(prompt);
        return;
      default:
        await sendToGenericChat(prompt);
        return;
    }
  } catch {
    // All IDE-specific strategies failed, use clipboard fallback
    vscode.window.showInformationMessage(
      `Prompt copied to clipboard! Paste it in your AI agent. (Detected IDE: ${ide})`
    );
  }
}

/**
 * Detect which AI IDE/editor we're running in.
 * Checks appName first, then probes for IDE-specific commands.
 */
async function detectIDE(): Promise<"cursor" | "windsurf" | "claude-code" | "copilot" | "vscode"> {
  if (_cachedIDE) { return _cachedIDE; }
  const appName = vscode.env.appName.toLowerCase();

  // Direct name detection
  if (appName.includes("cursor")) { _cachedIDE = "cursor"; return _cachedIDE; }
  if (appName.includes("windsurf") || appName.includes("codeium") || appName.includes("antigravity")) { _cachedIDE = "windsurf"; return _cachedIDE; }
  if (appName.includes("claude")) { _cachedIDE = "claude-code"; return _cachedIDE; }

  // Probe for IDE-specific commands
  const commands = await vscode.commands.getCommands(true);
  const cmdSet = new Set(commands);

  if (cmdSet.has("composerMode.agent") || cmdSet.has("cursor.newComposer")) { _cachedIDE = "cursor"; return _cachedIDE; }
  if (cmdSet.has("codeium.openChat") || cmdSet.has("windsurf.openChat")) { _cachedIDE = "windsurf"; return _cachedIDE; }
  if (cmdSet.has("claude.newConversation") || cmdSet.has("claudeCode.startTask")) { _cachedIDE = "claude-code"; return _cachedIDE; }
  if (cmdSet.has("github.copilot.chat.open") || cmdSet.has("workbench.action.chat.open")) { _cachedIDE = "copilot"; return _cachedIDE; }

  _cachedIDE = "vscode";
  return _cachedIDE;
}

async function sendToCursor(prompt: string): Promise<void> {
  // Cursor: Open composer in agent mode and paste
  try {
    await vscode.commands.executeCommand("composerMode.agent");
    await delay(300);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } catch {
    // Fallback: Try Cursor's newer command API
    try {
      await vscode.commands.executeCommand("cursor.newComposer", prompt);
    } catch {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
    }
  }
}

async function sendToWindsurf(prompt: string): Promise<void> {
  // Windsurf/Antigravity/Codeium: Open chat panel and paste
  try {
    await vscode.commands.executeCommand("codeium.openChat");
    await delay(400);
    await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
  } catch {
    try {
      await vscode.commands.executeCommand("windsurf.openChat");
      await delay(400);
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
    } catch {
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
    }
  }
}

async function sendToClaudeCode(prompt: string): Promise<void> {
  // Claude Code (Anthropic's IDE): Use task/conversation API
  try {
    await vscode.commands.executeCommand("claude.newConversation", prompt);
  } catch {
    try {
      await vscode.commands.executeCommand("claudeCode.startTask", prompt);
    } catch {
      // Claude Code may also support standard VS Code chat
      await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
    }
  }
}

async function sendToCopilot(prompt: string): Promise<void> {
  // GitHub Copilot Chat (VS Code native)
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
  } catch {
    try {
      await vscode.commands.executeCommand("github.copilot.chat.open", { query: prompt });
    } catch {
      throw new Error("Copilot chat not available");
    }
  }
}

async function sendToGenericChat(prompt: string): Promise<void> {
  // Generic fallback: try any available chat panel
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", { query: prompt });
  } catch {
    vscode.window.showInformationMessage("Prompt copied to clipboard! Paste it in your AI agent.");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function deactivate(): void {
  if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; }
  _cachedIDE = null;
  brainClient?.abort();
  // Kill brain terminal so the Python process doesn't linger after extension closes
  const brainTerminals = vscode.window.terminals.filter(t => t.name === "Kama Brain");
  for (const t of brainTerminals) { t.dispose(); }
  console.log("[Kama] Deactivated.");
}
