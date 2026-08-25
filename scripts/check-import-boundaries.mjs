#!/usr/bin/env node
/**
 * Fail if pure modules import @earendil-works/* (Pi packages).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const modules = sourceModules(SRC);
  const pureModules = modules.filter((module) => !PI_ADAPTERS.has(module));
  const violations = [...PI_ADAPTERS]
    .filter((adapter) => !modules.includes(adapter))
    .map((adapter) => `${adapter}: adapter allowlist entry does not exist`);

  for (const rel of pureModules) {
    const file = path.join(SRC, rel);
    const source = readFileSync(file, "utf8");
    for (const violation of forbiddenPiImports(source, rel)) {
      violations.push(`${rel}:${violation.line}: ${violation.specifier}`);
    }
  }

  if (violations.length) {
    console.error("Import boundary check failed:\n");
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }

  console.log(`Import boundary check passed (${pureModules.length} pure modules, ${PI_ADAPTERS.size} Pi adapters).`);
}

export function forbiddenPiImports(source, fileName = "module.ts") {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations = [];
  const record = (node, specifier) => {
    if (!specifier.startsWith("@earendil-works/")) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    violations.push({ line: line + 1, specifier });
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      record(node, node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      record(node, node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require")) {
        record(node, node.arguments[0].text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function sourceModules(directory, relative = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return sourceModules(path.join(directory, entry.name), child);
    return entry.isFile() && entry.name.endsWith(".ts") ? [child] : [];
  }).sort();
}
