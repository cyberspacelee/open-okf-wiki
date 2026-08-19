import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, writeText } from "./files.js";
import { ensureWikiWorkspaceInternalIgnore } from "./workspace.js";

export const MAX_WIKI_RESEARCH_ARTIFACT_BYTES = 256 * 1024;

export type WikiArtifactKind = "research-handoff" | "write-handoff" | "review-handoff";

export interface WikiArtifactRef {
  version: 1;
  runId: string;
  contractId: string;
  attempt: number;
  /** Host-derived source/domain/lens scope. Model output never supplies this. */
  scope: string[];
  kind: WikiArtifactKind;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  mediaType: "text/markdown";
}

export interface WikiArtifactWrite {
  runId: string;
  contractId: string;
  attempt: number;
  /** Host-derived source/domain/lens scope. Model output never supplies this. */
  scope: readonly string[];
  kind: WikiArtifactKind;
  content: string;
}

export interface WikiArtifactStore {
  write(input: WikiArtifactWrite): Promise<WikiArtifactRef>;
  read(ref: WikiArtifactRef): Promise<string>;
}

interface WikiArtifactManifest {
  version: 1;
  artifacts: WikiArtifactRef[];
}

const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Minimal content-addressed Markdown handoff store used by the dynamic runtime. */
export function createWikiArtifactStore(options: { workspace: string }): WikiArtifactStore {
  const workspace = path.resolve(options.workspace);
  const okfRoot = path.join(workspace, ".okf-wiki");
  const runsRoot = path.join(okfRoot, "runs");
  const blobsRoot = path.join(okfRoot, "blobs");
  let chain = Promise.resolve();
  let ignored: Promise<void> | undefined;

  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    let result!: T;
    const next = chain.catch(() => undefined).then(async () => { result = await operation(); });
    chain = next.then(() => undefined, () => undefined);
    await next;
    return result;
  };

  return {
    async write(input) {
      return await serialize(async () => {
        validateLocation(input);
        ignored ??= ensureWikiWorkspaceInternalIgnore(workspace);
        await ignored;
        const bytes = Buffer.from(input.content, "utf8");
        assertSize(bytes);
        const sha256 = digest(bytes);
        const relativePath = `.okf-wiki/blobs/${sha256}.md`;
        const scope = [...input.scope];
        const ref: WikiArtifactRef = {
          version: 1,
          runId: input.runId,
          contractId: input.contractId,
          attempt: input.attempt,
          scope,
          kind: input.kind,
          relativePath,
          sha256,
          sizeBytes: bytes.byteLength,
          mediaType: "text/markdown",
        };
        const blob = path.join(blobsRoot, `${sha256}.md`);
        await ensureSafeDirectory(okfRoot, blobsRoot);
        await assertNoSymlinks(okfRoot, blob);
        try {
          const existing = await readFile(blob);
          if (digest(existing) !== sha256 || existing.byteLength !== bytes.byteLength) throw new Error(`Wiki handoff blob is corrupt: ${relativePath}`);
        } catch (error) {
          if (!isMissing(error)) throw error;
          await writeText(blob, input.content);
        }
        const manifestFile = path.join(runsRoot, input.runId, "manifest.json");
        const manifest = await readManifest(okfRoot, manifestFile);
        const previous = manifest.artifacts.find((entry) => sameLocation(entry, ref));
        if (previous && (previous.sha256 !== ref.sha256 || previous.sizeBytes !== ref.sizeBytes || previous.relativePath !== ref.relativePath
          || previous.scope.length !== ref.scope.length || previous.scope.some((value, index) => value !== ref.scope[index]))) {
          throw new Error(`Wiki handoff artifact is immutable: ${ref.runId}/${ref.contractId}/${ref.attempt}/${ref.kind}`);
        }
        const artifacts = [...manifest.artifacts.filter((entry) => !sameLocation(entry, ref)), previous ?? ref]
          .sort((left, right) => `${left.contractId}:${left.attempt}`.localeCompare(`${right.contractId}:${right.attempt}`));
        await ensureSafeDirectory(okfRoot, path.dirname(manifestFile));
        await writeText(manifestFile, `${JSON.stringify({ version: 1, artifacts })}\n`);
        return ref;
      });
    },

    async read(ref) {
      validateRef(ref);
      const blob = path.join(blobsRoot, `${ref.sha256}.md`);
      await assertNoSymlinks(okfRoot, blob);
      const bytes = await readFile(blob);
      assertSize(bytes);
      decode(bytes);
      if (bytes.byteLength !== ref.sizeBytes || digest(bytes) !== ref.sha256) {
        throw new Error(`Wiki handoff artifact integrity check failed: ${ref.relativePath}`);
      }
      return decode(bytes);
    },
  };
}

async function readManifest(root: string, file: string): Promise<WikiArtifactManifest> {
  try {
    await assertNoSymlinks(root, file);
    const value = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1
      || !Array.isArray((value as { artifacts?: unknown }).artifacts)) throw new Error("Invalid Wiki artifact manifest");
    const artifacts = (value as WikiArtifactManifest).artifacts.map(validateRef);
    return { version: 1, artifacts };
  } catch (error) {
    if (isMissing(error)) return { version: 1, artifacts: [] };
    throw error;
  }
}

function validateRef(value: WikiArtifactRef): WikiArtifactRef {
  validateLocation(value);
    if (value.version !== 1 || value.mediaType !== "text/markdown" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 0 || value.sizeBytes > MAX_WIKI_RESEARCH_ARTIFACT_BYTES
    || value.relativePath !== `.okf-wiki/blobs/${value.sha256}.md`) {
    throw new Error("Invalid Wiki handoff artifact reference");
  }
  return value;
}

function validateLocation(value: Pick<WikiArtifactWrite, "runId" | "contractId" | "attempt" | "kind" | "scope">): void {
  if (!SAFE_COMPONENT.test(value.runId)) throw new Error("Invalid Wiki handoff run ID");
  if (!SAFE_COMPONENT.test(value.contractId)) throw new Error("Invalid Wiki handoff contract ID");
  if (!Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 1_000_000) throw new Error("Invalid Wiki handoff attempt");
  if (!isWikiArtifactKind(value.kind)) throw new Error("Invalid Wiki handoff artifact kind");
  if (!Array.isArray(value.scope) || value.scope.some((scope) => typeof scope !== "string" || !SAFE_COMPONENT.test(scope))) {
    throw new Error("Invalid Wiki handoff artifact scope");
  }
}

function sameLocation(left: WikiArtifactRef, right: WikiArtifactRef): boolean {
  return left.contractId === right.contractId && left.attempt === right.attempt && left.kind === right.kind;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_WIKI_RESEARCH_ARTIFACT_BYTES) {
    throw new Error(`Wiki handoff artifact exceeds the ${MAX_WIKI_RESEARCH_ARTIFACT_BYTES}-byte limit (${bytes.byteLength})`);
  }
}

function isWikiArtifactKind(value: unknown): value is WikiArtifactKind {
  return value === "research-handoff" || value === "write-handoff" || value === "review-handoff";
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Wiki handoff artifact must be valid UTF-8");
  }
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  await assertNoSymlinks(root, directory);
  await ensureDirectory(directory);
  await assertNoSymlinks(root, directory);
}

async function assertNoSymlinks(root: string, location: string): Promise<void> {
  const relative = path.relative(root, location);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Wiki handoff artifact path escapes its store directory");
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Wiki handoff artifact path contains a symbolic link: ${current}`);
    } catch (error) {
      if (!isMissing(error)) throw error;
      return;
    }
  }
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
