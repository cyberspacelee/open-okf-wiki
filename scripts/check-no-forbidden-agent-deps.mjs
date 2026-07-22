#!/usr/bin/env node
/**
 * CI guard: product packages must not depend on Mastra or Vercel AI SDK (ADR 0030).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const forbidden = ["@mastra/", "\"ai\"", "@ai-sdk/"];

const pkgDirs = readdirSync(packagesDir).filter((name) => {
  try {
    return statSync(path.join(packagesDir, name)).isDirectory();
  } catch {
    return false;
  }
});

let failed = false;
for (const name of pkgDirs) {
  const pkgPath = path.join(packagesDir, name, "package.json");
  let raw;
  try {
    raw = readFileSync(pkgPath, "utf8");
  } catch {
    continue;
  }
  const pkg = JSON.parse(raw);
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
    ...pkg.peerDependencies,
  };
  for (const dep of Object.keys(deps ?? {})) {
    if (
      dep === "ai" ||
      dep.startsWith("@mastra/") ||
      dep.startsWith("@ai-sdk/")
    ) {
      console.error(`FORBIDDEN dep in packages/${name}: ${dep}`);
      failed = true;
    }
  }
}

if (failed) {
  process.exit(1);
}
console.log("check-no-forbidden-agent-deps: OK");
