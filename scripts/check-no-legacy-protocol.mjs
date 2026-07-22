#!/usr/bin/env node
/**
 * CI guard (ADR 0029/0030 no-compat):
 * - wiki-run-job must not append UIMessage Session history
 * - product src must not reintroduce Host FS tool call sites
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rg(pattern, extraArgs = "") {
  try {
    return execSync(`rg -n ${extraArgs} ${JSON.stringify(pattern)} packages || true`, {
      cwd: root,
      encoding: "utf8",
      shell: "/bin/bash",
    });
  } catch (err) {
    return err.stdout?.toString?.() ?? "";
  }
}

let failed = false;

const appendHits = rg(
  "appendSessionMessages",
  "-g 'server/src/wiki-run-job.ts'",
);
if (appendHits.trim()) {
  console.error("FAIL: wiki-run-job must not call appendSessionMessages");
  console.error(appendHits);
  failed = true;
}

// Active Host tool names in non-test production code (allow tests + comments).
const hostHits = rg(
  "toolName === [\"']list_source[\"']|toolName === [\"']read_source[\"']|toAISdkStream\\(",
  "-g '**/src/**' -g '!**/*.test.ts' -g '!**/dist/**'",
);
if (hostHits.trim()) {
  console.error("FAIL: Host tool names / toAISdkStream in product src");
  console.error(hostHits);
  failed = true;
}

if (failed) {
  process.exit(1);
}
console.log("check-no-legacy-protocol: ok");
