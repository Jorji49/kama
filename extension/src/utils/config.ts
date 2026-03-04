/**
 * Kama - Configuration Utilities
 *
 * Typed accessors for `kama.*` settings.
 * 100% local mode - no external API keys needed.
 *
 * @module config
 */

import * as vscode from "vscode";

const SECTION = "kama";

export function getConfig<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration(SECTION).get<T>(key, fallback);
}

export const KamaConfig = {
  get brainServerUrl(): string {
    return getConfig("brainServerUrl", "http://127.0.0.1:8420");
  },

  get model(): string {
    return getConfig("model", "llama3.2-1b");
  },

  get maxContextFiles(): number {
    return getConfig("maxContextFiles", 30);
  },

  get autoSendToAgent(): boolean {
    return getConfig("autoSendToAgent", false);
  },

  get temperature(): number {
    return getConfig("temperature", 0.1);
  },

  get maxTokens(): number {
    return getConfig("maxTokens", 2048);
  },
} as const;
