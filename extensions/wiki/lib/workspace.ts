import { cp, link, lstat, mkdir, open, readFile, realpath, rm, rmdir, symlink } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import YAML from "yaml";
import { renamePath, withExclusiveLock, writeFileDurable } from "./files.js";
import { git, repositoryRoot, type GitResult } from "./git.js";
import { errorMessage } from "./failures.js";
import { isWikiSourceDirectoryName } from "./path.js";
import { parseCatalogConfig, type WikiCatalogConfig } from "./catalog.js";
import { packagedTemplatesRoot } from "./templates.js";

const WORKSPACE_FILE = "workspace.yaml";
const WORKSPACE_ENV_FILE = ".env";
const IMPLICIT_DATABASE_FILE = path.join(".okf-wiki", "database.yaml");
const WORKSPACE_LOCK_FILE = ".okf-wiki-workspace.lock";
export const WORKSPACE_TEMPLATES_DIRECTORY = "wiki-templates";
const RESERVED_WORKSPACE_DIRECTORIES = new Set([
  "wiki", ".okf-wiki", WORKSPACE_TEMPLATES_DIRECTORY, "self", "source", "sources", "repos",
]);
const WINDOWS_RESERVED_SOURCE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface WikiWorkspaceSource {
  /** The actual top-level directory name, never a separate alias. */
  path: string;
  /** Optional named Catalog shared by one or more Sources. */
  catalog?: string;
  origin: { type: "link"; localPath: string } | { type: "clone"; remoteUrl: string; ref?: string };
}

export interface WikiWorkspaceWikiConfig {
  exclude: string[];
  /** Total concurrent model sessions, including the Lead. */
  maxConcurrentAgents: number;
  /** Maximum same-session worker follow-ups for locally repairable completion issues. */
  maxWorkerRepairRounds: number;
  /** Pi retries after a transient model failure. */
  transientRetries: number;
  /** Base delay for Pi's exponential retry backoff. */
  baseRetryDelayMs: number;
  /** Wall-clock deadline for each Lead or delegated Agent session. */
  sessionTimeoutSeconds: number;
  /** Workspace-relative directory that replaces the packaged template pack. */
  templates?: string;
}

export const DEFAULT_WORKSPACE_WIKI_CONFIG: WikiWorkspaceWikiConfig = {
  exclude: [],
  maxConcurrentAgents: 3,
  maxWorkerRepairRounds: 6,
  transientRetries: 1,
  baseRetryDelayMs: 1_000,
  sessionTimeoutSeconds: 1_200,
};

export interface WikiWorkspaceCatalog {
  url: string;
  schema: string;
  tables: string[];
}

export interface WikiWorkspace {
  version: 1;
  root: string;
  configPath?: string;
  language: "zh" | "en";
  defaultSourceIgnores: boolean;
  wiki: WikiWorkspaceWikiConfig;
  catalogs: Record<string, WikiWorkspaceCatalog>;
  sources: WikiWorkspaceSource[];
}

export interface ResolvedWikiSource extends WikiWorkspaceSource {
  absolutePath: string;
  realPath: string;
  repositoryRoot: string;
}

export interface ResolvedWikiWorkspace extends WikiWorkspace {
  configPath: string;
  sources: ResolvedWikiSource[];
}

export interface InitWikiWorkspaceRequest {
  cwd: string;
  workspace?: string;
  language?: "zh" | "en";
  defaultSourceIgnores?: boolean;
  wikiExclude?: string[];
}

export interface AddLinkedWikiSourceRequest {
  cwd: string;
  workspace?: string;
  localPath: string;
  name?: string;
  catalog?: string;
}

export interface AddClonedWikiSourceRequest {
  cwd: string;
  workspace?: string;
  remoteUrl: string;
  ref?: string;
  name?: string;
  catalog?: string;
}

export interface WikiWorkspaceManagement {
  init(request: InitWikiWorkspaceRequest): Promise<ResolvedWikiWorkspace>;
  addLink(request: AddLinkedWikiSourceRequest): Promise<ResolvedWikiWorkspace>;
  addClone(request: AddClonedWikiSourceRequest): Promise<ResolvedWikiWorkspace>;
}

interface WikiWorkspaceManagementDependencies {
  platform?: NodeJS.Platform;
  createDirectoryLink?: (target: string, location: string, type: "dir" | "junction") => Promise<void>;
  runGit?: (cwd: string, args: string[]) => Promise<GitResult>;
  writeConfig?: (configPath: string, workspace: WikiWorkspace, exclusive: boolean) => Promise<void>;
}

/** Workspace lifecycle Module. Path policy, Git checks and rollback stay behind this interface. */
export function createWikiWorkspaceManagement(
  dependencies: WikiWorkspaceManagementDependencies = {},
): WikiWorkspaceManagement {
  const platform = dependencies.platform ?? process.platform;
  const createDirectoryLink = dependencies.createDirectoryLink
    ?? (async (target, location, type) => await symlink(target, location, type));
  const runGit = dependencies.runGit ?? git;
  const writeConfig = dependencies.writeConfig ?? writeWorkspaceConfig;

  return {
    async init(request) {
      const root = workspaceArgument(request.cwd, request.workspace);
      const configPath = path.join(root, WORKSPACE_FILE);
      const exclude = normalizeStringArray(request.wikiExclude ?? [], "wikiExclude");
      if (await pathEntry(configPath)) throw new Error(`Wiki workspace already exists: ${configPath}`);
      const existed = Boolean(await pathEntry(root));
      if (existed && !(await lstat(root)).isDirectory()) throw new Error(`Workspace path is not a directory: ${root}`);
      await mkdir(root, { recursive: true });
      const language = request.language ?? "zh";
      const templatesDir = path.join(root, WORKSPACE_TEMPLATES_DIRECTORY);
      let copiedTemplates = false;
      try {
        await seedWorkspaceTemplates(templatesDir, language);
        copiedTemplates = true;
        await writeConfig(configPath, {
          version: 1,
          root,
          configPath,
          language,
          defaultSourceIgnores: request.defaultSourceIgnores ?? true,
          wiki: { ...structuredClone(DEFAULT_WORKSPACE_WIKI_CONFIG), exclude, templates: WORKSPACE_TEMPLATES_DIRECTORY },
          catalogs: {},
          sources: [],
        }, true);
      } catch (error) {
        if (copiedTemplates) await rm(templatesDir, { recursive: true, force: true });
        if (!existed) await removeEmptyDirectory(root);
        throw error;
      }
      return await loadWikiWorkspace(root);
    },

    async addLink(request) {
      const localPath = await realpath(path.resolve(request.cwd, request.localPath));
      await assertGitRepositoryRoot(localPath, runGit);
      const initial = await explicitWorkspace(request.cwd, request.workspace);
      return await withWorkspaceLock(initial.root, async () => {
        const workspace = await loadWikiWorkspace(initial.root);
        const workspaceRealPath = await realpath(workspace.root);
        if (containsPath(localPath, workspaceRealPath)) {
          throw new Error("Source cannot be the workspace itself or its ancestor");
        }
        const name = sourceName(request.name ?? path.basename(localPath), platform);
        const catalog = sourceCatalog(request.catalog, workspace.catalogs);
        assertAvailableSource(workspace, name, platform);
        assertPhysicalSourceAvailable(workspace, localPath);
        const location = path.join(workspace.root, name);
        await assertDestinationAvailable(location, name);
        const type = platform === "win32" ? "junction" : "dir";
        let created = false;
        try {
          await createDirectoryLink(localPath, location, type);
          created = true;
          await persistAddedSource(workspace, {
            path: name,
            ...(catalog ? { catalog } : {}),
            origin: { type: "link", localPath },
          }, writeConfig);
        } catch (error) {
          if (created) await rm(location, { recursive: true, force: true });
          throw error;
        }
        return await loadWikiWorkspace(workspace.root);
      });
    },

    async addClone(request) {
      const remoteUrl = nonEmpty(request.remoteUrl, "remoteUrl");
      const ref = request.ref === undefined ? undefined : nonEmpty(request.ref, "ref");
      const initial = await explicitWorkspace(request.cwd, request.workspace);
      const name = sourceName(request.name ?? repositoryName(remoteUrl), platform);
      sourceCatalog(request.catalog, initial.catalogs);
      const staging = path.join(initial.root, `.okf-wiki-clone-${process.pid}-${Math.random().toString(16).slice(2)}`);
      try {
        await successfulGit(initial.root, ["clone", "--", remoteUrl, staging], runGit);
        if (ref) await successfulGit(staging, ["checkout", "--detach", ref], runGit);
        await assertGitRepositoryRoot(staging, runGit);
        return await withWorkspaceLock(initial.root, async () => {
          const workspace = await loadWikiWorkspace(initial.root);
          const catalog = sourceCatalog(request.catalog, workspace.catalogs);
          assertAvailableSource(workspace, name, platform);
          const location = path.join(workspace.root, name);
          await assertDestinationAvailable(location, name);
          let installed = false;
          try {
            await renamePath(staging, location);
            installed = true;
            await persistAddedSource(workspace, {
              path: name,
              ...(catalog ? { catalog } : {}),
              origin: { type: "clone", remoteUrl, ...(ref ? { ref } : {}) },
            }, writeConfig);
          } catch (error) {
            await rm(staging, { recursive: true, force: true });
            if (installed) await rm(location, { recursive: true, force: true });
            throw error;
          }
          return await loadWikiWorkspace(workspace.root);
        });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },
  };
}

export const wikiWorkspaceManagement = createWikiWorkspaceManagement();

export async function loadWikiWorkspace(cwd: string): Promise<ResolvedWikiWorkspace> {
  const configPath = await findWorkspaceConfig(cwd);
  if (!configPath) return await implicitSelfWorkspace(cwd);
  const root = path.dirname(configPath);
  const workspace = await readWorkspaceConfig(configPath, root, true);
  if (!workspace) throw new Error("workspace.yaml is missing");
  const workspaceRealPath = await realpath(root);
  const sources = await Promise.all(workspace.sources.map(async (source) => {
    const absolutePath = path.join(root, source.path);
    const realPath = await realpath(absolutePath);
    const sourceRepository = await repositoryRoot(realPath);
    const repository = await realpath(sourceRepository);
    if (repository !== realPath) throw new Error(`Source must point to a Git repository root: ${source.path}`);
    if (repository === workspaceRealPath) throw new Error(`Source cannot be the workspace itself: ${source.path}`);
    return { ...source, absolutePath, realPath, repositoryRoot: repository };
  }));
  return { ...workspace, root, configPath, sources };
}

async function implicitSelfWorkspace(cwd: string): Promise<ResolvedWikiWorkspace> {
  const requested = await realpath(path.resolve(cwd));
  const repository = await realpath(await repositoryRoot(requested));
  const source: ResolvedWikiSource = {
    path: ".",
    origin: { type: "link", localPath: repository },
    absolutePath: repository,
    realPath: repository,
    repositoryRoot: repository,
  };
  const catalog = await readImplicitCatalogConfig(repository);
  if (catalog) source.catalog = "self";
  return {
    version: 1,
    root: repository,
    configPath: path.join(repository, WORKSPACE_FILE),
    language: "zh",
    defaultSourceIgnores: true,
    wiki: structuredClone(DEFAULT_WORKSPACE_WIKI_CONFIG),
    catalogs: catalog ? { self: catalog } : {},
    sources: [source],
  };
}

/** Implicit Workspaces declare a Catalog in `.okf-wiki/database.yaml` (a lone `database:` block). */
async function readImplicitCatalogConfig(root: string): Promise<WikiWorkspaceCatalog | undefined> {
  const configPath = path.join(root, IMPLICIT_DATABASE_FILE);
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${IMPLICIT_DATABASE_FILE} at ${configPath}: ${errorMessage(error)}`);
  }
  if (!isRecord(document)) throw new Error(`${IMPLICIT_DATABASE_FILE} must be a mapping with one database block`);
  const unknown = Object.keys(document).filter((key) => key !== "database");
  if (unknown.length > 0) throw new Error(`${IMPLICIT_DATABASE_FILE} has unknown field: ${unknown[0]}`);
  if (document.database === undefined) {
    throw new Error(`${IMPLICIT_DATABASE_FILE} must contain a database block`);
  }
  return parseWorkspaceCatalog(document.database, "database", await workspaceEnvironment(root));
}

async function findWorkspaceConfig(cwd: string): Promise<string | undefined> {
  let candidate = path.resolve(cwd);
  while (true) {
    const config = path.join(candidate, WORKSPACE_FILE);
    try {
      if ((await lstat(config)).isFile()) return config;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return undefined;
    candidate = parent;
  }
}

async function readWorkspaceConfig(configPath: string, rootPath: string, required: boolean): Promise<WikiWorkspace | undefined> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (!required && isMissing(error)) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = YAML.parse(text);
  } catch (error) {
    throw new Error(`Invalid workspace.yaml at ${configPath}: ${errorMessage(error)}`);
  }
  if (!isRecord(document)) throw new Error(`Invalid workspace.yaml at ${configPath}: expected a mapping with numeric version 1`);
  const root = strictObject(document, "root", [
    "version", "language", "defaultSourceIgnores", "wiki", "catalogs", "sources",
  ]);
  if (root.version !== 1) {
    const received = JSON.stringify(root.version) ?? String(root.version);
    throw new Error(`Invalid workspace.yaml at ${configPath}: expected numeric version 1, received ${received} (${typeof root.version})`);
  }
  if (root.language !== "zh" && root.language !== "en") throw new Error("workspace.yaml language must be zh or en");
  if (typeof root.defaultSourceIgnores !== "boolean") throw new Error("workspace.yaml defaultSourceIgnores must be true or false");
  const wiki = root.wiki === undefined ? structuredClone(DEFAULT_WORKSPACE_WIKI_CONFIG) : parseWikiConfig(root.wiki);
  const catalogs = root.catalogs === undefined
    ? {}
    : parseWorkspaceCatalogs(root.catalogs, await workspaceEnvironment(rootPath));
  if (!Array.isArray(root.sources)) throw new Error("workspace.yaml sources must be an array");
  const seen = new Set<string>();
  const sources = root.sources.map((value) => parseSource(value, seen, catalogs));
  return {
    version: 1, root: rootPath, configPath, language: root.language, defaultSourceIgnores: root.defaultSourceIgnores, wiki,
    catalogs,
    sources,
  };
}

export async function resolveWorkspaceCatalogs(
  catalogs: Readonly<Record<string, WikiWorkspaceCatalog>>,
  root: string,
): Promise<Map<string, WikiCatalogConfig>> {
  if (!Object.keys(catalogs).length) return new Map();
  const env = await workspaceEnvironment(root);
  return new Map(Object.entries(catalogs).map(([name, database]) => [
    name,
    parseCatalogConfig(database, `catalogs.${name}`, env),
  ]));
}

function parseWorkspaceCatalog(
  value: unknown,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): WikiWorkspaceCatalog {
  const parsed = parseCatalogConfig(value, field, env);
  const raw = isRecord(value) && typeof value.url === "string" ? value.url.trim() : parsed.url;
  return { url: raw, schema: parsed.schema, tables: parsed.tables };
}

function parseWorkspaceCatalogs(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, WikiWorkspaceCatalog> {
  if (!isRecord(value)) throw new Error("workspace.yaml catalogs must be an object");
  return Object.fromEntries(Object.entries(value).map(([name, database]) => {
    if (!isWikiSourceDirectoryName(name)) throw new Error(`workspace.yaml Catalog name is invalid: ${name}`);
    return [name, parseWorkspaceCatalog(database, `catalogs.${name}`, env)];
  }));
}

function parseWikiConfig(value: unknown): WikiWorkspaceWikiConfig {
  const wiki = strictObject(value, "wiki", [
    "exclude", "maxConcurrentAgents", "maxWorkerRepairRounds", "transientRetries", "baseRetryDelayMs", "sessionTimeoutSeconds", "templates",
  ]);
  const templates = parseTemplatesPath(wiki.templates);
  return {
    exclude: parseStringArray(wiki.exclude, "wiki.exclude"),
    maxConcurrentAgents: parseInteger(wiki.maxConcurrentAgents, "wiki.maxConcurrentAgents", DEFAULT_WORKSPACE_WIKI_CONFIG.maxConcurrentAgents, 2, 64),
    maxWorkerRepairRounds: parseInteger(wiki.maxWorkerRepairRounds, "wiki.maxWorkerRepairRounds", DEFAULT_WORKSPACE_WIKI_CONFIG.maxWorkerRepairRounds, 1, 64),
    transientRetries: parseInteger(wiki.transientRetries, "wiki.transientRetries", DEFAULT_WORKSPACE_WIKI_CONFIG.transientRetries, 0, 10),
    baseRetryDelayMs: parseInteger(wiki.baseRetryDelayMs, "wiki.baseRetryDelayMs", DEFAULT_WORKSPACE_WIKI_CONFIG.baseRetryDelayMs, 0, 300_000),
    sessionTimeoutSeconds: parseInteger(wiki.sessionTimeoutSeconds, "wiki.sessionTimeoutSeconds", DEFAULT_WORKSPACE_WIKI_CONFIG.sessionTimeoutSeconds, 1, 2_147_483),
    ...(templates ? { templates } : {}),
  };
}

function parseTemplatesPath(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("workspace.yaml wiki.templates must be a non-empty relative path");
  }
  const relative = value.trim().replaceAll("\\", "/");
  if (path.isAbsolute(value.trim()) || relative.startsWith("/") || relative === "." || relative.split("/").includes("..")) {
    throw new Error("workspace.yaml wiki.templates must be a relative path inside the Workspace");
  }
  return relative;
}

async function workspaceEnvironment(root: string): Promise<Record<string, string | undefined>> {
  try {
    const file = parseEnv(await readFile(path.join(root, WORKSPACE_ENV_FILE), "utf8"));
    return { ...file, ...process.env };
  } catch (error) {
    if (isMissing(error)) return process.env;
    throw new Error(`Invalid ${WORKSPACE_ENV_FILE}: ${errorMessage(error)}`);
  }
}

function strictObject(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`workspace.yaml ${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`workspace.yaml ${field} has unknown field: ${unknown[0]}`);
  return value;
}

function parseStringArray(value: unknown, field: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`workspace.yaml ${field} must be an array of non-empty strings`);
  }
  const result = [...new Set(value.map((entry) => String(entry).trim()))];
  if (required && result.length === 0) throw new Error(`workspace.yaml ${field} must not be empty`);
  return result;
}

function normalizeStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => String(entry).trim()))];
}

function parseInteger(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`workspace.yaml ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function parseSource(
  value: unknown,
  seen: Set<string>,
  catalogs: Readonly<Record<string, WikiWorkspaceCatalog>>,
): WikiWorkspaceSource {
  const source = strictObject(value, "source", ["path", "catalog", "origin"]);
  if (typeof source.path !== "string" || !isWikiSourceDirectoryName(source.path) || RESERVED_WORKSPACE_DIRECTORIES.has(source.path) || seen.has(source.path)) {
    throw new Error("workspace.yaml source paths must be unique project directory names");
  }
  seen.add(source.path);
  const catalog = sourceCatalog(source.catalog, catalogs, `workspace.yaml source ${source.path}`);
  if (!isRecord(source.origin) || typeof source.origin.type !== "string") throw new Error(`Invalid source origin for ${source.path}`);
  if (source.origin.type === "link" && typeof source.origin.localPath === "string") {
    return { path: source.path, ...(catalog ? { catalog } : {}), origin: { type: "link", localPath: source.origin.localPath } };
  }
  if (source.origin.type === "clone" && typeof source.origin.remoteUrl === "string") {
    if (source.origin.ref !== undefined && typeof source.origin.ref !== "string") throw new Error(`Invalid clone ref for ${source.path}`);
    return {
      path: source.path,
      ...(catalog ? { catalog } : {}),
      origin: { type: "clone", remoteUrl: source.origin.remoteUrl, ref: source.origin.ref as string | undefined },
    };
  }
  throw new Error(`Invalid source origin for ${source.path}`);
}

function sourceCatalog(
  value: unknown,
  catalogs: Readonly<Record<string, WikiWorkspaceCatalog>>,
  field = "catalog",
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty Catalog name`);
  const name = value.trim();
  if (!Object.hasOwn(catalogs, name)) throw new Error(`${field} references unknown Catalog: ${name}`);
  return name;
}

function sourceName(value: string, platform: NodeJS.Platform): string {
  const normalized = value.trim();
  const comparable = platform === "win32" ? normalized.toLowerCase() : normalized;
  if (RESERVED_WORKSPACE_DIRECTORIES.has(comparable)) throw new Error(`Project name is reserved by the workspace: ${normalized}`);
  if (platform === "win32" && (WINDOWS_RESERVED_SOURCE_NAMES.test(normalized) || /[. ]$/.test(value))) {
    throw new Error(`Project name is reserved on Windows: ${value}`);
  }
  if (!isWikiSourceDirectoryName(normalized)) throw new Error(`Invalid source name: ${value}`);
  return normalized;
}

function repositoryName(remoteUrl: string): string {
  const withoutQuery = remoteUrl.replace(/[?#].*$/, "").replace(/[\\/]+$/, "");
  const candidate = withoutQuery.slice(Math.max(withoutQuery.lastIndexOf("/"), withoutQuery.lastIndexOf(":")) + 1)
    .replace(/\.git$/i, "");
  if (!candidate) throw new Error("Could not derive a source name from remoteUrl; provide name");
  return candidate;
}

function workspaceArgument(cwd: string, workspace: string | undefined): string {
  return path.resolve(cwd, workspace ?? ".");
}

async function seedWorkspaceTemplates(templatesDir: string, language: "zh" | "en"): Promise<void> {
  if (await pathEntry(templatesDir)) throw new Error(`Wiki templates already exist: ${templatesDir}`);
  const staged = `${templatesDir}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await cp(packagedTemplatesRoot(language), staged, { recursive: true });
  try {
    await renamePath(staged, templatesDir);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

async function explicitWorkspace(cwd: string, workspace: string | undefined): Promise<ResolvedWikiWorkspace> {
  const requested = workspaceArgument(cwd, workspace);
  const configPath = await findWorkspaceConfig(requested);
  if (!configPath) throw new Error(`No workspace.yaml found from: ${requested}`);
  return await loadWikiWorkspace(requested);
}

function assertAvailableSource(workspace: ResolvedWikiWorkspace, name: string, platform: NodeJS.Platform): void {
  const comparable = platform === "win32" ? name.toLowerCase() : name;
  const existing = workspace.sources.find((source) => (platform === "win32" ? source.path.toLowerCase() : source.path) === comparable);
  if (existing) throw new Error(`Wiki source already exists: ${name}`);
}

function assertPhysicalSourceAvailable(workspace: ResolvedWikiWorkspace, localPath: string): void {
  if (workspace.sources.some((source) => source.realPath === localPath)) {
    throw new Error(`Git source is already added: ${localPath}`);
  }
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertDestinationAvailable(location: string, name: string): Promise<void> {
  if (await pathEntry(location)) throw new Error(`Workspace path already exists for source ${name}`);
}

async function persistAddedSource(
  workspace: ResolvedWikiWorkspace,
  source: WikiWorkspaceSource,
  writeConfig: (configPath: string, workspace: WikiWorkspace, exclusive: boolean) => Promise<void>,
): Promise<void> {
  await writeConfig(workspace.configPath, {
    ...workspace,
    sources: [...workspace.sources.map(({ absolutePath: _absolute, realPath: _real, repositoryRoot: _repository, ...value }) => value), source],
  }, false);
}

async function writeWorkspaceConfig(configPath: string, workspace: WikiWorkspace, exclusive = false): Promise<void> {
  const content = YAML.stringify({
    version: 1,
    language: workspace.language,
    defaultSourceIgnores: workspace.defaultSourceIgnores,
    wiki: workspace.wiki,
    ...(Object.keys(workspace.catalogs).length ? { catalogs: workspace.catalogs } : {}),
    sources: workspace.sources,
  });
  await writeAtomic(configPath, content, exclusive);
}

async function writeAtomic(target: string, content: string, exclusive: boolean): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  if (!exclusive) {
    await writeFileDurable(target, content);
    return;
  }
  const temporary = `${target}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    try {
      await link(temporary, target);
    } catch (error) {
      if (isAlreadyExists(error)) throw new Error(`Wiki workspace already exists: ${target}`);
      throw error;
    }
    await rm(temporary, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertGitRepositoryRoot(candidate: string, runGit: (cwd: string, args: string[]) => Promise<GitResult>): Promise<void> {
  const result = await runGit(candidate, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Source is not a Git repository: ${candidate}`);
  const root = await realpath(result.stdout.trim());
  if (root !== await realpath(candidate)) throw new Error(`Source must point to a Git repository root: ${candidate}`);
}

async function successfulGit(cwd: string, args: string[], runGit: (cwd: string, args: string[]) => Promise<GitResult>): Promise<void> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

async function pathEntry(location: string) {
  try {
    return await lstat(location);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function withWorkspaceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  return await withExclusiveLock(path.join(root, WORKSPACE_LOCK_FILE), operation);
}

async function removeEmptyDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    if (!error || typeof error !== "object" || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "EEXIST");
}
