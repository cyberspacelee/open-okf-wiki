#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignoredDirs = new Set(["dist", "node_modules", "playwright-report", "test-results"]);
const failures = [];

function filesUnder(relativeDir) {
  const start = path.join(root, relativeDir);
  if (!existsSync(start)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
        files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
      }
    }
  };
  visit(start);
  return files;
}

const packageFiles = filesUnder("packages");
const sourceFiles = packageFiles.filter((file) => file.includes("/src/"));
const productSourceFiles = sourceFiles.filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.includes("/fixtures/"),
);

for (const file of [...filesUnder("packages/cli"), ...filesUnder("apps/desktop")]) {
  failures.push(`${file}: CLI/Desktop operator package must stay deleted`);
}

const removedModulePaths = [
  /\/WorkspaceRunPage\./,
  /\/agent\/src\/(?:wiki-run|shell\/wiki-run-shell)\./,
  /\/session-run-transition\./,
  /\/server\/src\/(?:run-events|wiki-run-job)\./,
  /\/server\/src\/session\/product-inject\./,
  /\/agent\/src\/pi\/session-history\./,
  /\/agent\/src\/produce\/tools\/(?:parent-wiki-produce-tool|wiki-produce-progress)\./,
  /\/contract\/src\/(?:events|gate-ui|interaction|session)\./,
  /\/web\/src\/agent-workspace\/(?:components\/(?:ProduceTrail|ProduceUnitCard)|hooks\/project\/produce|panels\/AgentTree)\./,
];

for (const file of sourceFiles) {
  if (removedModulePaths.some((pattern) => pattern.test(file))) {
    failures.push(`${file}: removed compatibility/operator module must stay deleted`);
  }
}

const forbiddenSourceRules = [
  [
    "independent Wiki Run surface",
    /\b(?:WorkspaceRunPage|WikiRunShell|startWikiRun|resumeWikiRun|start_wiki_run)\b/,
  ],
  [
    "mutable Wiki Run HTTP route",
    /\b(?:handleCreateRun|handleRetryRun|handleApprovePlan|handleDenyPlan|handleRevisePlan|handleApprovePublication|handleDenyPublication|handleCancelRun|handleRunEvents)\b|\/runs\/[^"]*\/(?:retry|approve-plan|deny-plan|revise-plan|approve-publication|deny-publication|cancel|events)/,
  ],
  [
    "product-injected event channel",
    /\b(?:PRODUCT_INJECT_KINDS|ProductSseEvent|ProductAgentEvent|ProductInjectTarget|assertProductInject|emitProductAgentEvent|injectProductEvent|getRecentAgentSessionEvents)\b|source\s*:\s*["']product["']/,
  ],
  [
    "event ring/replay protocol",
    /\b(?:MAX_RECENT|nextSequence|lastEventId|replayCursor|replayEvents?|ringBuffer)\b|\bsequence\s*[?:]\s*(?:number|z\.)/,
  ],
  [
    "Session side metadata/path discovery",
    /\b(?:sessionMetaPath|readSessionMeta|writeSessionMeta(?:RunId)?|sessionWorkDir|findPiSessionFile|resolveSessionHistoryFile|isPiSessionJsonlName|agentSessionExistsOnDisk)\b/,
  ],
  [
    "duplicate Produce projection",
    /\b(?:OKF_PRODUCE_PROGRESS\w*|ProduceUnit|produceUnits|buildProduceTree|produceDisplayRoots|produceUnitsFromSessionEntries|childPiEvent|applyChildStreamEvent|workStreamsFromAgents|workStreams|WorkStreams|workAgents|upsertOperatorWorkAgent|OperatorWorkAgent|ProduceChildPiEvent|readOperatorWorkSnapshot|WorkUnit|parentVisibility|applyPiEvent|ProjectedHistoryMessage|attachWorkUnitSink|ProductWorkUnit)\b|okf\.produce_progress|child_pi|agent_span|operator-work|work_unit|work-unit-coalesce|operator-trajectory/,
  ],
  ["legacy WikiRunPlan contract", /\bWikiRunPlan\b/],
  [
    "hand-rolled legacy agent protocol",
    /\b(?:toAISdkStream|SessionMessageSchema|SessionMessagePart|appendSessionMessages)\b|["'](?:list_source|read_source|write_wiki)["']/,
  ],
];

const allowedProductDependencies = {
  "@okf-wiki/contract": new Set(),
  "@okf-wiki/core": new Set(["@okf-wiki/contract", "@okf-wiki/skill"]),
  "@okf-wiki/agent": new Set(["@okf-wiki/contract", "@okf-wiki/core"]),
  "@okf-wiki/server": new Set(["@okf-wiki/agent", "@okf-wiki/contract", "@okf-wiki/core"]),
  "@okf-wiki/web": new Set(["@okf-wiki/contract"]),
  "@okf-wiki/skill": new Set(),
};

for (const file of productSourceFiles) {
  const content = readFileSync(path.join(root, file), "utf8");
  for (const [label, pattern] of forbiddenSourceRules) {
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    failures.push(`${file}:${line}: ${label}: ${JSON.stringify(match[0])}`);
  }
}

for (const file of filesUnder("packages/core/src").filter(
  (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
)) {
  const content = readFileSync(path.join(root, file), "utf8");
  const match = /\btestProviderConnection\b|\bfetch\s*\(/.exec(content);
  if (!match) continue;
  const line = content.slice(0, match.index).split("\n").length;
  failures.push(`${file}:${line}: provider transport belongs to Agent, not Core`);
}

for (const file of packageFiles.filter((file) => file.endsWith("/package.json"))) {
  const manifest = JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const dependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  const allowed = allowedProductDependencies[manifest.name];
  for (const dependency of Object.keys(dependencies)) {
    if (
      dependency === "ai" ||
      dependency.startsWith("@ai-sdk/") ||
      dependency.startsWith("@mastra/") ||
      dependency === "@okf-wiki/cli"
    ) {
      failures.push(`${file}: forbidden dependency ${dependency}`);
    }
    if (manifest.name !== "@okf-wiki/agent" && dependency.startsWith("@earendil-works/pi-")) {
      failures.push(`${file}: only @okf-wiki/agent may depend on Pi (${dependency})`);
    }
    if (dependency.startsWith("@okf-wiki/") && !allowed?.has(dependency)) {
      failures.push(`${file}: forbidden product dependency edge ${manifest.name} -> ${dependency}`);
    }
  }
}

for (const file of ["package.json", "tsconfig.json", "pnpm-workspace.yaml"]) {
  const content = readFileSync(path.join(root, file), "utf8");
  if (/packages\/cli|apps\/\*|apps\/desktop|@okf-wiki\/cli/.test(content)) {
    failures.push(`${file}: CLI/Desktop workspace reference must stay deleted`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
  process.exit(1);
}

console.log("check-architecture: ok");
