#!/usr/bin/env node
/**
 * Fail if pure modules import @earendil-works/* (Pi packages).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extensions", "wiki", "lib");

const PURE_MODULES = [
  "producer-types.ts",
  "cli.ts",
  "failures.ts",
  "path.ts",
  "path-policy.ts",
  "wiki-okf.ts",
  "templates.ts",
  "frontmatter.ts",
  "citations.ts",
  "agents.ts",
];

const FORBIDDEN = /from\s+["']@earendil-works\//;
const FORBIDDEN_REQUIRE = /require\s*\(\s*["']@earendil-works\//;

const violations = [];

for (const rel of PURE_MODULES) {
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

console.log(`Import boundary check passed (${PURE_MODULES.length} pure modules).`);
