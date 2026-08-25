#!/usr/bin/env node
/**
 * Fail if pure modules import @earendil-works/* (Pi packages).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extensions", "wiki", "lib");

const PI_ADAPTERS = new Set([
  "pi/session.ts",
  "pi/tools.ts",
  "producer.ts",
  "subagent.ts",
  "tui.ts",
  "writer-todo.ts",
]);

const FORBIDDEN = /from\s+["']@earendil-works\//;
const FORBIDDEN_REQUIRE = /require\s*\(\s*["']@earendil-works\//;

const modules = sourceModules(SRC);
const pureModules = modules.filter((module) => !PI_ADAPTERS.has(module));
const violations = [...PI_ADAPTERS]
  .filter((adapter) => !modules.includes(adapter))
  .map((adapter) => `${adapter}: adapter allowlist entry does not exist`);

for (const rel of pureModules) {
  const file = path.join(SRC, rel);
  const source = readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (FORBIDDEN.test(line) || FORBIDDEN_REQUIRE.test(line)) {
      violations.push(`${rel}:${i + 1}: ${trimmed}`);
    }
  }
}

if (violations.length) {
  console.error("Import boundary check failed:\n");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`Import boundary check passed (${pureModules.length} pure modules, ${PI_ADAPTERS.size} Pi adapters).`);

function sourceModules(directory, relative = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceModules(path.join(directory, entry.name), child);
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  }).sort();
}
