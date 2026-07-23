/**
 * Step 0 spike: Pi createAgentSession + built-in tools only (no bash).
 *
 * Usage (from packages/agent):
 *   node scripts/pi-spike.mjs
 *
 * Optional live model (enterprise OpenAI-compatible):
 *   OKF_SPIKE_LIVE=1 OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... node scripts/pi-spike.mjs
 *
 * Default is offline: only materialise workdir + assert tool allowlist + list via createReadOnlyTools.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const agentRoot = path.resolve(__dirname, "..");

const READ_ONLY = ["read", "grep", "find", "ls"];
const READ_WRITE = ["read", "grep", "find", "ls", "write", "edit"];

function assertNoBash(tools) {
  if (tools.includes("bash")) {
    throw new Error("bash must not be enabled for wiki spike");
  }
}

async function materializeFixtureLayout(base) {
  const src = path.join(base, "repo");
  const skill = path.join(base, "skill");
  const runWorkDir = path.join(base, "run");
  await mkdir(path.join(src, "src"), { recursive: true });
  await writeFile(path.join(src, "src", "hello.ts"), "export const hello = 'world';\n", "utf8");
  await writeFile(path.join(src, "README.md"), "# Fixture\n\nHello.\n", "utf8");
  await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "# Producer skill fixture\n", "utf8");

  const sourcesDir = path.join(runWorkDir, "sources");
  const wikiDir = path.join(runWorkDir, "wiki");
  const analysisDir = path.join(runWorkDir, "analysis");
  await mkdir(sourcesDir, { recursive: true });
  await mkdir(wikiDir, { recursive: true });
  await mkdir(analysisDir, { recursive: true });

  const { symlink } = await import("node:fs/promises");
  await symlink(src, path.join(sourcesDir, "main"), "junction");
  await symlink(skill, path.join(runWorkDir, "skill"), "junction");

  return { runWorkDir, wikiDir };
}

async function offlineToolSmoke(runWorkDir) {
  assertNoBash(READ_ONLY);
  assertNoBash(READ_WRITE);

  const readTools = createReadOnlyTools(runWorkDir);
  const names = readTools.map((t) => t.name);
  console.log("createReadOnlyTools:", names.join(", "));
  for (const n of ["read", "grep", "find", "ls"]) {
    if (!names.includes(n)) throw new Error(`missing read-only tool ${n}`);
  }
  if (names.includes("bash") || names.includes("write")) {
    throw new Error("read-only set must not include bash/write");
  }

  // coding tools include bash by default — we must never pass that set wholesale
  const coding = createCodingTools(runWorkDir);
  const codingNames = coding.map((t) => t.name);
  console.log("createCodingTools (do not use as-is):", codingNames.join(", "));
  if (!codingNames.includes("bash")) {
    console.warn("note: expected bash in default coding tools");
  }

  const ls = readTools.find((t) => t.name === "ls");
  if (!ls) throw new Error("ls tool missing");
  const result = await ls.execute("spike-ls", { path: "sources/main" });
  const text = result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(result);
  console.log("ls sources/main →", text.slice(0, 400));
  if (!/README|src/i.test(text)) {
    throw new Error("ls did not show fixture contents");
  }
  console.log("offline tool smoke: OK");
}

async function livePromptSmoke(runWorkDir) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const modelRuntime = await ModelRuntime.create();
  const available = await modelRuntime.getAvailable();
  console.log(
    "available models:",
    available
      .slice(0, 8)
      .map((m) => `${m.provider}/${m.id}`)
      .join(", ") || "(none)",
  );

  const envModel = process.env.OPENAI_MODEL;
  const envProvider = process.env.OKF_SPIKE_PROVIDER ?? "openai";
  let model = envModel ? modelRuntime.getModel(envProvider, envModel) : available[0];
  if (!model && available[0]) model = available[0];
  if (!model) {
    console.log("live smoke skipped: no model/API key available");
    return;
  }

  assertNoBash(READ_WRITE);
  const { session } = await createAgentSession({
    cwd: runWorkDir,
    tools: [...READ_WRITE],
    sessionManager: SessionManager.inMemory(runWorkDir),
    model,
    modelRuntime,
  });

  try {
    let text = "";
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        text += event.assistantMessageEvent.delta;
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") {
        console.log(`\n[tool] ${event.toolName}`);
      }
    });

    await session.prompt(
      "Using only tools, list sources/main, read sources/main/README.md, " +
        "then write a short wiki page to wiki/index.md summarizing the fixture. " +
        "Do not use bash. Reply with the path you wrote when done.",
    );
    console.log("\nlive smoke finished; assistant chars:", text.length);
  } finally {
    session.dispose();
  }
}

async function main() {
  const base = await mkdtemp(path.join(os.tmpdir(), "okf-pi-spike-"));
  console.log("spike base:", base);
  console.log("agent package:", agentRoot);
  try {
    const { runWorkDir } = await materializeFixtureLayout(base);
    await offlineToolSmoke(runWorkDir);
    if (process.env.OKF_SPIKE_LIVE === "1") {
      await livePromptSmoke(runWorkDir);
    } else {
      console.log("set OKF_SPIKE_LIVE=1 for model prompt smoke");
    }
    console.log("pi-spike: PASS");
  } finally {
    if (process.env.OKF_SPIKE_KEEP !== "1") {
      await rm(base, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
