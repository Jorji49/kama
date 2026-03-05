/**
 * Kama - Sidebar Provider (v4.0)
 * Hardware-aware setup · Streaming token display · Quick-action chips
 * o3/reasoning model support · Perfect prompt rendering
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import { BrainClient, PromptResponse, HardwareProfileResponse, ContextResponse } from "../services/BrainClient";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "kama.vibePanel";
  private _view?: vscode.WebviewView;
  private _selectedAgent = "auto";
  private _selectedFamily = "auto";
  private _cancelStream: (() => void) | null = null;
  private _wasOnline = false; // track brain online state to refresh only on transition

  constructor(
    private readonly _extUri: vscode.Uri,
    private readonly _brain: BrainClient,
    private readonly _ctx: vscode.ExtensionContext
  ) {
    this._selectedAgent = this._ctx.globalState.get<string>("kama.agent", "auto");
    this._selectedFamily = this._ctx.globalState.get<string>("kama.family", "auto");
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this._view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this._extUri] };
    view.webview.html = this._html(view.webview);

    // Re-scan context when workspace becomes visible
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this._loadContext();
        this._updateFileContext();
      }
    });

    // Track active file for context badge (dispose properly)
    const editorSub = vscode.window.onDidChangeActiveTextEditor(() => {
      if (this._view?.visible) { this._updateFileContext(); }
    });
    view.onDidDispose(() => editorSub.dispose());

    view.webview.onDidReceiveMessage(async (m) => {
      switch (m.command) {
        case "ready": {
          // Webview JS has loaded - safe to send initial state
          const setupDone = this._ctx.globalState.get<boolean>("kama.setupDone", false);
          this._brain.healthCheck().then(h => {
            const ok = h.ok;
            this._post({ command: "status", online: ok, starting: h.setup, setupPct: h.setupPct, setupModel: h.setupModel });
            this._post({ command: "setAgent", agentId: this._selectedAgent, family: this._selectedFamily });
            const saved = this._ctx.globalState.get<string[]>("kama.h", []);
            if (saved.length) { this._post({ command: "restore", h: saved }); }
            // Only show setup if it was never completed - don't re-show just because brain is offline
            if (!setupDone) {
              this._post({ command: "showSetup" });
              if (ok) { this._loadAll(); }
            } else {
              const tutDone = this._ctx.globalState.get<boolean>("kama.tutorialDone", false);
              if (!tutDone) {
                this._post({ command: "showTutorial" });
              }
              if (ok) {
                this._loadAll();
                this._loadContext();
              }
            }
            // If setupDone && !ok → stay on chat view, offline banner handles it
          }).catch(() => {
            this._post({ command: "status", online: false });
          });
          break;
        }
        case "vibe": await this.handleVibe(m.text); break;
        case "stop":
          if (this._cancelStream) { this._cancelStream(); this._cancelStream = null; }
          this._brain.abort();
          this._post({ command: "stopped" });
          break;
        case "copy":
          await vscode.env.clipboard.writeText(m.prompt);
          this._post({ command: "copied" });
          break;
        case "agent":
          await vscode.commands.executeCommand("kama.sendToAgent", m.prompt);
          this._post({ command: "agentSent" });
          break;
        case "save": await this._ctx.globalState.update("kama.h", m.h); break;
        case "settings": vscode.commands.executeCommand("workbench.action.openSettings", "kama"); break;
        case "loadModels": await this._loadAll(); break;
        case "loadHardware": await this._loadHardware(); break;
        case "selectModel": await this._selectModel(m.model); break;
        case "pullModel": await this._pullModel(m.model); break;
        case "finishSetup":
          await this._ctx.globalState.update("kama.setupDone", true);
          break;
        case "finishTutorial":
          await this._ctx.globalState.update("kama.tutorialDone", true);
          break;
        case "openSetup":
          this._post({ command: "showSetup" });
          this._loadAll();
          break;
        case "selectAgent":
          this._selectedAgent = m.agentId || "auto";
          this._selectedFamily = m.family || "auto";
          await this._ctx.globalState.update("kama.agent", this._selectedAgent);
          await this._ctx.globalState.update("kama.family", this._selectedFamily);
          break;
        case "startBrain":
          await vscode.commands.executeCommand("kama.startBrain");
          break;
        case "chain":
          this._chainContext = m.prompt || "";
          this._post({ command: "chainSet", preview: (m.prompt || "").slice(0, 80) });
          break;
        case "clearChain":
          this._chainContext = "";
          break;
        case "getHistory": {
          const allH = this._ctx.globalState.get<any[]>("kama.history", []);
          this._post({ command: "historyData", items: allH });
          break;
        }
        case "toggleFav": {
          const hist = this._ctx.globalState.get<any[]>("kama.history", []);
          const idx = hist.findIndex((h: any) => h.id === m.id);
          if (idx >= 0) { hist[idx].fav = !hist[idx].fav; }
          await this._ctx.globalState.update("kama.history", hist);
          this._post({ command: "historyData", items: hist });
          break;
        }
        case "deleteHistItem": {
          let hh = this._ctx.globalState.get<any[]>("kama.history", []);
          hh = hh.filter((h: any) => h.id !== m.id);
          await this._ctx.globalState.update("kama.history", hh);
          this._post({ command: "historyData", items: hh });
          break;
        }
        case "saveHist": {
          const cur = this._ctx.globalState.get<any[]>("kama.history", []);
          cur.unshift(m.item);
          await this._ctx.globalState.update("kama.history", cur.slice(0, 100));
          break;
        }
        case "prefill":
          this._post({ command: "prefillInput", text: m.text || "" });
          break;
      }
    });
  }

  public updateBrainStatus(online: boolean, starting: boolean = false, setupPct: number = 0, setupModel: string = ""): void {
    this._post({ command: "status", online, starting, setupPct, setupModel });
    // When brain transitions from offline → online, auto-refresh model catalog and context (once)
    if (online && !this._wasOnline) {
      this._wasOnline = true;
      this._loadAll();
      this._loadContext();
    }
    if (!online && !starting) {
      this._wasOnline = false;
    }
  }

  private _chainContext = "";

  public prefillInput(text: string): void {
    this._post({ command: "prefillInput", text });
  }

  public async handleVibe(vibe: string): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";

    // Cancel any in-flight stream
    if (this._cancelStream) {
      this._cancelStream();
      this._cancelStream = null;
    }

    // Read active file context
    let activeFile = "";
    let activeFileName = "";
    let activeFileLang = "";
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const doc = editor.document;
      activeFile = doc.getText().slice(0, 60000);
      activeFileName = doc.fileName.split(/[\\/]/).pop() ?? "";
      activeFileLang = doc.languageId;
    }

    this._post({ command: "loading", on: true });

    const chainCtx = this._chainContext;
    // Don't consume chain context yet - only if stream succeeds

    try {
      this._cancelStream = this._brain.sendVibeStream(
        vibe, ws, this._selectedFamily,
        (event) => {
          if (event.type === "token") {
            this._post({ command: "token", text: event.text ?? "" });
          } else if (event.type === "done" || event.type === "fallback") {
            this._cancelStream = null;
            this._chainContext = ""; // consume chain on success
            const prompt = event.prompt ?? event.text ?? "";
            this._post({
              command: "result",
              prompt,
              ms: event.ms ?? 0,
              model: event.model ?? "",
              agent: event.agent ?? this._selectedFamily,
              quality: event.quality ?? 0,
              grade: event.grade ?? "",
              security: event.security ?? "PASS",
            });
            const autoSend = vscode.workspace.getConfiguration("kama").get<boolean>("autoSendToAgent", false);
            if (autoSend) {
              vscode.commands.executeCommand("kama.sendToAgent", prompt);
            }
          } else if (event.type === "error") {
            this._cancelStream = null;
            this._post({ command: "err", msg: event.message ?? "Unknown error" });
            this._post({ command: "loading", on: false });
          } else if (event.type === "end") {
            // Stream closed without a done/error event - unlock UI cleanly
            this._cancelStream = null;
            this._post({ command: "loading", on: false });
          }
        },
        chainCtx,
        activeFile,
        activeFileName,
        activeFileLang
      );
    } catch (e: unknown) {
      this._post({ command: "err", msg: e instanceof Error ? e.message : String(e) });
      this._post({ command: "loading", on: false });
    }
  }

  private _updateFileContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === "file") {
      const name = editor.document.fileName.split(/[\\/]/).pop() ?? "";
      this._post({ command: "showFileContext", fileName: name });
    } else {
      this._post({ command: "showFileContext", fileName: "" });
    }
  }

  // Static catalog - used as fallback when Brain is offline
  private static readonly FALLBACK_CATALOG = [
    { name: "llama3.2-3b", desc: "\u2B50 Recommended \u2014 Great quality/speed balance.", size: "2.0 GB", installed: false },
    { name: "llama3.2-1b", desc: "\u26A1 Fast \u2014 Quick prompt generation, low RAM.", size: "1.3 GB", installed: false },
    { name: "phi3.5-mini", desc: "Strong reasoning. High quality prompts.", size: "2.4 GB", installed: false },
    { name: "gemma2-2b", desc: "Efficient multilingual. Good balance.", size: "1.6 GB", installed: false },
  ];

  private async _loadAll(): Promise<void> {
    try {
      const [installed, catalog] = await Promise.all([
        this._brain.listModels().catch(() => ({ models: [], current: "" })),
        this._brain.catalogModels().catch(() => ({ catalog: [] as { name: string; desc: string; size: string; installed: boolean }[] })),
      ]);
      const cat = catalog.catalog?.length ? catalog.catalog : SidebarProvider.FALLBACK_CATALOG;
      this._post({ command: "allModels", installed: installed.models, current: installed.current, catalog: cat });
      // Load hardware asynchronously
      this._loadHardware().catch(() => {});
    } catch {
      this._post({ command: "allModels", installed: [], current: "", catalog: SidebarProvider.FALLBACK_CATALOG });
    }
  }

  private async _loadHardware(): Promise<void> {
    try {
      const hw = await this._brain.getHardware();
      this._post({ command: "hardware", data: hw });
    } catch {
      // Hardware profile unavailable - silently ignore
    }
  }

  private async _loadContext(): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { return; }
    try {
      await this._brain.scanContext(ws);
    } catch { /* silently ignore */ }
  }

  private async _selectModel(model: string): Promise<void> {
    try {
      await this._brain.setModel(model);
      await vscode.workspace.getConfiguration("kama").update("model", model, vscode.ConfigurationTarget.Global);
      this._post({ command: "modelSet", model });
    } catch (e: unknown) {
      this._post({ command: "err", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  private async _pullModel(model: string): Promise<void> {
    this._post({ command: "pullStart", model });
    try {
      const res = await this._brain.pullModel(model, (pct, status) => {
        this._post({ command: "pullProgress", model, pct, status });
      });
      if (res.status === "ok") {
        this._post({ command: "pullDone", model });
        this._loadAll();
      } else {
        this._post({ command: "pullFail", model, msg: res.message ?? "Unknown error" });
      }
    } catch (e: unknown) {
      this._post({ command: "pullFail", model, msg: e instanceof Error ? e.message : String(e) });
    }
  }

  private _post(m: Record<string, unknown>): void { this._view?.webview.postMessage(m); }

  private static readonly LLAMA = `<svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M35 85V55C35 40 40 30 50 25C60 30 65 40 65 55V85" stroke="currentColor" stroke-width="3" fill="none"/><path d="M39 35V15C39 10 42 8 44 12L43 30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M61 35V15C61 10 58 8 56 12L57 30" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="43" cy="45" r="3.5" fill="currentColor"/><circle cx="57" cy="45" r="3.5" fill="currentColor"/><ellipse cx="50" cy="58" rx="5" ry="3.5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="48" cy="57" r="1" fill="currentColor"/><circle cx="52" cy="57" r="1" fill="currentColor"/><path d="M47 63Q50 66 53 63" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`;

  private _html(wv: vscode.Webview): string {
    const n = crypto.randomBytes(24).toString('base64url');
    const L = SidebarProvider.LLAMA;
    const L20 = L.replace('viewBox=', 'style="width:20px;height:20px" viewBox=');
    const L40 = L.replace('viewBox=', 'style="width:40px;height:40px" viewBox=');
    const L56 = L.replace('viewBox=', 'style="width:56px;height:56px" viewBox=');

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${wv.cspSource}; style-src ${wv.cspSource} 'nonce-${n}'; script-src 'nonce-${n}';">
<style nonce="${n}">
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#000;--s1:#0a0a0a;--s2:#111;--s3:#1a1a1a;--border:#1a1a1a;--border2:#2a2a2a;--t:#fff;--t2:#b0b0b0;--t3:#666;--t4:#444;--ok:#22c55e;--err:#ef4444;--blue:#3b82f6;--r:10px;--f:-apple-system,'Segoe UI',system-ui,sans-serif;--m:'SF Mono','Cascadia Code','Fira Code',Consolas,monospace}
html,body{height:100%;overflow:hidden}
body{font-family:var(--f);background:var(--bg);color:var(--t);display:flex;flex-direction:column;font-size:13px;-webkit-font-smoothing:antialiased}

/* ── Header ─────────────────────────── */
.hdr{padding:12px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)}
.hdr-logo{display:flex;align-items:center;gap:7px;flex:1}
.hdr-logo span{font-size:14px;font-weight:700;letter-spacing:-.3px}
.hdr-st{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--t3);font-weight:500}
.dot{width:6px;height:6px;border-radius:50%;transition:.3s}.dot.on{background:var(--ok)}.dot.off{background:var(--err)}
.ib{width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--t4);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s}
.ib:hover{background:var(--s2);color:var(--t)}
.ib svg{width:14px;height:14px}

/* ── Agent Selector ─────────────────── */
.aw{position:relative;z-index:100}
.ab{padding:8px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border);cursor:pointer;transition:background .1s;user-select:none}
.ab:hover{background:var(--s1)}
.ab-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;transition:background .2s}
.ab-name{flex:1;font-size:11px;font-weight:600;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ab-arrow{width:10px;height:10px;color:var(--t4);transition:transform .2s;flex-shrink:0}
.ab.open .ab-arrow{transform:rotate(180deg)}

.ap{position:absolute;top:100%;left:0;right:0;background:var(--s1);border:1px solid var(--border2);border-top:none;max-height:0;opacity:0;overflow:hidden;transition:max-height .2s ease,opacity .15s ease;box-shadow:0 12px 40px rgba(0,0,0,.6)}
.ap.open{max-height:65vh;opacity:1;overflow-y:auto}
.ap::-webkit-scrollbar{width:3px}.ap::-webkit-scrollbar-thumb{background:var(--border2);border-radius:3px}

.ap-auto{padding:9px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:background .1s;border-bottom:1px solid var(--border)}
.ap-auto:hover{background:var(--s2)}
.ap-auto.sel{background:var(--s2)}
.ap-auto .ap-ck{width:14px;height:14px;border-radius:50%;border:1.5px solid var(--border2);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s}
.ap-auto.sel .ap-ck{border-color:var(--ok);background:var(--ok)}
.ap-auto.sel .ap-ck::after{content:'';width:5px;height:5px;border-radius:50%;background:#fff}
.ap-auto-n{font-size:11px;font-weight:500;flex:1;color:var(--t2)}

.ag-hdr{padding:10px 14px 5px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--t4);display:flex;align-items:center;gap:6px}
.ag-dot{width:5px;height:5px;border-radius:50%;flex-shrink:0}

.ag-i{padding:7px 14px 7px 22px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:background .1s}
.ag-i:hover{background:var(--s2)}
.ag-i.sel{background:var(--s2)}
.ag-i-n{flex:1;font-size:11.5px;font-weight:500;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag-i-d{font-size:9px;color:var(--t4);flex-shrink:0;max-width:90px;text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ag-i-ck{width:13px;height:13px;border-radius:50%;border:1.5px solid var(--border2);display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s}
.ag-i.sel .ag-i-ck{border-color:var(--ok);background:var(--ok)}
.ag-i.sel .ag-i-ck::after{content:'';width:4.5px;height:4.5px;border-radius:50%;background:#fff}

.ag-sep{height:1px;background:var(--border);margin:4px 14px}

/* ── Views ──────────────────────────── */
.view{display:none;flex-direction:column;flex:1;overflow:hidden}.view.active{display:flex}

/* ── Setup ──────────────────────────── */
.setup{padding:24px 20px;overflow-y:auto;flex:1}
.setup::-webkit-scrollbar{width:3px}.setup::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.setup-logo{text-align:center;margin-bottom:16px}
.setup h2{font-size:18px;font-weight:700;text-align:center;margin-bottom:4px;letter-spacing:-.3px}
.setup .sub{font-size:12px;color:var(--t3);text-align:center;margin-bottom:20px;line-height:1.6}
.tabs{display:flex;gap:0;margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden}
.tab{flex:1;padding:8px;font-size:11px;font-weight:600;text-align:center;cursor:pointer;background:var(--s1);color:var(--t3);border:none;transition:.15s}
.tab.active{background:var(--s2);color:var(--t)}
.tab:not(:last-child){border-right:1px solid var(--border)}
.tab-panel{display:none}.tab-panel.active{display:block}
.model-list{display:flex;flex-direction:column;gap:5px}
.mi{padding:10px 12px;background:var(--s1);border:1px solid var(--border);border-radius:var(--r);cursor:pointer;display:flex;align-items:center;gap:10px;transition:.15s}
.mi:hover{background:var(--s2);border-color:var(--border2)}
.mi.selected{border-color:var(--t3)}
.mi-info{flex:1;min-width:0}
.mi-name{font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mi-desc{font-size:9px;color:var(--t3);margin-top:2px;line-height:1.4}
.mi-size{font-size:9px;color:var(--t4);font-family:var(--m);flex-shrink:0}
.mi-check{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--border2);flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:.15s}
.mi.selected .mi-check{border-color:var(--ok);background:var(--ok)}
.mi.selected .mi-check::after{content:'';width:6px;height:6px;border-radius:50%;background:#fff}
.mi-action{flex-shrink:0}
.dl-btn{padding:5px 10px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--t2);font-size:9px;font-weight:600;cursor:pointer;transition:.15s;font-family:var(--f)}
.dl-btn:hover{background:var(--s2);border-color:var(--border2);color:var(--t)}
.dl-btn.pulling{color:var(--blue);border-color:rgba(59,130,246,.2);pointer-events:none;min-width:90px;text-align:center;position:relative;overflow:hidden}
.dl-btn.pulling .dl-bar{position:absolute;left:0;top:0;bottom:0;background:rgba(59,130,246,.12);transition:width .3s;border-radius:6px}
.dl-btn.pulling .dl-txt{position:relative;z-index:1}
.dl-btn.done{color:var(--ok);border-color:rgba(34,197,94,.15);pointer-events:none}
.dl-btn.fail{color:var(--err);border-color:rgba(239,68,68,.15)}
.setup-msg{text-align:center;padding:16px;color:var(--t3);font-size:12px}
.setup-btn{width:100%;padding:12px;border-radius:var(--r);border:none;background:var(--t);color:var(--bg);font-size:13px;font-weight:600;cursor:pointer;transition:.15s;margin-top:14px}
.setup-btn:hover{opacity:.85}
.setup-btn:disabled{opacity:.2;cursor:default}
.setup-tip{font-size:9px;color:var(--t4);text-align:center;margin-top:10px;line-height:1.6}

/* ── Feed / Chat ────────────────────── */
.feed{flex:1;overflow-y:auto;padding:0}.feed::-webkit-scrollbar{width:3px}.feed::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;padding:40px 24px;text-align:center}
.empty h3{font-size:15px;font-weight:600;letter-spacing:-.2px}
.empty p{font-size:11px;line-height:1.7;color:var(--t3);max-width:230px}
.msg{padding:16px 18px;border-bottom:1px solid var(--border);animation:fi .15s ease}
@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.msg-u{background:var(--bg)}.msg-u .from{font-size:10px;font-weight:700;color:var(--t3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}.msg-u .body{font-size:13px;line-height:1.6;color:var(--t2)}
.msg-a{background:var(--s1)}.msg-a .from{font-size:10px;font-weight:700;color:var(--t3);margin-bottom:8px;display:flex;justify-content:space-between;text-transform:uppercase;letter-spacing:.5px}.msg-a .from .time{font-weight:500;color:var(--t4);font-size:9px;text-transform:none;letter-spacing:0}

.po{background:var(--bg);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:10px;font-family:var(--m);font-size:11px;line-height:1.9;color:var(--t2);white-space:pre-wrap;word-break:break-word;max-height:600px;overflow-y:auto;user-select:text}
.po::-webkit-scrollbar{width:2px}.po::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
.po .h{color:var(--t);font-weight:700}
.meta{display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap}
.tag{padding:2px 8px;border-radius:6px;font-size:9px;font-weight:500;color:var(--t3);background:var(--s3);font-family:var(--m)}
.acts{display:flex;gap:6px}
.btn{padding:7px 14px;border-radius:8px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s;font-family:var(--f);border:none}
.btn-w{background:var(--t);color:var(--bg)}.btn-w:hover{opacity:.85}
.btn-o{background:transparent;color:var(--t2);border:1px solid var(--border)}.btn-o:hover{background:var(--s2);color:var(--t)}
.btn-ok{background:transparent;color:var(--ok);border:1px solid rgba(34,197,94,.15);pointer-events:none}
.qbadge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:6px;font-size:9px;font-weight:600;font-family:var(--m)}
.qbadge.a{background:rgba(34,197,94,.12);color:#22c55e}
.qbadge.b{background:rgba(59,130,246,.12);color:#3b82f6}
.sbadge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:6px;font-size:9px;font-weight:600;font-family:var(--m)}
.sbadge.pass{background:rgba(34,197,94,.08);color:#22c55e}
.sbadge.warn{background:rgba(234,179,8,.12);color:#eab308}
.sbadge.fail{background:rgba(239,68,68,.12);color:#ef4444}
.msg-e{padding:14px 18px;border-bottom:1px solid var(--border)}
.msg-e .el{font-size:10px;font-weight:600;color:var(--err);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.msg-e .et{font-size:12px;color:var(--t3);line-height:1.5}

/* ── Loader ─────────────────────────── */
.loader{display:none;padding:16px 18px;align-items:center;gap:12px;border-bottom:1px solid var(--border);background:var(--s1)}
.loader.on{display:flex}
.spinner{width:16px;height:16px;border:2px solid var(--border2);border-top-color:var(--t2);border-radius:50%;animation:sp .6s linear infinite;flex-shrink:0}
@keyframes sp{to{transform:rotate(360deg)}}
.load-t{font-size:11px;color:var(--t2);font-weight:500}.load-s{font-size:9px;color:var(--t4);font-family:var(--m);margin-top:2px}
.stop{width:24px;height:24px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center}
.stop:hover{background:var(--s2);color:var(--t)}.stop svg{width:10px;height:10px}

/* ── Input ──────────────────────────── */
.input-area{padding:12px 16px;border-top:1px solid var(--border);background:var(--bg)}
.input-wrap{display:flex;gap:8px;align-items:flex-end}
textarea{flex:1;background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:10px 14px;color:var(--t);font-size:13px;font-family:var(--f);resize:none;outline:none;min-height:40px;max-height:200px;line-height:1.5;transition:.15s}
textarea:focus{border-color:var(--border2)}textarea::placeholder{color:var(--t4)}textarea:disabled{opacity:.3}
.send{width:34px;height:34px;border-radius:50%;border:none;background:var(--t);color:var(--bg);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:.15s}
.send:hover:not(:disabled){opacity:.85}.send:disabled{opacity:.1;cursor:default}
.send svg{width:14px;height:14px}

/* ── Footer ─────────────────────────── */
.foot{padding:5px 16px 7px;font-size:9px;color:var(--t4);display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border)}
.foot-left{display:flex;align-items:center;gap:6px;min-width:0;flex:1;overflow:hidden}
.foot-model{font-family:var(--m);cursor:pointer;padding:2px 6px;border-radius:4px;transition:.15s;flex-shrink:0}
.foot-model:hover{background:var(--s2);color:var(--t3)}
/* ── Offline Banner & Setup Progress ─────────── */
.offline-banner{display:none;padding:16px 20px;background:linear-gradient(135deg,var(--s1),var(--s2));border-bottom:1px solid var(--border);text-align:center;animation:fi .2s ease}
.offline-banner.show{display:block}
.offline-banner .ob-icon{margin-bottom:8px;color:var(--t4)}
.offline-banner .ob-title{font-size:13px;font-weight:600;color:var(--t);margin-bottom:4px}
.offline-banner .ob-desc{font-size:11px;color:var(--t3);line-height:1.5;margin-bottom:12px}
.start-brain-btn{width:100%;padding:10px 16px;border-radius:var(--r);border:none;background:var(--ok);color:#000;font-size:12px;font-weight:700;cursor:pointer;transition:.15s;font-family:var(--f);display:flex;align-items:center;justify-content:center;gap:8px}
.start-brain-btn:hover{opacity:.85}
.start-brain-btn:disabled{opacity:.4;cursor:default}
.start-brain-btn.starting{background:var(--blue);color:#fff}
.start-brain-btn svg{width:14px;height:14px}
/* Download progress */
.setup-progress{margin-top:8px}
.sp-label{font-size:11px;color:var(--t3);margin-bottom:6px}
.sp-track{height:4px;background:var(--border2);border-radius:2px;overflow:hidden}
.sp-fill{height:100%;background:var(--blue);border-radius:2px;transition:width .4s ease;width:0%}
/* Tutorial */
.tut{padding:28px 20px;overflow-y:auto;flex:1;display:flex;flex-direction:column;gap:0}
.tut-slide{display:none;flex-direction:column;align-items:center;text-align:center;gap:14px;animation:fi .2s ease}
.tut-slide.active{display:flex}
.tut-icon{width:48px;height:48px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:24px}
.tut-icon.i1{background:rgba(59,130,246,.12);color:#3b82f6}
.tut-icon.i2{background:rgba(34,197,94,.12);color:#22c55e}
.tut-icon.i3{background:rgba(168,85,247,.12);color:#a855f7}
.tut-icon.i4{background:rgba(234,179,8,.12);color:#eab308}
.tut h3{font-size:16px;font-weight:700;letter-spacing:-.3px}
.tut .tut-desc{font-size:12px;color:var(--t3);line-height:1.7;max-width:260px}
.tut .tut-tip{background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;text-align:left;font-size:11px;color:var(--t2);line-height:1.7;width:100%;margin-top:4px}
.tut .tut-tip b{color:var(--t);font-weight:600}
.tut .tut-tip code{font-family:var(--m);font-size:10px;background:var(--s3);padding:1px 5px;border-radius:4px;color:var(--blue)}
.tut-dots{display:flex;gap:6px;justify-content:center;margin:16px 0 8px}
.tut-dot{width:6px;height:6px;border-radius:50%;background:var(--border2);transition:.2s}
.tut-dot.on{background:var(--t);width:18px}
.tut-nav{display:flex;gap:8px;width:100%;margin-top:auto;padding-top:16px}
.tut-nav .btn{flex:1;padding:11px;border-radius:var(--r);font-size:12px;font-weight:600;text-align:center}
.tut-skip{background:transparent;color:var(--t3);border:1px solid var(--border);cursor:pointer}
.tut-skip:hover{background:var(--s1);color:var(--t2)}
.tut-next{background:var(--t);color:var(--bg);border:none;cursor:pointer}
.tut-next:hover{opacity:.85}
/* History */
.hist{flex:1;display:flex;flex-direction:column;overflow:hidden}
.hist-top{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center}
.hist-search{flex:1;background:var(--s1);border:1px solid var(--border);border-radius:var(--r);padding:8px 12px;color:var(--t);font-size:12px;font-family:var(--f);outline:none}
.hist-search:focus{border-color:var(--border2)}
.hist-search::placeholder{color:var(--t4)}
.hist-back{width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--t3);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.hist-back:hover{background:var(--s2);color:var(--t)}
.hist-list{flex:1;overflow-y:auto;padding:4px 0}
.hist-list::-webkit-scrollbar{width:3px}.hist-list::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.hi{padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;transition:.1s}
.hi:hover{background:var(--s1)}
.hi-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
.hi-vibe{font-size:11px;font-weight:600;color:var(--t2);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hi-star{width:20px;height:20px;border:none;background:none;cursor:pointer;color:var(--t4);font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.hi-star.on{color:#eab308}
.hi-del{width:20px;height:20px;border:none;background:none;cursor:pointer;color:var(--t4);font-size:11px;flex-shrink:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:.1s}
.hi:hover .hi-del{opacity:1}
.hi-del:hover{color:var(--err)}
.hi-preview{font-size:10px;color:var(--t3);line-height:1.5;max-height:40px;overflow:hidden;font-family:var(--m)}
.hi-meta{display:flex;gap:6px;margin-top:4px}
.hi-tag{font-size:9px;color:var(--t4);font-family:var(--m)}
.hist-empty{text-align:center;padding:40px 20px;color:var(--t4);font-size:12px}
/* Chain indicator */
.chain-bar{display:none;padding:6px 16px;background:var(--s1);border-top:1px solid var(--border);font-size:10px;color:var(--t3);align-items:center;gap:6px}
.chain-bar.show{display:flex}
.chain-bar .chain-label{color:var(--blue);font-weight:600}
.chain-bar .chain-preview{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chain-bar .chain-x{background:none;border:none;color:var(--t4);cursor:pointer;font-size:12px;padding:2px 4px}
.chain-bar .chain-x:hover{color:var(--t)}
/* File context badge */
.fc-badge{display:none;padding:4px 16px 0;font-size:9px;color:var(--t4);align-items:center;gap:4px}
.fc-badge.show{display:flex}
.fc-badge svg{width:10px;height:10px}
\n/* Streaming cursor */\n.streaming .stream-text::after{content:'\\u258C';animation:blink 1s step-end infinite;color:var(--blue)}\n@keyframes blink{50%{opacity:0}}\n/* Thinking animation */\n.thinking-dots span{animation:tdot 1.4s infinite;opacity:0}\n.thinking-dots span:nth-child(1){animation-delay:0s}\n.thinking-dots span:nth-child(2){animation-delay:.2s}\n.thinking-dots span:nth-child(3){animation-delay:.4s}\n@keyframes tdot{0%,80%,100%{opacity:0}40%{opacity:1}}\n.thinking-msg .po{color:var(--t3);font-style:italic}
</style>
</head>
<body>

<!-- Header -->
<div class="hdr">
  <div class="hdr-logo">${L20}<span>Kama</span></div>
  <div class="hdr-st"><span class="dot off" id="D"></span><span id="SL">Offline</span></div>
  <button class="ib" id="bHist" title="Prompt History"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></button>
  <button class="ib" id="bSet" title="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg></button>
  <button class="ib" id="bClr" title="Clear chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>
</div>

<!-- Agent Selector -->
<div class="aw" id="AW">
  <div class="ab" id="AB">
    <span class="ab-dot" id="abDot" style="background:#666"></span>
    <span class="ab-name" id="abName">Auto - Universal</span>
    <svg class="ab-arrow" viewBox="0 0 10 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 1l4 4 4-4"/></svg>
  </div>
  <div class="ap" id="AP"></div>
</div>

<!-- Setup View -->
<div class="view" id="V_SETUP">
  <div class="setup">
    <div class="setup-logo">${L56}</div>
    <h2>Welcome to Kama</h2>
    <p class="sub">100% local AI prompt optimizer.<br/>Select a model below - smaller models are faster, larger models produce better prompts.</p>
    <div class="tabs">
      <button class="tab active" data-tab="installed">Installed</button>
      <button class="tab" data-tab="available">Available</button>
    </div>
    <div class="tab-panel active" id="P_INSTALLED">
      <div class="model-list" id="ML_INST"><div class="setup-msg">Loading...</div></div>
    </div>
    <div class="tab-panel" id="P_AVAILABLE">
      <div class="model-list" id="ML_AVAIL"><div class="setup-msg">Loading...</div></div>
    </div>
    <button class="setup-btn" id="setupDone" disabled>Get Started</button>
    <p class="setup-tip">Models are stored locally in ~/.kama/models/</p>
  </div>
</div>

<!-- Offline Banner -->
<div class="offline-banner" id="OB">
  <div class="ob-icon" id="OB_ICON"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>
  <div class="ob-title" id="OB_TITLE">Brain Server Offline</div>
  <div class="ob-desc" id="OB_DESC">Kama Brain is not running.<br/>It will start automatically when found.</div>
  <div class="setup-progress" id="OB_PROG" style="display:none">
    <div class="sp-label" id="OB_PROG_LBL">Downloading model... 0%</div>
    <div class="sp-track"><div class="sp-fill" id="OB_PROG_FILL"></div></div>
  </div>
  <button class="start-brain-btn" id="bStartBrain">
    <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    <span id="bStartTxt">Start Brain Server</span>
  </button>
</div>

<!-- Tutorial View -->
<div class="view" id="V_TUT">
  <div class="tut">
    <div class="tut-slide active" data-slide="0">
      <div class="tut-icon i1">&#9889;</div>
      <h3>Welcome to Kama</h3>
      <p class="tut-desc">Kama transforms your ideas into perfectly crafted prompts for any AI coding assistant - 100% locally on your machine.</p>
      <div class="tut-tip"><b>How it works:</b> Describe what you want to build, pick a target AI model, and Kama generates a production-quality prompt optimized for that model.</div>
    </div>
    <div class="tut-slide" data-slide="1">
      <div class="tut-icon i2">&#128193;</div>
      <h3>Project-Aware Prompts</h3>
      <p class="tut-desc">If you open Kama inside a project workspace, it automatically detects your tech stack and languages.</p>
      <div class="tut-tip"><b>Pro tip:</b> Open your project folder in VS Code <b>before</b> using Kama. It will detect files like <code>package.json</code>, <code>requirements.txt</code>, <code>Cargo.toml</code> etc. and include your tech stack as context in the prompt.</div>
    </div>
    <div class="tut-slide" data-slide="2">
      <div class="tut-icon i3">&#127919;</div>
      <h3>Choose Your AI Target</h3>
      <p class="tut-desc">Each AI has different strengths. Pick which AI you'll paste the prompt into - Kama optimizes the output accordingly.</p>
      <div class="tut-tip"><b>Claude</b> - constraint-rich, thorough<br/><b>GPT</b> - persona-driven, versatile<br/><b>Gemini</b> - reasoning-focused<br/><b>Grok</b> - ultra-concise<br/><b>Auto</b> - works with any AI</div>
    </div>
    <div class="tut-slide" data-slide="3">
      <div class="tut-icon i4">&#128161;</div>
      <h3>Write Better Prompts</h3>
      <p class="tut-desc">The more detail you give, the better the output. Be specific about what you want.</p>
      <div class="tut-tip"><b>Instead of:</b> "make a login page"<br/><br/><b>Try:</b> "Build a login page with email/password auth, input validation, rate limiting, remember me checkbox, and forgot password flow. Use JWT tokens."</div>
    </div>
    <div class="tut-dots" id="tutDots"><span class="tut-dot on"></span><span class="tut-dot"></span><span class="tut-dot"></span><span class="tut-dot"></span></div>
    <div class="tut-nav">
      <button class="btn tut-skip" id="tutSkip">Skip</button>
      <button class="btn tut-next" id="tutNext">Next</button>
    </div>
  </div>
</div>

<!-- Chat View -->
<div class="view active" id="V_CHAT">
  <div class="feed" id="F">
    <div class="empty" id="E">
      ${L40}
      <h3>What do you want to build?</h3>
      <p>Describe your idea. Kama turns it into a perfect prompt for your AI agent.</p>
    </div>
  </div>
  <div class="loader" id="LDR">
    <div class="spinner"></div>
    <div style="flex:1"><div class="load-t">Generating prompt...</div><div class="load-s" id="LTM">0s</div></div>
    <button class="stop" id="bStop"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></button>
  </div>
  <div class="chain-bar" id="chainBar">
    <span class="chain-label">&#x1F517; Chain:</span>
    <span class="chain-preview" id="chainPreview"></span>
    <button class="chain-x" id="chainX">&times;</button>
  </div>
  <div class="fc-badge" id="fcBadge">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
    <span id="fcFileName"></span>
  </div>
  <div class="input-area">
    <div class="input-wrap">
      <textarea id="I" rows="1" placeholder="Message Kama..."></textarea>
      <button class="send" id="G"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
    </div>
  </div>
</div>

<!-- History View -->
<div class="view" id="V_HIST">
  <div class="hist">
    <div class="hist-top">
      <button class="hist-back" id="histBack"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <input class="hist-search" id="histSearch" type="text" placeholder="Search prompts..."/>
    </div>
    <div class="hist-list" id="histList">
      <div class="hist-empty">No prompts yet. Generate your first prompt!</div>
    </div>
  </div>
</div>
<div class="foot">
  <div class="foot-left"><span>100% Local</span></div>
  <span class="foot-model" id="FM" title="Change model">kama</span>
</div>

<script nonce="${n}">
(function(){
  var vs=acquireVsCodeApi();
  function $(id){return document.getElementById(id)}
  var F=$('F'),E=$('E'),I=$('I'),G=$('G'),LDR=$('LDR'),LTM=$('LTM'),D=$('D'),SL=$('SL'),FM=$('FM');
  var VS=$('V_SETUP'),VC=$('V_CHAT'),OB=$('OB');
  var AB=$('AB'),AP=$('AP'),AW=$('AW');
  var brainStarting=false;
  var busy=0,ti=null,t0=0,hist=[],selModel='';
  var curAgent='auto',curFamily='auto',panelOpen=false;

  document.addEventListener('click',function(e){
    if(panelOpen&&!e.target.closest('.aw'))closePanel();
  });

  /* ── Agent data (matches Cursor's model list exactly) ── */
  var AG=[
    {l:'Anthropic',c:'#cc785c',a:[
      {i:'claude-opus-4.6',n:'Claude Opus 4.6',d:'Best reasoning',f:'claude'},
      {i:'claude-opus-4.5',n:'Claude Opus 4.5',d:'Deep analysis',f:'claude'},
      {i:'claude-sonnet-4.5',n:'Claude Sonnet 4.5',d:'Fast & smart',f:'claude'},
      {i:'claude-sonnet-4',n:'Claude Sonnet 4',d:'Balanced',f:'claude'},
      {i:'claude-haiku-4.5',n:'Claude Haiku 4.5',d:'Ultra fast',f:'claude'}
    ]},
    {l:'OpenAI',c:'#10a37f',a:[
      {i:'gpt-5.2-codex',n:'GPT-5.2-Codex',d:'Latest code',f:'gpt-codex'},
      {i:'gpt-5.2',n:'GPT-5.2',d:'Latest general',f:'gpt'},
      {i:'gpt-5.1-codex-max',n:'GPT-5.1-Codex-Max',d:'Max performance',f:'gpt-codex'},
      {i:'gpt-5.1-codex',n:'GPT-5.1-Codex',d:'Code specialist',f:'gpt-codex'},
      {i:'gpt-5.1-codex-mini',n:'GPT-5.1-Codex-Mini',d:'Fast code',f:'gpt-codex'},
      {i:'gpt-5.1',n:'GPT-5.1',d:'Strong general',f:'gpt'},
      {i:'gpt-5-codex',n:'GPT-5-Codex',d:'Code focused',f:'gpt-codex'},
      {i:'gpt-5',n:'GPT-5',d:'General purpose',f:'gpt'},
      {i:'gpt-5-mini',n:'GPT-5 mini',d:'Lightweight',f:'gpt'},
      {i:'gpt-4o',n:'GPT-4o',d:'Multimodal',f:'gpt'},
      {i:'gpt-4.1',n:'GPT-4.1',d:'Stable',f:'gpt'}
    ]},
    {l:'Google',c:'#4285f4',a:[
      {i:'gemini-3-pro',n:'Gemini 3 Pro',d:'Most capable',f:'gemini'},
      {i:'gemini-3-flash',n:'Gemini 3 Flash',d:'Fast & efficient',f:'gemini'},
      {i:'gemini-2.5-pro',n:'Gemini 2.5 Pro',d:'Long context',f:'gemini'}
    ]},
    {l:'Other',c:'#a0a0a0',a:[
      {i:'grok-code-fast-1',n:'Grok Code Fast 1',d:'Speed optimized',f:'grok'},
      {i:'raptor-mini',n:'Raptor mini',d:'Preview',f:'auto'}
    ]}
  ];

  /* ── Agent panel rendering ── */
  function renderPanel(){
    var h='<div class="ap-auto'+(curAgent==='auto'?' sel':'')+'" data-aid="auto" data-fam="auto">';
    h+='<div class="ap-ck"></div><div class="ap-auto-n">Auto - Universal</div></div>';
    for(var gi=0;gi<AG.length;gi++){
      var g=AG[gi];
      if(gi>0)h+='<div class="ag-sep"></div>';
      h+='<div class="ag-hdr"><span class="ag-dot" style="background:'+g.c+'"></span>'+g.l+'</div>';
      for(var ai=0;ai<g.a.length;ai++){
        var a=g.a[ai];
        h+='<div class="ag-i'+(curAgent===a.i?' sel':'')+'" data-aid="'+escAttr(a.i)+'" data-fam="'+escAttr(a.f)+'">';
        h+='<div class="ag-i-ck"></div>';
        h+='<div class="ag-i-n">'+esc(a.n)+'</div>';
        h+='<div class="ag-i-d">'+esc(a.d)+'</div>';
        h+='</div>';
      }
    }
    AP.innerHTML=h;
  }

  function findAgent(id){
    if(id==='auto')return{n:'Auto - Universal',c:'#666',f:'auto'};
    for(var gi=0;gi<AG.length;gi++){
      var g=AG[gi];
      for(var ai=0;ai<g.a.length;ai++){
        if(g.a[ai].i===id)return{n:g.a[ai].n,c:g.c,f:g.a[ai].f};
      }
    }
    return{n:'Auto - Universal',c:'#666',f:'auto'};
  }

  function updateBar(){
    var info=findAgent(curAgent);
    $('abName').textContent=info.n;
    $('abDot').style.background=info.c;
  }

  function openPanel(){panelOpen=true;AB.classList.add('open');AP.classList.add('open');renderPanel()}
  function closePanel(){panelOpen=false;AB.classList.remove('open');AP.classList.remove('open')}

  AB.addEventListener('click',function(e){
    e.stopPropagation();
    if(panelOpen)closePanel();else openPanel();
  });

  AP.addEventListener('click',function(e){
    var item=e.target.closest('[data-aid]');
    if(!item)return;
    curAgent=item.getAttribute('data-aid');
    curFamily=item.getAttribute('data-fam');
    updateBar();closePanel();
    vs.postMessage({command:'selectAgent',agentId:curAgent,family:curFamily});
  });

  document.querySelectorAll('.tab').forEach(function(t){
    t.addEventListener('click',function(){
      document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active')});
      document.querySelectorAll('.tab-panel').forEach(function(x){x.classList.remove('active')});
      t.classList.add('active');
      $(t.dataset.tab==='installed'?'P_INSTALLED':'P_AVAILABLE').classList.add('active');
    });
  });

  /* ── Input & send ── */
  I.addEventListener('input',function(){I.style.height='auto';I.style.height=Math.min(I.scrollHeight,200)+'px'});
  I.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();go()}});
  G.addEventListener('click',go);
  $('bStop').addEventListener('click',function(){vs.postMessage({command:'stop'})});
  $('bSet').addEventListener('click',function(){vs.postMessage({command:'settings'})});
  $('bStartBrain').addEventListener('click',function(){
    if(brainStarting)return;
    brainStarting=true;
    var btn=$('bStartBrain');
    btn.classList.add('starting');
    $('bStartTxt').textContent='Starting...';
    btn.disabled=true;
    vs.postMessage({command:'startBrain'});
  });
  $('bClr').addEventListener('click',function(){
    F.innerHTML='';F.appendChild(E);E.style.display='flex';hist=[];
    vs.postMessage({command:'save',h:[]});
  });
  FM.addEventListener('click',function(){vs.postMessage({command:'openSetup'})});
  $('setupDone').addEventListener('click',function(){
    if(!selModel)return;
    vs.postMessage({command:'selectModel',model:selModel});
    vs.postMessage({command:'finishSetup'});
    showView('tutorial');showTutSlide(0);
  });

  var VT=$('V_TUT'),VH=$('V_HIST');
  function showView(v){
    VS.classList.toggle('active',v==='setup');
    VC.classList.toggle('active',v==='chat');
    VT.classList.toggle('active',v==='tutorial');
    VH.classList.toggle('active',v==='history');
  }

  /* ── Tutorial ── */
  var tutSlide=0,tutTotal=4;
  function showTutSlide(n){
    tutSlide=n;
    document.querySelectorAll('.tut-slide').forEach(function(s){s.classList.toggle('active',parseInt(s.dataset.slide)===n)});
    document.querySelectorAll('.tut-dot').forEach(function(d,i){d.classList.toggle('on',i===n)});
    $('tutNext').textContent=n===tutTotal-1?'Get Started':'Next';
  }
  $('tutNext').addEventListener('click',function(){
    if(tutSlide<tutTotal-1){showTutSlide(tutSlide+1)}
    else{vs.postMessage({command:'finishTutorial'});showView('chat')}
  });
  $('tutSkip').addEventListener('click',function(){
    vs.postMessage({command:'finishTutorial'});showView('chat');
  });

  /* ── History ── */
  var histItems=[];
  $('bHist').addEventListener('click',function(){
    showView('history');
    vs.postMessage({command:'getHistory'});
  });
  $('histBack').addEventListener('click',function(){showView('chat')});
  $('histSearch').addEventListener('input',function(){renderHist()});

  function renderHist(){
    var c=$('histList'),q=($('histSearch').value||'').toLowerCase();
    var items=histItems;
    if(q)items=items.filter(function(h){return (h.vibe||'').toLowerCase().indexOf(q)>=0||(h.prompt||'').toLowerCase().indexOf(q)>=0});
    // Favs first, then by time
    items=items.slice().sort(function(a,b){if(a.fav&&!b.fav)return -1;if(!a.fav&&b.fav)return 1;return (b.ts||0)-(a.ts||0)});
    if(!items.length){c.innerHTML='<div class="hist-empty">'+(q?'No matches':'No prompts yet')+'</div>';return}
    c.innerHTML='';
    items.forEach(function(h){
      var d=document.createElement('div');d.className='hi';
      var dt=h.ts?new Date(h.ts).toLocaleDateString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'';
      var prev=(h.prompt||'').slice(0,120).replace(/\\n/g,' ');
      d.innerHTML='<div class="hi-head"><span class="hi-vibe">'+esc(h.vibe||'Untitled')+'</span>'
        +'<button class="hi-star'+(h.fav?' on':'')+'" data-fav="'+escAttr(h.id)+'" title="Favorite">'+(h.fav?'\\u2605':'\\u2606')+'</button>'
        +'<button class="hi-del" data-del="'+escAttr(h.id)+'" title="Delete">\\u2715</button></div>'
        +'<div class="hi-preview">'+esc(prev)+'</div>'
        +'<div class="hi-meta"><span class="hi-tag">'+esc(dt)+'</span>'
        +(h.agent&&h.agent!=='auto'?'<span class="hi-tag">'+esc(h.agent)+'</span>':'')
        +(h.grade?'<span class="hi-tag">'+esc(h.grade)+'</span>':'')
        +'</div>';
      d.addEventListener('click',function(e){
        if(e.target.closest('[data-fav]')){vs.postMessage({command:'toggleFav',id:h.id});return}
        if(e.target.closest('[data-del]')){vs.postMessage({command:'deleteHistItem',id:h.id});return}
        // Click on item → copy prompt to clipboard + show toast + switch to chat
        vs.postMessage({command:'copy',prompt:h.prompt||''});
        showView('chat');
        // Show brief toast
        var toast=document.createElement('div');
        toast.style.cssText='position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--s2);color:var(--t);border:1px solid var(--border2);padding:6px 14px;border-radius:8px;font-size:11px;font-weight:500;z-index:999;animation:fi .15s ease';
        toast.textContent='\u2713 Prompt copied to clipboard';
        document.body.appendChild(toast);
        setTimeout(function(){toast.remove()},1500);
      });
      c.appendChild(d);
    });
  }

  /* ── Chain ── */
  $('chainX').addEventListener('click',function(){
    $('chainBar').classList.remove('show');
    $('chainPreview').textContent='';
    vs.postMessage({command:'clearChain'});
  });

  /* ── File context badge ── */
  function updateFcBadge(name){
    var b=$('fcBadge');
    if(name){b.classList.add('show');$('fcFileName').textContent='Context: '+name}
    else{b.classList.remove('show')}
  }

  function go(){
    var t=I.value.trim();if(!t||busy)return;
    E.style.display='none';addU(t);lock();
    vs.postMessage({command:'vibe',text:t});
    I.value='';I.style.height='auto';
    // Auto-hide chain bar (chain context is consumed once)
    $('chainBar').classList.remove('show');
    $('chainPreview').textContent='';
  }
  function lock(){
    busy=1;I.disabled=true;G.disabled=true;LDR.classList.add('on');t0=Date.now();
    ti=setInterval(function(){LTM.textContent=((Date.now()-t0)/1000|0)+'s'},300);
    /* Show thinking indicator immediately */
    var thk=document.createElement('div');thk.className='msg msg-a thinking-msg';
    thk.innerHTML='<div class="from"><span>Kama</span></div><div class="po"><span class="thinking-dots">Thinking<span>.</span><span>.</span><span>.</span></span></div>';
    thk.id='_thk';E.style.display='none';F.appendChild(thk);sb();
  }
  function unlock(){
    busy=0;I.disabled=false;G.disabled=false;LDR.classList.remove('on');
    if(ti){clearInterval(ti);ti=null}LTM.textContent='0s';
    var thk=document.getElementById('_thk');if(thk)thk.remove();
    I.focus();
  }
  function esc(s){var d=document.createElement('div');d.textContent=s||'';return d.innerHTML}
  function escAttr(s){return esc(s).replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
  function sb(){requestAnimationFrame(function(){F.scrollTop=F.scrollHeight})}
  function hl(t){var h=esc(t);h=h.replace(/^(##? .+)$/gm,'<span class="h">$1</span>');return h}

  var _lastVibe='';
  function addU(t){
    _lastVibe=t;
    var d=document.createElement('div');d.className='msg msg-u';
    d.innerHTML='<div class="from">You</div><div class="body">'+esc(t)+'</div>';
    F.appendChild(d);sb();hist.push(JSON.stringify({r:'u',t:t}));save();
  }

  function addP(prompt,ms,model,agent,quality,grade,security){
    var d=document.createElement('div');d.className='msg msg-a';d.setAttribute('data-prompt',prompt);
    var now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    var info=findAgent(curAgent);
    var h='<div class="from"><span>Kama</span><span class="time">'+now+'</span></div>';
    h+='<div class="po">'+hl(prompt)+'</div>';
    h+='<div class="meta">';
    if(curAgent!=='auto')h+='<span class="tag">'+esc(info.n)+'</span>';
    if(model)h+='<span class="tag">'+esc(model)+'</span>';
    if(ms)h+='<span class="tag">'+(ms/1000).toFixed(1)+'s</span>';
    if(grade){var gc=grade.startsWith('A')?'a':grade.startsWith('B')?'b':'b';h+='<span class="qbadge '+gc+'">'+esc(grade)+'</span>'}
    if(security&&security!=='PASS'){var sc=security==='WARN'?'warn':'fail';h+='<span class="sbadge '+sc+'">\u26a0 '+esc(security)+'</span>'}else if(security==='PASS'){h+='<span class="sbadge pass">\u2713 Secure</span>'}
    h+='</div><div class="acts">';
    h+='<button class="btn btn-w" data-action="agent">Send to Agent</button>';
    h+='<button class="btn btn-o" data-action="chain">\u{1F517} Chain</button>';
    h+='<button class="btn btn-o" data-action="copy">Copy</button>';
    h+='</div>';
    d.innerHTML=h;F.appendChild(d);sb();
    hist.push(JSON.stringify({r:'p',t:prompt,ms:ms,m:model,a:curAgent,q:quality,g:grade,s:security}));save();
    // Persist to full history
    vs.postMessage({command:'saveHist',item:{id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),vibe:_lastVibe,prompt:prompt,agent:info.n,grade:grade||'',ts:Date.now(),fav:false}});
  }

  /* addPRestore - same as addP but skips saving to full history (prevents duplicates on restore) */
  function addPRestore(prompt,ms,model,agent,quality,grade,security){
    var d=document.createElement('div');d.className='msg msg-a';d.setAttribute('data-prompt',prompt);
    var now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
    var info=findAgent(curAgent);
    var h='<div class="from"><span>Kama</span><span class="time">'+now+'</span></div>';
    h+='<div class="po">'+hl(prompt)+'</div>';
    h+='<div class="meta">';
    if(curAgent!=='auto')h+='<span class="tag">'+esc(info.n)+'</span>';
    if(model)h+='<span class="tag">'+esc(model)+'</span>';
    if(ms)h+='<span class="tag">'+(ms/1000).toFixed(1)+'s</span>';
    if(grade){var gc=grade.startsWith('A')?'a':grade.startsWith('B')?'b':'b';h+='<span class="qbadge '+gc+'">'+esc(grade)+'</span>'}
    if(security&&security!=='PASS'){var sc=security==='WARN'?'warn':'fail';h+='<span class="sbadge '+sc+'">\u26a0 '+esc(security)+'</span>'}else if(security==='PASS'){h+='<span class="sbadge pass">\u2713 Secure</span>'}
    h+='</div><div class="acts">';
    h+='<button class="btn btn-w" data-action="agent">Send to Agent</button>';
    h+='<button class="btn btn-o" data-action="chain">\u{1F517} Chain</button>';
    h+='<button class="btn btn-o" data-action="copy">Copy</button>';
    h+='</div>';
    d.innerHTML=h;F.appendChild(d);sb();
    hist.push(JSON.stringify({r:'p',t:prompt,ms:ms,m:model,a:curAgent,q:quality,g:grade,s:security}));save();
  }

  function addE(m){
    var d=document.createElement('div');d.className='msg-e';
    d.innerHTML='<div class="el">Error</div><div class="et">'+esc(m)+'</div>';
    F.appendChild(d);sb();
  }

  function save(){vs.postMessage({command:'save',h:hist.slice(-20)})}

  /* ── Streaming token display ── */
  var _streamEl=null,_streamBuf='';
  function streamToken(t){
    var thk=document.getElementById('_thk');if(thk)thk.remove();
    if(!_streamEl){
      _streamEl=document.createElement('div');_streamEl.className='msg msg-a streaming';
      var now=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
      _streamEl.innerHTML='<div class="from"><span>Kama</span><span class="time">'+now+'</span></div><div class="po stream-text"></div>';
      E.style.display='none';F.appendChild(_streamEl);
    }
    _streamBuf+=t;
    _streamEl.querySelector('.stream-text').innerHTML=hl(_streamBuf);
    sb();
  }
  function finishStream(){
    if(_streamEl){_streamEl.remove();_streamEl=null}
    _streamBuf='';
  }

  /* ── Event delegation: Copy / Send to Agent ── */
  F.addEventListener('click',function(e){
    var btn=e.target.closest('[data-action]');
    if(!btn)return;
    var msgEl=btn.closest('.msg-a');
    if(!msgEl)return;
    var prompt=msgEl.getAttribute('data-prompt');
    if(!prompt)return;
    var action=btn.getAttribute('data-action');
    if(action==='agent'){
      vs.postMessage({command:'agent',prompt:prompt});
      var origA=btn.textContent;
      btn.textContent='\\u2713 Sent';btn.className='btn btn-ok';
      setTimeout(function(){btn.textContent=origA;btn.className='btn btn-w'},2000);
    }else if(action==='chain'){
      vs.postMessage({command:'chain',prompt:prompt});
      var origC=btn.textContent;
      btn.textContent='\\u2713 Chained';btn.className='btn btn-ok';
      setTimeout(function(){btn.textContent=origC;btn.className='btn btn-o'},2000);
    }else if(action==='copy'){
      vs.postMessage({command:'copy',prompt:prompt});
      var origP=btn.textContent;
      btn.textContent='\\u2713 Copied';btn.className='btn btn-ok';
      setTimeout(function(){btn.textContent=origP;btn.className='btn btn-o'},1500);
    }
  });

  /* ── Event delegation: Download models ── */
  $('ML_AVAIL').addEventListener('click',function(e){
    var btn=e.target.closest('[data-pull]');
    if(!btn)return;
    var mn=btn.getAttribute('data-pull');
    vs.postMessage({command:'pullModel',model:mn});
    btn.innerHTML='<span class="dl-bar" style="width:0%"></span><span class="dl-txt">0%</span>';
    btn.className='dl-btn pulling';
    btn.setAttribute('data-pulling',mn);
  });

  /* ── Model list rendering ── */
  function renderInstalled(models,current){
    var c=$('ML_INST');c.innerHTML='';
    if(!models.length){c.innerHTML='<div class="setup-msg">No models installed.<br/>Switch to <b>Available</b> tab to download.</div>';return}
    models.forEach(function(m){
      var mid=m.id||m.name;
      var label=m.name||m.id||mid;
      var el=document.createElement('div');el.className='mi'+(mid===current?' selected':'');
      var sz=m.size_mb>1024?(m.size_mb/1024).toFixed(1)+' GB':m.size_mb+' MB';
      el.innerHTML='<div class="mi-info"><div class="mi-name">'+esc(label)+'</div></div><div class="mi-size">'+sz+'</div><div class="mi-check"></div>';
      el.addEventListener('click',function(){
        document.querySelectorAll('#ML_INST .mi').forEach(function(x){x.classList.remove('selected')});
        el.classList.add('selected');selModel=mid;$('setupDone').disabled=false;
      });
      if(mid===current){selModel=mid;$('setupDone').disabled=false}
      c.appendChild(el);
    });
  }

  function renderCatalog(catalog){
    var c=$('ML_AVAIL');c.innerHTML='';
    if(!catalog||!catalog.length){c.innerHTML='<div class="setup-msg">Could not load model catalog.</div>';return}
    catalog.forEach(function(m){
      var mid=m.id||m.name;
      var el=document.createElement('div');el.className='mi';
      var act='';
      if(m.installed){act='<div class="mi-action"><span class="dl-btn done">Installed</span></div>'}
      else{act='<div class="mi-action"><button class="dl-btn" data-pull="'+escAttr(mid)+'">Download</button></div>'}
      el.innerHTML='<div class="mi-info"><div class="mi-name">'+esc(m.name||mid)+'</div><div class="mi-desc">'+esc(m.desc)+'</div></div><div class="mi-size">'+esc(m.size)+'</div>'+act;
      c.appendChild(el);
    });
  }

  /* ── Messages from extension ── */
  window.addEventListener('message',function(e){
    var m=e.data;
    if(m.command==='token'){streamToken(m.text)}
    else if(m.command==='result'){finishStream();addP(m.prompt,m.ms,m.model,m.agent,m.quality,m.grade,m.security);unlock()}
    else if(m.command==='err'){finishStream();addE(m.msg);unlock()}
    else if(m.command==='stopped'){finishStream();unlock()}
    else if(m.command==='loading'&&!m.on){finishStream();unlock()}
    else if(m.command==='status'){
      var isSetup=m.starting&&m.setupPct>=0;
      if(m.online){
        // Connected
        D.className='dot on';
        SL.textContent='Connected';
        OB.classList.remove('show');
        D.style.background='';
        $('OB_PROG').style.display='none';
        brainStarting=false;
        var btn=$('bStartBrain');
        btn.classList.remove('starting');
        btn.disabled=false;
        $('bStartTxt').textContent='Start Brain Server';
      } else if(m.starting){
        // Downloading / starting
        D.className='dot';D.style.background='var(--blue)';
        var pct=m.setupPct||0;
        var mdl=m.setupModel||'';
        if(pct>0){
          SL.textContent='Downloading '+pct+'%';
          $('OB_TITLE').textContent='Downloading Model';
          $('OB_DESC').textContent=(mdl?mdl+' - ':'')+'This happens once. Please wait…';
          $('OB_PROG').style.display='';
          $('OB_PROG_LBL').textContent='Downloading model… '+pct+'%';
          $('OB_PROG_FILL').style.width=pct+'%';
        } else {
          SL.textContent='Starting…';
          $('OB_TITLE').textContent='Starting Brain Server';
          $('OB_DESC').textContent='Kama is starting in the background…';
          $('OB_PROG').style.display='none';
        }
        OB.classList.add('show');
        $('bStartBrain').classList.add('starting');
        $('bStartBrain').disabled=true;
        $('bStartTxt').textContent='Starting…';
      } else {
        D.className='dot off';
        SL.textContent='Offline';
        D.style.background='';
        $('OB_TITLE').textContent='Brain Server Offline';
        $('OB_DESC').textContent='Kama Brain is not running.<br/>It will start automatically when found.';
        $('OB_PROG').style.display='none';
        OB.classList.add('show');
        brainStarting=false;
        var btn2=$('bStartBrain');
        btn2.classList.remove('starting');
        btn2.disabled=false;
        $('bStartTxt').textContent='Start Brain Server';
      }
    }
    else if(m.command==='showSetup'){showView('setup');vs.postMessage({command:'loadModels'})}
    else if(m.command==='showTutorial'){showView('tutorial');showTutSlide(0)}
    else if(m.command==='allModels'){
      renderInstalled(m.installed||[],m.current||'');
      renderCatalog(m.catalog||[]);
      if(m.current)FM.textContent=m.current;
    }
    else if(m.command==='modelSet'){FM.textContent=m.model}
    else if(m.command==='setAgent'){
      curAgent=m.agentId||'auto';
      curFamily=m.family||'auto';
      updateBar();
    }
    else if(m.command==='pullProgress'){
      var pb=document.querySelector('[data-pulling="'+m.model+'"]');
      if(pb){
        var bar=pb.querySelector('.dl-bar');
        var txt=pb.querySelector('.dl-txt');
        if(bar)bar.style.width=m.pct+'%';
        if(txt)txt.textContent=m.pct+'%';
      }
    }
    else if(m.command==='pullDone'){
      document.querySelectorAll('.dl-btn.pulling').forEach(function(b){
        b.innerHTML='\\u2713 Done';b.className='dl-btn done';b.removeAttribute('data-pulling');
      });
    }
    else if(m.command==='pullFail'){
      document.querySelectorAll('.dl-btn.pulling').forEach(function(b){
        b.innerHTML='Failed';b.className='dl-btn fail';b.removeAttribute('data-pulling');
      });
    }
    else if(m.command==='restore'&&m.h){
      E.style.display='none';
      m.h.forEach(function(raw){
        try{var o=JSON.parse(raw);if(o.r==='u')addU(o.t);else if(o.r==='p')addPRestore(o.t,o.ms,o.m,o.a,o.q,o.g,o.s)}catch(x){}
      });
    }
    else if(m.command==='chainSet'){
      $('chainBar').classList.add('show');
      $('chainPreview').textContent=m.preview||'';
    }
    else if(m.command==='historyData'){
      histItems=m.items||[];
      renderHist();
    }
    else if(m.command==='prefillInput'){
      showView('chat');
      I.value=m.text||'';
      I.style.height='auto';I.style.height=Math.min(I.scrollHeight,200)+'px';
      I.focus();
    }
    else if(m.command==='showFileContext'){
      updateFcBadge(m.fileName||'');
    }
  });

  /* Init - signal extension host that JS is ready */
  var _gotStatus=false;
  window.addEventListener('message',function _statusWatcher(e){
    if(e.data&&e.data.command==='status'){_gotStatus=true}
  });
  vs.postMessage({command:'ready'});
  setTimeout(function(){if(!_gotStatus){vs.postMessage({command:'ready'})}},3000);
  setTimeout(function(){if(!_gotStatus){vs.postMessage({command:'ready'})}},8000);
  updateBar();
})();
</script>
</body>
</html>`;
  }
}