import { access, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  assertAllowedWorkspacePath,
  assertContainedAbsolutePath,
  ensureWikiRoot,
  insideWorkspace,
  pathIsInside,
  type PermittedToolRoot,
  type WorkspaceToolPolicy,
} from "./path-policy.js";
import { boundToolExecutionResult } from "./tool-budget.js";
import { isSafeWikiPagePath } from "./lead.js";

export type WikiToolRole = "lead" | "researcher" | "writer" | "reviewer";

export interface WikiPageWriter {
  replacePage(input: { path: string; content: string; actor: "lead" | "writer" }): Promise<void>;
}

export interface WikiWorkflowFileSlot {
  logicalPath: `.okf-wiki/${"current" | "task"}/${string}`;
  physicalPath: string;
  writable: boolean;
}

export async function writeWikiWorkflowFile(workspaceRoot: string, slot: WikiWorkflowFileSlot, content: string): Promise<void> {
  const normalized = [...normalizeFileSlots(workspaceRoot, [slot]).values()][0];
  await assertSafeSlot(normalized, true);
  await mkdir(path.dirname(normalized.physicalAbsolute), { recursive: true });
  await assertSafeSlot(normalized, true);
  await writeFile(normalized.physicalAbsolute, content);
}

export async function readWikiWorkflowFile(workspaceRoot: string, slot: WikiWorkflowFileSlot): Promise<Buffer> {
  const normalized = [...normalizeFileSlots(workspaceRoot, [slot]).values()][0];
  await assertSafeSlot(normalized, false);
  return await readFile(normalized.physicalAbsolute);
}

export function workflowTools(
  policy: WorkspaceToolPolicy,
  role: WikiToolRole,
  writePaths: readonly string[] | undefined,
  readRoots: readonly string[] | undefined,
  reviewPaths: readonly string[] | undefined,
  pageWriter: WikiPageWriter | undefined,
  reviewIndexPaths?: readonly string[],
  fileSlots: readonly WikiWorkflowFileSlot[] = [],
): ToolDefinition<any, any, any>[] {
  const slots = normalizeFileSlots(policy.workspaceRoot, fileSlots);
  const activeWikiRoot = policy.candidateWikiRoot ?? policy.wikiRoot;
  if ((role === "lead" || role === "writer") && !pageWriter) {
    throw new Error(`Workflow configuration error: ${role} requires a transactional WikiPageWriter`);
  }
  const allowedPaths = role === "writer" ? exactWikiPaths(activeWikiRoot, writePaths, "writers") : undefined;
  const reviewerPaths = role === "reviewer" ? exactWikiPaths(activeWikiRoot, reviewPaths, "reviewers") : undefined;
  const reviewerIndexes = role === "reviewer" ? exactIndexPaths(activeWikiRoot, reviewIndexPaths) : undefined;
  const readableRoots = readRootsForPolicy(policy, activeWikiRoot, readRoots, mergePaths(allowedPaths ?? reviewerPaths, reviewerIndexes), role === "lead")
    .filter((root) => !(policy.boardPath && slots.has(insideWorkspace(policy.workspaceRoot, ".okf-wiki/current/board.md"))
      && path.resolve(root.logicalRoot) === path.resolve(policy.boardPath)));
  const readOnly = [
    boundSurveyTool(remapToolPath(guardSurveyTool(createReadToolDefinition(policy.workspaceRoot, slotReadOptions(slots)), policy, readableRoots, "read", slots), policy, activeWikiRoot), "read"),
    boundSurveyTool(remapToolPath(guardSurveyTool(createGrepToolDefinition(policy.workspaceRoot), policy, readableRoots, "grep"), policy, activeWikiRoot), "grep"),
    boundSurveyTool(remapToolPath(guardSurveyTool(createFindToolDefinition(policy.workspaceRoot), policy, readableRoots, "find"), policy, activeWikiRoot), "find"),
    boundSurveyTool(remapToolPath(guardSurveyTool(createLsToolDefinition(policy.workspaceRoot), policy, readableRoots, "ls"), policy, activeWikiRoot), "ls"),
  ];
  if (role === "lead") {
    if (!policy.candidateWikiRoot) throw new Error("Workflow configuration error: Lead requires a candidate Wiki root");
    const candidateRoot = path.resolve(policy.candidateWikiRoot);
    const write = createWriteToolDefinition(policy.workspaceRoot, {
      operations: {
        mkdir: async (directory) => await mkdirSlotParentOr(slots, directory, async () => await guardedLeadMkdir(candidateRoot, directory)),
        writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => await guardedLeadWrite(candidateRoot, file, content, pageWriter!)),
      },
    });
    const edit = createEditToolDefinition(policy.workspaceRoot, {
      operations: {
        access: async (file) => await accessSlotOr(slots, file, async () => await guardedLeadAccess(candidateRoot, file)),
        readFile: async (file) => await readSlotOr(slots, file, async () => await guardedLeadRead(candidateRoot, file)),
        writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => await guardedLeadWrite(candidateRoot, file, content, pageWriter!)),
      },
    });
    return [
      ...readOnly,
      remapToolPath(guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: candidateRoot }], "path", false, slots), policy, candidateRoot),
      remapToolPath(guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: candidateRoot }], "path", true, slots), policy, candidateRoot),
    ];
  }
  if (role !== "writer") return [...readOnly, ...slotMutationTools(policy.workspaceRoot, slots)];

  if (!allowedPaths) throw new Error("Workflow configuration error: writers require assigned Wiki pages");
  const allowedDirectories = writerDirectories(activeWikiRoot, allowedPaths);

  const write = createWriteToolDefinition(policy.workspaceRoot, {
    operations: {
      mkdir: async (directory) => await mkdirSlotParentOr(slots, directory, async () => await guardedMkdir(activeWikiRoot, directory, allowedDirectories)),
      writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => await guardedWrite(activeWikiRoot, file, content, allowedPaths, pageWriter!)),
    },
  });
  const edit = createEditToolDefinition(policy.workspaceRoot, {
    operations: {
      access: async (file) => await accessSlotOr(slots, file, async () => await guardedAccess(activeWikiRoot, file, allowedPaths)),
      readFile: async (file) => await readSlotOr(slots, file, async () => await guardedRead(activeWikiRoot, file, allowedPaths)),
      writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => await guardedWrite(activeWikiRoot, file, content, allowedPaths, pageWriter!)),
    },
  });
  return [
    ...readOnly,
    // Logical wiki/* inputs are transparently redirected to the run candidate.
    // Guarded operations still receive absolute paths and enforce the exact page.
    remapToolPath(guardWorkspaceTool(edit, policy.workspaceRoot, [{ logicalRoot: activeWikiRoot }], "path", false, slots), policy, activeWikiRoot),
    remapToolPath(guardWorkspaceTool(write, policy.workspaceRoot, [{ logicalRoot: activeWikiRoot }], "path", true, slots), policy, activeWikiRoot),
  ];
}

function mergePaths(first?: ReadonlySet<string>, second?: ReadonlySet<string>): ReadonlySet<string> | undefined {
  if (!first && !second) return undefined;
  return new Set([...(first ?? []), ...(second ?? [])]);
}

function exactIndexPaths(activeWikiRoot: string, values: readonly string[] | undefined): Set<string> | undefined {
  if (!values?.length) return undefined;
  const result = new Set<string>();
  for (const rawPath of values) {
    const relative = rawPath.startsWith("wiki/") ? rawPath.slice("wiki/".length) : "";
    if (!relative || path.posix.basename(relative) !== "index.md" || relative.includes("..") || relative.includes("//")) {
      throw new Error(`Workflow configuration error: invalid reviewer index path: ${rawPath}`);
    }
    result.add(path.resolve(activeWikiRoot, ...relative.split("/")));
  }
  return result;
}

function boundSurveyTool(
  definition: ToolDefinition<any, any, any>,
  toolName: string,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const result = await execute(toolCallId, params, signal, onUpdate, context);
      return boundToolExecutionResult(result, toolName);
    },
  } as ToolDefinition<any, any, any>;
}

function readRootsForPolicy(
  policy: WorkspaceToolPolicy,
  activeWikiRoot: string,
  requested: readonly string[] | undefined,
  writerPaths: ReadonlySet<string> | undefined,
  candidateWide = false,
): PermittedToolRoot[] {
  const assigned: PermittedToolRoot[] = [];
  const declared = [...policy.sourceRoots.keys()];
  for (const sourcePath of requested ?? []) {
    const root = policy.sourceRoots.get(sourcePath);
    if (!root) {
      throw new Error(`Workflow configuration error: undeclared source root: ${sourcePath}. Declared: ${declared.join(", ") || "(none)"}`);
    }
    assigned.push(root);
  }
  for (const writerPath of writerPaths ?? []) assigned.push(exactWorkspaceFileRoot(writerPath));
  if (candidateWide && policy.boardPath) assigned.push(exactWorkspaceFileRoot(policy.boardPath));
  if (assigned.length === 0 && !candidateWide) {
    throw new Error("Workflow configuration error: agent requests require declared source roots or exact artifact paths");
  }
  const roots = [...assigned];
  if (candidateWide) roots.push({ logicalRoot: path.resolve(activeWikiRoot) });
  if (policy.skillRoot) roots.push({ logicalRoot: path.resolve(policy.skillRoot) });
  return roots;
}

/** Exact workflow files must not acquire a different physical root via symlink. */
function exactWorkspaceFileRoot(file: string): PermittedToolRoot {
  const resolved = path.resolve(file);
  return { logicalRoot: resolved, physicalRoot: resolved };
}

function guardWorkspaceTool(
  definition: ToolDefinition<any, any, any>,
  workspaceRoot: string,
  permittedRoots: PermittedToolRoot[],
  pathField: string,
  allowMissing = false,
  slots: ReadonlyMap<string, NormalizedFileSlot> = new Map(),
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, pathField);
      if (typeof rawPath === "string" && !slots.has(insideWorkspace(workspaceRoot, rawPath))) {
        await assertAllowedWorkspacePath(workspaceRoot, permittedRoots, rawPath, allowMissing);
      }
      return await execute(toolCallId, params, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
}

/** Survey tools treat omitted path as cwd. Workspace root is not a Source unless a source logicalRoot is that root. */
function guardSurveyTool(
  definition: ToolDefinition<any, any, any>,
  policy: WorkspaceToolPolicy,
  permittedRoots: PermittedToolRoot[],
  toolName: "read" | "grep" | "find" | "ls",
  slots: ReadonlyMap<string, NormalizedFileSlot> = new Map(),
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, "path");
      const surveyPath = typeof rawPath === "string" && rawPath.length > 0 ? rawPath : ".";
      const gatedParams = { ...(params as Record<string, unknown>), path: surveyPath };
      const absolute = insideWorkspace(policy.workspaceRoot, surveyPath);
      if (toolName === "read" && slots.has(absolute)) return await execute(toolCallId, gatedParams, signal, onUpdate, context);
      const workspaceAbs = path.resolve(policy.workspaceRoot);
      if (toolName === "ls" && absolute === workspaceAbs && !permittedRoots.some((root) => path.resolve(root.logicalRoot) === workspaceAbs)) {
        return listDeclaredSourceDirectories(policy, permittedRoots);
      }
      await assertAllowedWorkspacePath(policy.workspaceRoot, permittedRoots, surveyPath, false);
      return await execute(toolCallId, gatedParams, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
}

interface NormalizedFileSlot extends WikiWorkflowFileSlot {
  workspaceRoot: string;
  logicalAbsolute: string;
  physicalAbsolute: string;
}

function normalizeFileSlots(workspaceRoot: string, values: readonly WikiWorkflowFileSlot[]): Map<string, NormalizedFileSlot> {
  const slots = new Map<string, NormalizedFileSlot>();
  for (const value of values) {
    if (!/^\.okf-wiki\/(?:current|task)\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.logicalPath)) {
      throw new Error(`Workflow configuration error: invalid fixed file slot: ${value.logicalPath}`);
    }
    const logicalAbsolute = insideWorkspace(workspaceRoot, value.logicalPath);
    const physicalAbsolute = insideWorkspace(workspaceRoot, value.physicalPath);
    if (slots.has(logicalAbsolute)) throw new Error(`Workflow configuration error: duplicate fixed file slot: ${value.logicalPath}`);
    slots.set(logicalAbsolute, { ...value, workspaceRoot: path.resolve(workspaceRoot), logicalAbsolute, physicalAbsolute });
  }
  return slots;
}

function slotReadOptions(slots: ReadonlyMap<string, NormalizedFileSlot>) {
  return { operations: {
    access: async (file: string) => await accessSlotOr(slots, file, async () => await access(file)),
    readFile: async (file: string) => await readSlotOr(slots, file, async () => await readFile(file)),
  } };
}

function slotMutationTools(workspaceRoot: string, slots: ReadonlyMap<string, NormalizedFileSlot>): ToolDefinition<any, any, any>[] {
  if (![...slots.values()].some((slot) => slot.writable)) return [];
  const write = createWriteToolDefinition(workspaceRoot, { operations: {
    mkdir: async (directory) => await mkdirSlotParent(slots, directory),
    writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => deniedSlot(file)),
  } });
  const edit = createEditToolDefinition(workspaceRoot, { operations: {
    access: async (file) => await accessSlotOr(slots, file, async () => deniedSlot(file)),
    readFile: async (file) => await readSlotOr(slots, file, async () => deniedSlot(file)),
    writeFile: async (file, content) => await writeSlotOr(slots, file, content, async () => deniedSlot(file)),
  } });
  return [
    guardWorkspaceTool(edit, workspaceRoot, [], "path", false, slots),
    guardWorkspaceTool(write, workspaceRoot, [], "path", true, slots),
  ];
}

async function accessSlotOr(slots: ReadonlyMap<string, NormalizedFileSlot>, file: string, fallback: () => Promise<void>): Promise<void> {
  const slot = slots.get(path.resolve(file));
  if (!slot) return await fallback();
  await assertSafeSlot(slot, false);
  await access(slot.physicalAbsolute);
}

async function readSlotOr(slots: ReadonlyMap<string, NormalizedFileSlot>, file: string, fallback: () => Promise<Buffer>): Promise<Buffer> {
  const slot = slots.get(path.resolve(file));
  if (!slot) return await fallback();
  await assertSafeSlot(slot, false);
  return await readFile(slot.physicalAbsolute);
}

async function writeSlotOr(slots: ReadonlyMap<string, NormalizedFileSlot>, file: string, content: string, fallback: () => Promise<void>): Promise<void> {
  const slot = slots.get(path.resolve(file));
  if (!slot) return await fallback();
  if (!slot.writable) throw new Error(`Fixed workflow file is read-only: ${slot.logicalPath}`);
  await assertSafeSlot(slot, true);
  await mkdir(path.dirname(slot.physicalAbsolute), { recursive: true });
  await assertSafeSlot(slot, true);
  await writeFile(slot.physicalAbsolute, content);
}

async function mkdirSlotParent(slots: ReadonlyMap<string, NormalizedFileSlot>, directory: string): Promise<void> {
  await mkdirSlotParentOr(slots, directory, async () => deniedSlot(directory));
}

async function mkdirSlotParentOr(slots: ReadonlyMap<string, NormalizedFileSlot>, directory: string, fallback: () => Promise<void>): Promise<void> {
  const writable = [...slots.values()].filter((slot) => slot.writable && path.dirname(slot.logicalAbsolute) === path.resolve(directory));
  if (!writable.length) return await fallback();
  for (const slot of writable) {
    await assertSafeSlot(slot, true);
    await mkdir(path.dirname(slot.physicalAbsolute), { recursive: true });
    await assertSafeSlot(slot, true);
  }
}

async function assertSafeSlot(slot: NormalizedFileSlot, allowMissing: boolean): Promise<void> {
  const workspace = slot.workspaceRoot;
  await assertContainedAbsolutePath(workspace, slot.physicalAbsolute, allowMissing, "workflow file slot root");
  let current = workspace;
  for (const segment of path.relative(workspace, slot.physicalAbsolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Fixed workflow file path contains a symbolic link: ${slot.logicalPath}`);
    } catch (error) {
      if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
      throw error;
    }
  }
}

function deniedSlot(file: string): never {
  throw new Error(`Path is not an assigned fixed workflow file: ${file}`);
}

function listDeclaredSourceDirectories(
  policy: WorkspaceToolPolicy,
  permittedRoots: PermittedToolRoot[],
): { content: Array<{ type: "text"; text: string }> } {
  const permitted = new Set(permittedRoots.map((root) => path.resolve(root.logicalRoot)));
  const names = [...policy.sourceRoots.entries()]
    .filter(([, root]) => permitted.has(path.resolve(root.logicalRoot)))
    .map(([scopeId]) => scopeId)
    .sort((left, right) => left.localeCompare(right));
  const text = names.length === 0 ? "(empty directory)" : names.map((name) => `${name}/`).join("\n");
  return { content: [{ type: "text", text }] };
}

function valueAt(value: unknown, field: string): unknown {
  return value && typeof value === "object" ? (value as Record<string, unknown>)[field] : undefined;
}

function exactWikiPaths(
  activeWikiRoot: string,
  writePaths: readonly string[] | undefined,
  role: string,
): Set<string> {
  if (!writePaths?.length) throw new Error(`Workflow configuration error: ${role} require at least one assigned Wiki page`);
  const allowed = new Set<string>();
  for (const rawPath of writePaths) {
    if (typeof rawPath !== "string" || !rawPath) throw new Error("Workflow configuration error: invalid writer page path");
    const relative = rawPath.startsWith("wiki/") ? rawPath.slice("wiki/".length) : undefined;
    if (!isSafeWikiPagePath(relative)) {
      throw new Error(`Workflow configuration error: writer path must be a non-index Markdown page under the active Wiki root: ${rawPath}`);
    }
    allowed.add(path.resolve(activeWikiRoot, ...relative.split("/")));
  }
  return allowed;
}

function remapToolPath(
  definition: ToolDefinition<any, any, any>,
  policy: WorkspaceToolPolicy,
  activeWikiRoot: string,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  return {
    ...definition,
    async execute(toolCallId, params, signal, onUpdate, context) {
      const rawPath = valueAt(params, "path");
      const mapped = typeof rawPath === "string" ? resolveToolPath(policy, activeWikiRoot, rawPath) : undefined;
      const mappedParams = mapped
        ? { ...(params as Record<string, unknown>), path: mapped }
        : params;
      return await execute(toolCallId, mappedParams, signal, onUpdate, context);
    },
  } as ToolDefinition<any, any, any>;
}

function resolveToolPath(policy: WorkspaceToolPolicy, activeWikiRoot: string, rawPath: string): string | undefined {
  if (policy.candidateWikiRoot && (rawPath === "wiki" || rawPath.startsWith("wiki/"))) {
    return path.resolve(activeWikiRoot, rawPath === "wiki" ? "." : rawPath.slice("wiki/".length));
  }
  return resolveSkillRelativePath(policy, rawPath);
}

/** Resolve Agent Skills relative paths against the materialized skill root. */
function resolveSkillRelativePath(policy: WorkspaceToolPolicy, rawPath: string): string | undefined {
  if (!policy.skillRoot) return undefined;
  const posix = rawPath.replaceAll("\\", "/");
  if (posix === "SKILL.md" || posix === "references" || posix.startsWith("references/")
    || posix === "briefs" || posix.startsWith("briefs/")) {
    return path.resolve(policy.skillRoot, ...posix.split("/"));
  }
  return undefined;
}

function writerDirectories(wikiRoot: string, allowedPaths: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>([path.resolve(wikiRoot)]);
  for (const file of allowedPaths) {
    let directory = path.dirname(file);
    while (pathIsInside(path.resolve(wikiRoot), directory)) {
      directories.add(directory);
      if (directory === path.resolve(wikiRoot)) break;
      directory = path.dirname(directory);
    }
  }
  return directories;
}

function assertExactWriterPath(allowedPaths: ReadonlySet<string>, candidate: string): void {
  if (!allowedPaths.has(path.resolve(candidate))) {
    throw new Error(`Path is not assigned to this Wiki page writer: ${candidate}`);
  }
}

async function guardedMkdir(root: string, directory: string, allowedDirectories: ReadonlySet<string>): Promise<void> {
  await ensureWikiRoot(root);
  if (!allowedDirectories.has(path.resolve(directory))) throw new Error(`Directory is not assigned to this Wiki page writer: ${directory}`);
  await assertContainedAbsolutePath(root, directory, true);
  await mkdir(directory, { recursive: true });
}

async function guardedWrite(root: string, file: string, content: string, allowedPaths: ReadonlySet<string>, writer: WikiPageWriter): Promise<void> {
  await ensureWikiRoot(root);
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, true);
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  await writer.replacePage({ path: `wiki/${relative}`, content, actor: "writer" });
}

async function guardedRead(root: string, file: string, allowedPaths: ReadonlySet<string>): Promise<Buffer> {
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, false);
  return await readFile(file);
}

async function guardedAccess(root: string, file: string, allowedPaths: ReadonlySet<string>): Promise<void> {
  assertExactWriterPath(allowedPaths, file);
  await assertContainedAbsolutePath(root, file, false);
  await access(file);
}

function assertLeadMarkdownPath(root: string, candidate: string): void {
  const absolute = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), absolute);
  if (!relative || !pathIsInside(path.resolve(root), absolute) || !relative.endsWith(".md")
    || relative.split(path.sep).some((part) => part === "." || part === ".." || !part)) {
    throw new Error(`Lead may write only Markdown files under the candidate Wiki: ${candidate}`);
  }
}

async function guardedLeadMkdir(root: string, directory: string): Promise<void> {
  await ensureWikiRoot(root);
  await assertContainedAbsolutePath(root, directory, true);
  await mkdir(directory, { recursive: true });
}

async function guardedLeadWrite(root: string, file: string, content: string, writer: WikiPageWriter): Promise<void> {
  await ensureWikiRoot(root);
  assertLeadMarkdownPath(root, file);
  const relative = path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join("/");
  if (!isSafeWikiPagePath(relative) && path.posix.basename(relative) !== "log.md") {
    throw new Error(`Lead may write only safe concept pages or log.md: ${file}`);
  }
  await assertContainedAbsolutePath(root, file, true);
  await writer.replacePage({ path: `wiki/${relative}`, content, actor: "lead" });
}

async function guardedLeadRead(root: string, file: string): Promise<Buffer> {
  assertLeadMarkdownPath(root, file);
  await assertContainedAbsolutePath(root, file, false);
  return await readFile(file);
}

async function guardedLeadAccess(root: string, file: string): Promise<void> {
  assertLeadMarkdownPath(root, file);
  await assertContainedAbsolutePath(root, file, false);
  await access(file);
}
