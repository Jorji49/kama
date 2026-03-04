/**
 * Kama - Brain Client
 * HTTP client for the local Python Brain (FastAPI + llama-cpp-python).
 * Health checks use separate connections and never interfere with active requests.
 */

import * as http from "http";

export interface PromptResponse {
  prompt: string;
  context_summary: string;
  model_used: string;
  generation_time_ms: number;
  agent_used: string;
  quality_score: number;
  quality_grade: string;
  security_verdict: string;
  prompt_fingerprint: string;
}

export interface AgentInfo {
  id: string;
  name: string;
}

export interface LocalModel {
  name: string;
  size_mb: number;
}

export interface ModelsResponse {
  models: LocalModel[];
  current: string;
  error?: string;
}

export interface CatalogModel {
  name: string;
  desc: string;
  size: string;
  installed: boolean;
}

export interface CatalogResponse {
  catalog: CatalogModel[];
}

export interface HardwareRec {
  name: string;
  reason: string;
  tier: "optimal" | "fast" | "quality" | string;
  quality_tier: number;
  speed_tier: number;
  ram_required: string;
  already_installed: boolean;
}

export interface HardwareInfo {
  os: string;
  cpu: string;
  cpu_cores: number;
  cpu_physical: number;
  ram_gb: number;
  gpu: string;
  vram_gb: number;
  has_cuda: boolean;
  has_metal: boolean;
}

export interface HardwareProfileResponse {
  hardware: HardwareInfo;
  recommendations: HardwareRec[];
  warning: string;
  summary: string;
}

export interface ContextResponse {
  languages: string[];
  tech_stack: string;
  manifest: string;
}

export interface HealthStatus {
  ok: boolean;           // brain is reachable and model is loaded
  setup: boolean;        // brain is running but still setting up (downloading/loading model)
  setupPct: number;      // 0-100 download progress
  setupModel: string;    // model being downloaded
  setupError: boolean;   // setup failed
  error: string;
}

export type StreamCallback = (event: {
  type: "token" | "done" | "error" | "fallback" | "end";
  text?: string;
  prompt?: string;
  ms?: number;
  model?: string;
  agent?: string;
  quality?: number;
  grade?: string;
  security?: string;
  fingerprint?: string;
  message?: string;
}) => void;

export class BrainClient {
  private _baseUrl: string;
  /** Only tracks the main vibe request (for abort). */
  private _vibeRequest: http.ClientRequest | null = null;

  private static readonly TIMEOUT_MS = 300_000;
  private static readonly HEALTH_TIMEOUT_MS = 2_000;

  constructor(baseUrl: string) {
    this._baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Health check with port discovery.
   * Returns rich HealthStatus so the UI can show setup/download progress.
   */
  public async healthCheck(): Promise<HealthStatus> {
    const _check = async (baseOverride?: string): Promise<HealthStatus> => {
      const res = await this._fire<{
        status: string;
        setup_pct?: number;
        setup_model?: string;
        setup_status?: string;
        error?: string;
      }>("GET", "/health", undefined, BrainClient.HEALTH_TIMEOUT_MS, baseOverride);

      if (res.status === "ok") {
        return { ok: true, setup: false, setupPct: 100, setupModel: "", setupError: false, error: "" };
      }
      if (res.status === "setup") {
        return { ok: false, setup: true, setupPct: res.setup_pct ?? 0, setupModel: res.setup_model ?? "", setupError: false, error: "" };
      }
      if (res.status === "setup_error") {
        return { ok: false, setup: false, setupPct: 0, setupModel: "", setupError: true, error: res.error ?? "Setup failed" };
      }
      return { ok: false, setup: false, setupPct: 0, setupModel: "", setupError: false, error: "" };
    };

    try {
      return await _check();
    } catch {
      // Port discovery: Brain may have started on an alternate port
      const base = new URL(this._baseUrl);
      const basePort = parseInt(base.port || "8420", 10);
      for (let p = basePort + 1; p < basePort + 10; p++) {
        const tryUrl = `${base.protocol}//${base.hostname}:${p}`;
        try {
          const h = await _check(tryUrl);
          if (h.ok || h.setup) {
            this._baseUrl = tryUrl;
            return h;
          }
        } catch { /* try next */ }
      }
      return { ok: false, setup: false, setupPct: 0, setupModel: "", setupError: false, error: "unreachable" };
    }
  }

  public async sendVibe(vibe: string, workspacePath: string, agent: string = "auto", chainContext: string = "", activeFile: string = "", activeFileName: string = "", activeFileLang: string = ""): Promise<PromptResponse> {
    return this._fetchTracked<PromptResponse>("POST", "/vibe", { vibe, workspace_path: workspacePath, agent, chain_context: chainContext, active_file: activeFile, active_file_name: activeFileName, active_file_language: activeFileLang });
  }

  /**
   * Stream vibe via SSE. Calls onEvent for each token/done/error event.
   * Returns a cancel function - call it to abort the stream.
   */
  public sendVibeStream(
    vibe: string,
    workspacePath: string,
    agent: string,
    onEvent: StreamCallback,
    chainContext: string = "",
    activeFile: string = "",
    activeFileName: string = "",
    activeFileLang: string = ""
  ): () => void {
    const url = new URL(this._baseUrl + "/vibe/stream");
    const payload = JSON.stringify({ vibe, workspace_path: workspacePath, agent, chain_context: chainContext, active_file: activeFile, active_file_name: activeFileName, active_file_language: activeFileLang });

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || "8420",
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "Content-Length": Buffer.byteLength(payload).toString(),
      },
      timeout: BrainClient.TIMEOUT_MS,
    };

    let buffer = "";
    let doneSeen = false;
    // Watchdog: if no completion/error within TIMEOUT_MS, fire a synthetic 'end'
    const watchdog = setTimeout(() => {
      if (!doneSeen) { onEvent({ type: "end" }); req.destroy(); }
    }, BrainClient.TIMEOUT_MS);

    const req = http.request(options, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";
        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith("data: ")) { continue; }
          try {
            const data = JSON.parse(line.slice(6));
            if (doneSeen) { continue; } // skip events after terminal event (prevents duplicates)
            if (data.type === "done" || data.type === "error" || data.type === "fallback") {
              doneSeen = true;
              clearTimeout(watchdog);
            }
            onEvent(data);
          } catch { /* ignore malformed */ }
        }
      });
      res.on("end", () => {
        clearTimeout(watchdog);
        if (!doneSeen) { onEvent({ type: "end" }); }
      });
    });

    req.on("error", (err) => {
      clearTimeout(watchdog);
      onEvent({ type: "error", message: err.message });
    });

    req.write(payload);
    req.end();

    return () => { clearTimeout(watchdog); req.destroy(); };
  }

  public async getHardware(): Promise<HardwareProfileResponse> {
    return this._fire<HardwareProfileResponse>("GET", "/hardware", undefined, 15_000);
  }

  public async scanContext(workspacePath: string): Promise<ContextResponse> {
    return this._fire<ContextResponse>("POST", "/context", { workspace_path: workspacePath }, 12_000);
  }

  public async listAgents(): Promise<{ agents: AgentInfo[] }> {
    return this._fire<{ agents: AgentInfo[] }>("GET", "/agents", undefined, 5_000);
  }

  public async listModels(): Promise<ModelsResponse> {
    return this._fire<ModelsResponse>("GET", "/models", undefined, 10_000);
  }

  public async setModel(model: string): Promise<{ status: string; model: string }> {
    return this._fire("POST", "/model", { model }, 5_000);
  }

  public async catalogModels(): Promise<CatalogResponse> {
    return this._fire<CatalogResponse>("GET", "/models/available", undefined, 15_000);
  }

  /**
   * Pull (download) a GGUF model with SSE progress events.
   * Calls onProgress with percentage (0-100) during download.
   * Returns final status when complete.
   */
  public async pullModel(
    model: string,
    onProgress?: (pct: number, status: string) => void
  ): Promise<{ status: string; model?: string; message?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(this._baseUrl + "/models/pull");
      const payload = JSON.stringify({ model });

      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 8420,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
        timeout: 600_000,
      };

      const req = http.request(options, (res) => {
        let lastStatus = "";
        let buffer = "";

        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString();
          // Parse SSE lines
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";
          for (const block of lines) {
            const line = block.trim();
            if (!line.startsWith("data: ")) { continue; }
            try {
              const data = JSON.parse(line.slice(6));
              lastStatus = data.status || "";
              if (onProgress && typeof data.pct === "number") {
                onProgress(data.pct, lastStatus);
              }
            } catch { /* ignore parse errors */ }
          }
        });

        res.on("end", () => {
          if (lastStatus === "done" || lastStatus === "success") {
            resolve({ status: "ok", model });
          } else if (lastStatus === "error") {
            resolve({ status: "error", message: "Pull failed" });
          } else {
            resolve({ status: "ok", model });
          }
        });
      });

      req.on("error", (err) => reject(err));
      req.on("timeout", () => { req.destroy(); reject(new Error("Pull timeout")); });
      req.write(payload);
      req.end();
    });
  }

  /** Abort the active vibe request only. */
  public abort(): void {
    if (this._vibeRequest) {
      this._vibeRequest.destroy();
      this._vibeRequest = null;
    }
  }

  /**
   * Tracked fetch - used for vibe requests only.
   * Stored in _vibeRequest so abort() can cancel it.
   */
  private _fetchTracked<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = this._makeRequest<T>(method, path, body, BrainClient.TIMEOUT_MS, resolve, reject);
      this._vibeRequest = req;
    });
  }

  /**
   * Fire-and-forget fetch - used for health checks, model ops, etc.
   * Does NOT touch _vibeRequest, so it never interferes with ongoing vibes.
   */
  private _fire<T>(method: string, path: string, body?: unknown, timeoutMs: number = BrainClient.TIMEOUT_MS, baseOverride?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      this._makeRequest<T>(method, path, body, timeoutMs, resolve, reject, baseOverride);
    });
  }

  private _makeRequest<T>(
    method: string,
    path: string,
    body: unknown | undefined,
    timeoutMs: number,
    resolve: (value: T) => void,
    reject: (reason: Error) => void,
    baseOverride?: string
  ): http.ClientRequest {
    const url = new URL((baseOverride || this._baseUrl) + path);
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 8420,
      path: url.pathname,
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
      },
      timeout: timeoutMs,
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        if (this._vibeRequest === req) { this._vibeRequest = null; }
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          let detail = data.slice(0, 300);
          try { const p = JSON.parse(data); if (p.detail) { detail = p.detail; } } catch { /* */ }
          reject(new Error(`Brain HTTP ${status}: ${detail}`));
          return;
        }
        try { resolve(JSON.parse(data) as T); } catch { reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`)); }
      });
    });

    req.on("error", (err) => {
      if (this._vibeRequest === req) { this._vibeRequest = null; }
      reject(err);
    });
    req.on("timeout", () => {
      if (this._vibeRequest === req) { this._vibeRequest = null; }
      req.destroy();
      reject(new Error(`Timeout (${Math.round(timeoutMs / 1000)}s)`));
    });

    if (payload) { req.write(payload); }
    req.end();
    return req;
  }
}
