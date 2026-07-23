#!/usr/bin/env node
/**
 * CI guard (ADR 0031): no dual operator body channels / legacy session protocol.
 * Scans packages source trees only (not docs/adr historical text, not dist).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Forbidden symbols in product source (ADR 0031 purge list). */
const FORBIDDEN = [
  "child_pi",
  "childPiEvent",
  "okfAgent",
  "agent_span",
  "agentSpan",
  "workStreams",
  "WorkStreams",
  "applyChildStreamEvent",
  "workStreamsFromAgents",
  "workAgents",
  "livePhase",
  "upsertOperatorWorkAgent",
  "operator-work",
  "OperatorWorkAgent",
  "streamAgent",
  "SessionMessageSchema",
  "SessionMessagePart",
  "ProduceChildPiEvent",
  "readOperatorWorkSnapshot",
];

function rg(pattern) {
  try {
    return execSync(
      `rg -n -g '**/src/**' -g '!**/*.test.ts' -g '!**/dist/**' -g '!**/node_modules/**' ${JSON.stringify(pattern)} packages 2>/dev/null || true`,
      { cwd: root, encoding: "utf8", shell: "/bin/bash" },
    );
  } catch (err) {
    return err.stdout?.toString?.() ?? "";
  }
}

let failed = false;

for (const term of FORBIDDEN) {
  const hits = rg(term);
  if (!hits.trim()) continue;
  // Allow comments that only document removal (must not be identifiers in code).
  const real = hits
    .split("\n")
    .filter((line) => line.trim())
    .filter((line) => {
      // Skip pure comment lines that mention the ban list.
      const body = line.replace(/^[^:]+:\d+:/, "").trim();
      if (body.startsWith("//") || body.startsWith("*") || body.startsWith("/*")) {
        return false;
      }
      return true;
    });
  if (real.length === 0) continue;
  console.error(`FAIL: forbidden operator-surface term "${term}":`);
  console.error(real.join("\n"));
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log("check-operator-surface: ok");
