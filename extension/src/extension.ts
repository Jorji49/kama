/**
 * Aether — Main Extension Entry Point
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
import { AetherConfig } from "./utils/config";

let brainClient: BrainClient;
let _healthInterval: ReturnType<typeof setInterval> | null = null;

export function activate(context: vscode.ExtensionContext): void {
  brainClient = new BrainClient(AetherConfig.brainServerUrl);
  const sidebarProvider = new SidebarProvider(context.extensionUri, brainClient, context);

  // ── Register Sidebar ──────────────────────────────────────────────
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "aether.vibePanel",
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("aether.sendVibe", async () => {
      const input = await vscode.window.showInputBox({
        prompt: "Enter your vibe...",
        placeHolder: "e.g. create a login page, add dark mode",
      });
      if (input) { await sidebarProvider.handleVibe(input); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aether.startBrain", async () => {
      // Find brain folder — search workspace first (dev), then bundled, then others
      let brainPath = "";
      const hasBrain = (dir: string) => fs.existsSync(path.join(dir, "sslm_engine.py"));

      // 1. Workspace folder (development — always prefer this for fresh code)
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
          "Aether: Brain folder not found. Open the Aether project as your workspace.",
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
      const pythonCmd = process.platform === "win32" ? "python" : "python3";
      try {
        cp.execSync(`${pythonCmd} --version`, { timeout: 5000, stdio: "pipe" });
      } catch {
        vscode.window.showErrorMessage(
          "Aether requires Python 3.10+. Install Python from python.org and restart VS Code.",
          "Download Python"
        ).then(pick => {
          if (pick === "Download Python") {
            vscode.env.openExternal(vscode.Uri.parse("https://www.python.org/downloads/"));
          }
        });
        return;
      }

      // Kill existing Aether Brain terminal to avoid stale sessions / port conflicts
      const existing = vscode.window.terminals.find(t => t.name === "Aether Brain");
      if (existing) { existing.dispose(); }
      // Small delay to let the old terminal fully close before creating a new one
      await new Promise(r => setTimeout(r, 500));
      const terminal = vscode.window.createTerminal({ name: "Aether Brain" });

      const isWin = process.platform === "win32";
      const sep = isWin ? " ; " : " && ";
      const cdCmd = isWin ? `cd "${brainPath}"` : `cd '${brainPath}'`;
      // Check if deps are already installed before running pip install (much faster restart)
      const depCheck = `${pythonCmd} -c "import fastapi, llama_cpp"`;
      const pipInstall = `${pythonCmd} -m pip install -r requirements.txt --quiet`;
      const startCmd = `${pythonCmd} sslm_engine.py`;
      if (isWin) {
        // PowerShell: check exit code properly — try/catch doesn't catch non-terminating errors
        terminal.sendText(`${cdCmd} ; ${depCheck} 2>$null ; if ($LASTEXITCODE -ne 0) { ${pipInstall} } ; ${startCmd}`);
      } else {
        // Bash: short-circuit — only pip install if import fails
        terminal.sendText(`${cdCmd} && (${depCheck} 2>/dev/null || ${pipInstall}) && ${startCmd}`);
      }
      terminal.show(true); // Show terminal so user can see startup progress
      sidebarProvider.updateBrainStatus(false, true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("aether.sendToAgent", async (prompt: string) => {
      await sendPromptToAgent(prompt);
    })
  );

  // ── Generate from Selection ───────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("aether.generateFromSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("Aether: No active editor.");
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
        // No selection — just open the sidebar with file context hint
        prefill = `Regarding ${fileName} (${lang}):\n`;
      }

      // Focus the sidebar and prefill — retry until webview is ready
      await vscode.commands.executeCommand("aether.vibePanel.focus");
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
  let failCount = 0;
  let wasOnline = false;
  let _autoStarted = false;
  const MAX_FAILS = 3;

  async function doHealthCheck(): Promise<void> {
    try {
      const h = await brainClient.healthCheck();
      if (h.ok) {
        failCount = 0;
        wasOnline = true;
        sidebarProvider.updateBrainStatus(true);
      } else if (h.setup) {
        failCount = 0;
        sidebarProvider.updateBrainStatus(false, true, h.setupPct, h.setupModel);
      } else {
        failCount++;
        if (wasOnline && failCount >= MAX_FAILS) {
          wasOnline = false;
        }
        sidebarProvider.updateBrainStatus(false);
        if (!_autoStarted && failCount >= 1) {
          _autoStarted = true;
          vscode.commands.executeCommand("aether.startBrain");
        }
      }
    } catch {
      failCount++;
      sidebarProvider.updateBrainStatus(false);
      if (!_autoStarted && failCount >= 1) {
        _autoStarted = true;
        vscode.commands.executeCommand("aether.startBrain");
      }
    }
  }

  doHealthCheck();
  _healthInterval = setInterval(doHealthCheck, 5_000);
  context.subscriptions.push({ dispose: () => { if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; } } });

  console.log("[Aether] Activated — 100% local mode.");
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
  const appName = vscode.env.appName.toLowerCase();

  // Direct name detection
  if (appName.includes("cursor")) { return "cursor"; }
  if (appName.includes("windsurf") || appName.includes("codeium") || appName.includes("antigravity")) { return "windsurf"; }
  if (appName.includes("claude")) { return "claude-code"; }

  // Probe for IDE-specific commands
  const commands = await vscode.commands.getCommands(true);
  const cmdSet = new Set(commands);

  if (cmdSet.has("composerMode.agent") || cmdSet.has("cursor.newComposer")) { return "cursor"; }
  if (cmdSet.has("codeium.openChat") || cmdSet.has("windsurf.openChat")) { return "windsurf"; }
  if (cmdSet.has("claude.newConversation") || cmdSet.has("claudeCode.startTask")) { return "claude-code"; }
  if (cmdSet.has("github.copilot.chat.open") || cmdSet.has("workbench.action.chat.open")) { return "copilot"; }

  return "vscode";
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
  brainClient?.abort();
  console.log("[Aether] Deactivated.");
}
