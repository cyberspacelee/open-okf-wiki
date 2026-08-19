#!/usr/bin/env node
/**
 * Fail if pure modules import @earendil-works/* (Pi packages),
 * or if src/ root and ui/ import private lead/* modules.
 * See ARCHITECTURE.md → Import rules.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

/** Pure modules that must not depend on @earendil-works/* */
const PURE_MODULES = [
  "producer-types.ts",
  "delegate-contracts.ts",
  "run-record.ts",
  "cli.ts",
  "ui/observability.ts",
  "failures.ts",
  "util.ts",
  "path-policy.ts",
  "lead/spec.ts",
  "lead/board.ts",
  "lead/dispatch.ts",
  "lead/validate.ts",
  "lead/indexes.ts",
  "lead/finalize.ts",
  "lead/path.ts",
  "lead/delegates.ts",
  "lead/run.ts",
];

const FORBIDDEN = /from\s+["']@earendil-works\//;
const FORBIDDEN_REQUIRE = /require\s*\(\s*["']@earendil-works\//;
const PRIVATE_LEAD = /from\s+["'](?:\.\.?\/)*lead\/(?!index\.js)[^"']+["']/;
const SHARED_LEAD = /from\s+["'](?:\.\.?\/)*lead\/(?:path|delegates)\.js["']/;

const violations = [];

for (const rel of PURE_MODULES) {
  const file = path.join(SRC, rel);
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch (error) {
    violations.push(`${rel}: missing (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
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

function walkTs(directory, base = "") {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkTs(path.join(directory, entry.name), rel));
    else if (entry.name.endsWith(".ts")) files.push(rel);
  }
  return files;
}

for (const rel of walkTs(SRC)) {
  if (rel.startsWith("lead/")) continue;
  const source = readFileSync(path.join(SRC, rel), "utf8");
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    if (rel.startsWith("pi/")) continue;
    if (PRIVATE_LEAD.test(trimmed) && !SHARED_LEAD.test(trimmed)) {
      violations.push(`${rel}:${i + 1}: ${trimmed}`);
    }
  }
}

if (violations.length) {
  console.error("Import boundary check failed:\n");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`Import boundary check passed (${PURE_MODULES.length} pure modules; lead/* private except lead/index, path, delegates; pi/ may import the lead barrel).`);
