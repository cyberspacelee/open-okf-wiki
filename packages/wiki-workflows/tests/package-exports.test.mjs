import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const packageRoot = path.resolve(new URL("..", import.meta.url).pathname);

test("package consumers use only root, cli, and pi subpaths", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(manifest.exports), [".", "./cli", "./pi"]);

  const root = await import("@okf-wiki/wiki-workflows");
  assert.deepEqual(Object.keys(root).sort(), ["WikiRunResultError", "createProductionWikiProducer"]);
  assert.equal(typeof (await import("@okf-wiki/wiki-workflows/cli")).parseWikiCliCommand, "function");
  assert.equal(typeof (await import("@okf-wiki/wiki-workflows/pi")).createWikiExtension, "function");
  await assert.rejects(import("@okf-wiki/wiki-workflows/run-ledger"), /not defined|not exported/i);
});

test("root declarations expose the complete caller type closure without internal records", async () => {
  const declaration = await readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8");
  for (const name of ["WikiProducer", "WikiRunHandle", "WikiInspectOptions", "WikiRunUpdate", "WikiRunView", "WikiRunEvent", "WikiAgentInspection", "WikiAgentOutcome", "WikiRunWarning"]) {
    assert.match(declaration, new RegExp(`\\b${name}\\b`));
  }
  assert.doesNotMatch(declaration, /WikiRunLedger|WikiRunFact|WikiAgentRecord|WikiDelegateReceipt|CandidateWiki/);
});

test("npm pack exposes a self-contained public declaration graph to a real TypeScript consumer", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "wiki-packed-consumer-"));
  t.after(async () => await rm(temporary, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temporary], { cwd: packageRoot, encoding: "utf8" }));
  const install = path.join(temporary, "consumer", "node_modules", "@okf-wiki", "wiki-workflows");
  await mkdir(install, { recursive: true });
  execFileSync("tar", ["-xzf", path.join(temporary, packed[0].filename), "-C", install, "--strip-components=1"]);
  const consumer = path.join(temporary, "consumer");
  await writeFile(path.join(consumer, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await writeFile(path.join(consumer, "tsconfig.json"), `${JSON.stringify({ compilerOptions: {
    strict: true, noEmit: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", skipLibCheck: false,
  }, include: ["consumer.ts"] }, null, 2)}\n`);
  await writeFile(path.join(consumer, "consumer.ts"), [
    'import { createProductionWikiProducer, type WikiAgentOutcome, type WikiRunEvent, type WikiRunWarning } from "@okf-wiki/wiki-workflows";',
    "const producer = createProductionWikiProducer();",
    "const consume = (event: WikiRunEvent): string => {",
    "  if (event.type === 'stage') return event.stage;",
    "  if (event.type === 'delegate') return event.phase;",
    "  return event.message;",
    "};",
    "const outcome: WikiAgentOutcome | undefined = undefined;",
    "const warning: WikiRunWarning = { code: 'cleanup_failed', message: 'x', at: new Date().toISOString() };",
    "void [producer, consume, outcome, warning];",
    "",
  ].join("\n"));
  execFileSync(path.join(packageRoot, "node_modules", ".bin", "tsc"), ["-p", path.join(consumer, "tsconfig.json")], { cwd: consumer, stdio: "inherit" });

  const declarations = await Promise.all(["index.d.ts", "producer-types.d.ts", "production-run.d.ts"].map((file) => readFile(path.join(install, "dist", file), "utf8")));
  assert.doesNotMatch(declarations.join("\n"), /delegate-contracts|artifact-store|WikiDelegateReceipt|WikiArtifactRef/);
});
