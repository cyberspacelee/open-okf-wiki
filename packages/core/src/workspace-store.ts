import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  WorkspaceConfigSchema,
  WorkspaceLimitsSchema,
  WorkspaceSourceSchema,
  type GitProbe,
  type WorkspaceConfig,
  type WorkspaceSource,
} from "@okf-wiki/contract";
import { probeLocalGit } from "./git.js";
import { assertAbsolutePath, resolveExistingDir } from "./paths.js";

export const WORKSPACE_DIR_NAME = ".okf-wiki";
export const WORKSPACE_FILE_NAME = "workspace.json";
export const APP_STATE_FILE_NAME = "app.json";
export const DEFAULT_MODEL_ID = "openai/default";
const RECENT_WORKSPACE_LIMIT = 32;

/** Absolute path to `{root}/.okf-wiki/workspace.json`. */
export function workspaceConfigPath(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME, WORKSPACE_FILE_NAME);
}

/** Absolute path to `{root}/.okf-wiki`. */
export function workspaceMetaDir(rootPath: string): string {
  return path.join(path.resolve(rootPath), WORKSPACE_DIR_NAME);
}

/**
 * User-level app state file.
 * `$OKF_WIKI_HOME/app.json` when set, otherwise `~/.okf-wiki/app.json`.
 */
export function defaultAppStatePath(): string {
  const home = process.env.OKF_WIKI_HOME?.trim();
  if (home) {
    return path.join(path.resolve(home), APP_STATE_FILE_NAME);
  }
  return path.join(homedir(), WORKSPACE_DIR_NAME, APP_STATE_FILE_NAME);
}

/** True if `child` is `parent` or a path strictly inside it. */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  if (resolvedParent === resolvedChild) {
    return true;
  }
  const rel = path.relative(resolvedParent, resolvedChild);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export type CreateWorkspaceOptions = {
  name: string;
  rootPath: string;
  publicationPath?: string;
  /** @deprecated Prefer modelProfileId — free-text model id only as fallback. */
  modelId?: string;
  /** Settings model profile id; denormalizes model.id from the catalog. */
  modelProfileId?: string;
  /** Denormalized served model id when profile is known. */
  resolvedModelId?: string;
};

/**
 * Create workspace directories and an in-memory config skeleton.
 * Call {@link saveWorkspace} to persist (empty sources allowed as a draft).
 */
export async function createWorkspace(options: CreateWorkspaceOptions): Promise<WorkspaceConfig> {
  if (typeof options.name !== "string" || options.name.trim() === "") {
    throw new Error("name must be a non-empty string");
  }

  const rootPath = path.resolve(assertAbsolutePath(options.rootPath, "rootPath"));
  await mkdir(rootPath, { recursive: true });

  const okfDir = path.join(rootPath, WORKSPACE_DIR_NAME);
  await mkdir(okfDir, { recursive: true });

  // Reject if a workspace.json already exists at this root.
  try {
    await access(workspaceConfigPath(rootPath));
    throw new Error(`workspace already exists at ${rootPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("workspace already exists")) {
      throw error;
    }
    // Only missing config is OK; re-throw EACCES/EPERM/etc.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const publicationPath =
    options.publicationPath !== undefined && options.publicationPath.trim() !== ""
      ? path.resolve(assertAbsolutePath(options.publicationPath, "publicationPath"))
      : path.join(rootPath, "wiki");
  await mkdir(publicationPath, { recursive: true });

  const modelId =
    options.resolvedModelId?.trim() ||
    options.modelId?.trim() ||
    DEFAULT_MODEL_ID;
  const modelProfileId = options.modelProfileId?.trim() || undefined;

  const now = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    name: options.name.trim(),
    rootPath,
    sources: [],
    model: {
      id: modelId,
      ...(modelProfileId ? { profileId: modelProfileId } : {}),
    },
    publicationPath,
    limits: WorkspaceLimitsSchema.parse({}),
    adaptive: false,
    reviewer: false,
    createdAt: now,
    lastOpenedAt: now,
  };
}

/** Load and validate `{rootPath}/.okf-wiki/workspace.json`. */
export async function loadWorkspace(rootPath: string): Promise<WorkspaceConfig> {
  const resolvedRoot = await resolveExistingDir(rootPath);
  const filePath = workspaceConfigPath(resolvedRoot);

  // Path containment: only ever read workspace.json under <root>/.okf-wiki/
  if (!isPathInside(resolvedRoot, filePath)) {
    throw new Error("workspace config path escapes root");
  }

  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    throw new Error(`workspace config not found: ${filePath}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid workspace JSON at ${filePath}: ${message}`);
  }

  const parsed = WorkspaceConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`invalid workspace config at ${filePath}: ${parsed.error.message}`);
  }

  // Prefer the requested rootPath (resolved) over a stale on-disk value.
  return { ...parsed.data, rootPath: resolvedRoot };
}

/** Validate and write `{config.rootPath}/.okf-wiki/workspace.json`. */
export async function saveWorkspace(config: WorkspaceConfig): Promise<void> {
  const parsed = WorkspaceConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`invalid workspace config: ${parsed.error.message}`);
  }

  const valid = parsed.data;
  const rootPath = path.resolve(valid.rootPath);
  const okfDir = path.join(rootPath, WORKSPACE_DIR_NAME);
  if (!isPathInside(rootPath, okfDir) || path.basename(okfDir) !== WORKSPACE_DIR_NAME) {
    throw new Error("refusing to write outside workspace meta directory");
  }
  await mkdir(okfDir, { recursive: true });

  const filePath = path.join(okfDir, WORKSPACE_FILE_NAME);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify({ ...valid, rootPath }, null, 2)}\n`;

  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
}

export type AddSourceInput = {
  id: string;
  path: string;
  applyDefaultIgnores?: boolean;
  ignore?: string[];
};

export type AddSourceOptions = {
  /**
   * When true (default), reject dirty working trees.
   * Set false when editing saved workspace config; probe is still returned.
   */
  requireClean?: boolean;
};

/**
 * Probe a local Git path and append it as a workspace source.
 * Always fails when the path is not a Git working tree.
 */
export async function addSource(
  config: WorkspaceConfig,
  input: AddSourceInput,
  options: AddSourceOptions = {},
): Promise<{ config: WorkspaceConfig; probe: GitProbe; source: WorkspaceSource }> {
  const requireClean = options.requireClean ?? true;
  const absoluteSourcePath = assertAbsolutePath(input.path, "path");
  const sourcePath = await resolveExistingDir(absoluteSourcePath);
  const probe = await probeLocalGit(sourcePath);

  if (!probe.isGit) {
    const detail = probe.error ? `: ${probe.error}` : "";
    throw new Error(`not a git working tree: ${sourcePath}${detail}`);
  }
  if (requireClean && probe.dirty) {
    throw new Error(`git working tree is dirty: ${sourcePath}`);
  }

  if (config.sources.some((source) => source.id === input.id)) {
    throw new Error(`source id already exists: ${input.id}`);
  }
  if (config.sources.some((source) => path.resolve(source.path) === sourcePath)) {
    throw new Error(`source path already registered: ${sourcePath}`);
  }

  const source = WorkspaceSourceSchema.parse({
    id: input.id,
    path: sourcePath,
    applyDefaultIgnores: input.applyDefaultIgnores,
    ignore: input.ignore,
  });

  return {
    config: {
      ...config,
      sources: [...config.sources, source],
    },
    probe,
    source,
  };
}

/** Remove a source by id. Throws if missing. */
export function removeSource(config: WorkspaceConfig, sourceId: string): WorkspaceConfig {
  const sources = config.sources.filter((source) => source.id !== sourceId);
  if (sources.length === config.sources.length) {
    throw new Error(`source not found: ${sourceId}`);
  }
  return { ...config, sources };
}

type AppState = {
  version: 1;
  recentRootPaths: string[];
};

async function readAppState(appStatePath: string): Promise<AppState> {
  try {
    const raw = await readFile(appStatePath, "utf8");
    const data = JSON.parse(raw) as Partial<AppState>;
    const recent = Array.isArray(data.recentRootPaths)
      ? data.recentRootPaths.filter((p): p is string => typeof p === "string" && p.trim() !== "")
      : [];
    return { version: 1, recentRootPaths: recent };
  } catch {
    return { version: 1, recentRootPaths: [] };
  }
}

async function writeAppState(appStatePath: string, state: AppState): Promise<void> {
  const dir = path.dirname(appStatePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${appStatePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, appStatePath);
}

/** Prepend a workspace root to the user-level recent list. */
export async function registerWorkspaceInAppIndex(
  rootPath: string,
  appStatePath: string = defaultAppStatePath(),
): Promise<void> {
  const resolved = path.resolve(rootPath.trim());
  if (resolved === "" || rootPath.trim() === "") {
    throw new Error("rootPath must be a non-empty string");
  }

  const state = await readAppState(appStatePath);
  const recentRootPaths = [
    resolved,
    ...state.recentRootPaths.filter((entry) => path.resolve(entry) !== resolved),
  ].slice(0, RECENT_WORKSPACE_LIMIT);

  await writeAppState(appStatePath, { version: 1, recentRootPaths });
}

/** Remove a workspace root from the user-level recent list. */
export async function removeWorkspaceFromAppIndex(
  rootPath: string,
  appStatePath: string = defaultAppStatePath(),
): Promise<boolean> {
  const resolved = path.resolve(rootPath.trim());
  const state = await readAppState(appStatePath);
  const next = state.recentRootPaths.filter((entry) => path.resolve(entry) !== resolved);
  if (next.length === state.recentRootPaths.length) {
    return false;
  }
  await writeAppState(appStatePath, { version: 1, recentRootPaths: next });
  return true;
}

/** Read recent workspace root paths from the user-level app index. */
export async function listRecentWorkspaces(
  appStatePath: string = defaultAppStatePath(),
): Promise<string[]> {
  const state = await readAppState(appStatePath);
  return [...state.recentRootPaths];
}

/** Alias of {@link listRecentWorkspaces}. */
export async function listWorkspaces(
  appStatePath: string = defaultAppStatePath(),
): Promise<string[]> {
  return listRecentWorkspaces(appStatePath);
}

export type WorkspaceSummary = {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt?: string;
  sourceCount: number;
};

/** Load summaries for roots still present in the app index (skips broken entries). */
export async function listWorkspaceSummaries(
  appStatePath: string = defaultAppStatePath(),
): Promise<WorkspaceSummary[]> {
  const roots = await listRecentWorkspaces(appStatePath);
  const summaries: WorkspaceSummary[] = [];
  for (const root of roots) {
    try {
      const ws = await loadWorkspace(root);
      summaries.push({
        id: ws.id,
        name: ws.name,
        rootPath: ws.rootPath,
        lastOpenedAt: ws.lastOpenedAt,
        sourceCount: ws.sources.length,
      });
    } catch {
      // Stale index entry — skip
    }
  }
  return summaries;
}

/**
 * Resolve a workspace by id using the app index of recent roots.
 * Optionally accept an explicit rootPath query to avoid scanning.
 */
export async function loadWorkspaceById(
  id: string,
  options: { rootPath?: string; appStatePath?: string } = {},
): Promise<WorkspaceConfig | null> {
  if (options.rootPath) {
    try {
      const ws = await loadWorkspace(options.rootPath);
      return ws.id === id ? ws : null;
    } catch {
      return null;
    }
  }

  const roots = await listRecentWorkspaces(options.appStatePath);
  for (const root of roots) {
    try {
      const ws = await loadWorkspace(root);
      if (ws.id === id) {
        return ws;
      }
    } catch {
      // skip stale
    }
  }
  return null;
}

/**
 * Carefully remove only `<root>/.okf-wiki` — never the whole workspace root.
 */
export async function deleteWorkspaceMeta(rootPath: string): Promise<void> {
  const resolved = path.resolve(rootPath);
  const meta = workspaceMetaDir(resolved);
  if (!isPathInside(resolved, meta) || path.resolve(meta) === resolved) {
    throw new Error("refusing to delete outside workspace meta directory");
  }
  if (path.basename(meta) !== WORKSPACE_DIR_NAME) {
    throw new Error("refusing to delete unexpected meta path");
  }
  await rm(meta, { recursive: true, force: true });
}

/** Derive a SourceIdSchema-compatible slug from a filesystem path. */
export function slugFromPath(rawPath: string): string {
  const base = path
    .basename(path.resolve(rawPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = base.length > 0 ? base : "source";
  if (!/^[a-z]/.test(slug)) {
    slug = `s-${slug}`;
  }
  return slug.slice(0, 63);
}

/** Pick an unused source id, appending -2, -3, … on collision. */
export function uniqueSourceId(desired: string, existing: readonly WorkspaceSource[]): string {
  const taken = new Set(existing.map((s) => s.id));
  if (!taken.has(desired) && /^[a-z][a-z0-9-]{0,62}$/.test(desired)) {
    return desired;
  }
  const base = /^[a-z][a-z0-9-]{0,62}$/.test(desired) ? desired : slugFromPath(desired);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, 60)}-${i}`.slice(0, 63);
    if (!taken.has(candidate) && /^[a-z][a-z0-9-]{0,62}$/.test(candidate)) {
      return candidate;
    }
  }
  return `src-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
