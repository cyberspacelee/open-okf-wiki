import { spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  hasProviderCredentials,
  loadProviderConfig,
  resolveProviderRuntime,
} from "@okf-wiki/core";
// hasProviderCredentials used by handleDoctor
import { sendJson } from "../http-util.ts";
import { allowLan, host, port } from "../server-config.ts";

export function runGitVersion(): Promise<{ ok: boolean; version: string | null }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["--version"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", () => {
      resolve({ ok: false, version: null });
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: stdout.trim() || null });
      } else {
        resolve({ ok: false, version: null });
      }
    });
  });
}

export async function handleHealth(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, {
    ok: true,
    service: "okf-wiki-server",
    version: "0.2.0-dev",
    pid: process.pid,
    host,
    port,
    allowLan,
  });
}

export async function handleDoctor(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const git = await runGitVersion();
  const provider = await loadProviderConfig();
  const runtime = resolveProviderRuntime(provider);
  sendJson(res, 200, {
    ok: true,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    git: {
      available: git.ok,
      version: git.version,
    },
    env: {
      openaiBaseUrlSet: Boolean(process.env.OPENAI_BASE_URL),
      openaiApiKeySet: Boolean(process.env.OPENAI_API_KEY),
      // Never return secret values — flags only.
    },
    provider: {
      configured: hasProviderCredentials(provider),
      modelCount: provider.models.length,
      defaultModelProfileId: provider.defaultModelProfileId ?? null,
      baseUrlSet: runtime.source.baseUrl !== "none",
      apiKeySet: runtime.source.apiKey !== "none",
      apiShape: runtime.apiShape,
      baseUrlSource: runtime.source.baseUrl,
      apiKeySource: runtime.source.apiKey,
      baseUrlHost: runtime.baseUrl
        ? (() => {
            try {
              return new URL(runtime.baseUrl).host;
            } catch {
              return "(invalid)";
            }
          })()
        : null,
    },
  });
}
