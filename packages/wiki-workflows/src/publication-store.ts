import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ensureDirectory, removePath, renamePath, withExclusiveLock, writeText } from "./files.js";
import { stableStringify } from "./util.js";
import { ensureWikiWorkspaceInternalIgnore } from "./workspace.js";
import { parseWikiSpec, type WikiSpec } from "./lead.js";
import { digestWikiTree, verifyWikiPublicationSeal, type WikiPublicationSeal } from "./wiki-publication-seal.js";
import { UnsupportedWikiRunVersionError, WIKI_FORMAT } from "./run-ledger.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type WikiPublishStep = "prepared" | "backed_up" | "installed" | "committed" | "rolled_back";

interface WikiPublishJournal {
  version: typeof WIKI_FORMAT;
  runId: string;
  state: WikiPublishStep;
  hadPublishedWiki: boolean;
  preparedAt: string;
  updatedAt: string;
  publishedMetadata: WikiPublishedMetadata;
  metadataDigest: string;
}

interface WikiPublishRecovery {
  runId: string;
  outcome: "none" | "committed" | "rolled_back";
}

export interface WikiPublishedPublication {
  state: "published";
  runId: string;
  pages: string[];
  sourceFingerprint: string;
  finalTreeDigest: string;
}

export type WikiPublicationReconciliation =
  | { state: "not_published"; recovery: "none" | "rolled_back" }
  | WikiPublishedPublication;

export interface WikiPublicationResult {
  sourceFingerprint: string;
  summary: string;
}

export interface WikiPublishedMetadata extends WikiPublicationResult {
  version: typeof WIKI_FORMAT;
  runId: string;
  publishedAt: string;
  pages: string[];
  finalTreeDigest: string;
  wikiSpec: WikiSpec;
}

export interface WikiPublicationStore {
  /** Create this Run's completely empty candidate before publication begins. */
  prepareCandidate(runId: string): Promise<string>;
  /** Resume an existing candidate, or prepare it when this run has not written yet. */
  ensureCandidate(runId: string): Promise<string>;
  /** Atomically replace published `wiki/` using a recoverable rename journal. */
  publish(runId: string, seal: WikiPublicationSeal): Promise<WikiPublishedPublication>;
  /** Recover publication and project the terminal fact needed by Run reconciliation. */
  reconcile(runId: string): Promise<WikiPublicationReconciliation>;
  /** Archive a committed journal after the Run terminal transition is durable. */
  acknowledge(runId: string): Promise<void>;
  recoverPending(): Promise<void>;
  /** Load versioned provenance for the currently published Wiki. */
  readPublishedMetadata(): Promise<WikiPublishedMetadata | undefined>;
}

export interface WikiPublicationStoreOptions {
  workspace: string;
  now?: () => string;
  /** Fault-injection seam invoked after each durable transition. */
  afterStep?: (step: Exclude<WikiPublishStep, "rolled_back">) => void | Promise<void>;
}

/**
 * Candidate and publication lifecycle rooted on the workspace filesystem.
 * Writers never touch the published Wiki; publication uses same-filesystem
 * renames and a journal that can distinguish install completion from rollback.
 */
export function createWikiPublicationStore(options: WikiPublicationStoreOptions): WikiPublicationStore {
  const workspace = path.resolve(options.workspace);
  const okfRoot = path.join(workspace, ".okf-wiki");
  const runsRoot = path.join(okfRoot, "runs");
  const publishedWiki = path.join(workspace, "wiki");
  const publishedMetadataFile = path.join(okfRoot, "published.json");
  const publicationLeaseFile = path.join(okfRoot, "publication.lock");
  const publicationArchiveRoot = path.join(okfRoot, "publications");
  const now = options.now ?? (() => new Date().toISOString());

  const locked = async <T>(operation: () => Promise<T>): Promise<T> => {
    await ensureInternalRoot(okfRoot);
    return await withExclusiveLock(publicationLeaseFile, operation);
  };

  const pathsFor = (runId: string) => {
    assertRunId(runId);
    const runRoot = path.join(runsRoot, runId);
    return {
      runRoot,
      candidate: path.join(runRoot, "candidate", "wiki"),
      backup: path.join(runRoot, "publish-backup"),
      journal: path.join(runRoot, "publish.json"),
    };
  };

  const readJournal = async (runId: string): Promise<WikiPublishJournal | undefined> => {
    const { journal } = pathsFor(runId);
    try {
      await assertRegularFileOrMissing(journal, "Wiki publish journal");
      const value = JSON.parse(await readFile(journal, "utf8")) as unknown;
      return parsePublishJournal(value, runId);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const readPublishedMetadata = async (): Promise<WikiPublishedMetadata | undefined> => {
    try {
      await assertRegularFileOrMissing(publishedMetadataFile, "published Wiki metadata");
      const value = JSON.parse(await readFile(publishedMetadataFile, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid published Wiki metadata");
      const metadata = value as Record<string, unknown>;
      if (metadata.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError(publishedMetadataFile, metadata.version, WIKI_FORMAT);
      return parsePublishedMetadata(metadata);
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  };

  const recoverOperation = async (runId: string): Promise<WikiPublishRecovery> => {
    const journal = await readJournal(runId);
    if (!journal) return { runId, outcome: "none" };
    const paths = pathsFor(runId);
    await assertDirectoryOrMissing(paths.candidate, "candidate Wiki");
    await assertDirectoryOrMissing(paths.backup, "Wiki publish backup");
    await assertDirectoryOrMissing(publishedWiki, "published Wiki");

    if (journal.state === "committed") {
      await assertPublishedTree(publishedWiki, journal.publishedMetadata.finalTreeDigest);
      await removePath(paths.backup, { recursive: true, force: true });
      return { runId, outcome: "committed" };
    }
    if (journal.state === "rolled_back") return { runId, outcome: "rolled_back" };

    const candidateExists = await exists(paths.candidate);
    const backupExists = await exists(paths.backup);
    const publishedExists = await exists(publishedWiki);

    // Candidate has already moved into place. Finish the commit; restoring the
    // backup here would discard a fully installed and previously validated Wiki.
    if (!candidateExists && publishedExists && (journal.state === "backed_up" || journal.state === "installed")) {
      await assertPublishedTree(publishedWiki, journal.publishedMetadata.finalTreeDigest);
      const committed = await finishCommit(journal, paths.backup, publishedMetadataFile, now());
      await writeJournal(paths.journal, committed);
      return { runId, outcome: "committed" };
    }

    // The old Wiki was moved aside but the candidate was not installed.
    if (backupExists && !publishedExists) {
      await renamePath(paths.backup, publishedWiki);
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    // No old Wiki existed and installation never started. Leave the candidate
    // intact for a normal publish retry and record a completed rollback.
    if (candidateExists && !backupExists && !publishedExists && !journal.hadPublishedWiki) {
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    // A prepared journal with an untouched target is also a clean rollback.
    if (candidateExists && publishedExists && !backupExists) {
      await writeJournal(paths.journal, { ...journal, state: "rolled_back", updatedAt: now() });
      return { runId, outcome: "rolled_back" };
    }

    throw new Error(`Cannot safely recover Wiki publication for run ${runId}; publication paths are inconsistent`);
  };

  const recoverAfterPublishFailure = async (runId: string, publishError: unknown): Promise<never> => {
    try {
      await recoverOperation(runId);
    } catch (recoveryError) {
      throw new AggregateError(
        [publishError, recoveryError],
        `Wiki publication failed and automatic recovery also failed for run ${runId}`,
      );
    }
    throw publishError;
  };

  const prepareCandidate = async (runId: string): Promise<string> => {
    await ensureWikiWorkspaceInternalIgnore(workspace);
    await ensureInternalRoot(okfRoot);
    const paths = pathsFor(runId);
    await assertDirectoryOrMissing(paths.runRoot, "Wiki run directory");
    const priorJournal = await readJournal(runId);
    if (priorJournal) throw new Error(`Run ${runId} already has a publish journal; reconcile it instead of preparing another candidate`);
    await removePath(path.dirname(paths.candidate), { recursive: true, force: true });
    await createCandidateDirectory(paths.runRoot, paths.candidate);
    return paths.candidate;
  };

  return {
    async prepareCandidate(runId): Promise<string> {
      return await locked(async () => await prepareCandidate(runId));
    },

    async ensureCandidate(runId): Promise<string> {
      return await locked(async () => {
        const candidate = pathsFor(runId).candidate;
        if (await exists(candidate)) {
          await assertRegularDirectory(candidate, "candidate Wiki");
          return candidate;
        }
        return await prepareCandidate(runId);
      });
    },

    async publish(runId, seal): Promise<WikiPublishedPublication> {
      return await locked(async () => {
        await ensureWikiWorkspaceInternalIgnore(workspace);
        await ensureInternalRoot(okfRoot);
        const paths = pathsFor(runId);
        const prior = await readJournal(runId);
        if (prior && prior.state !== "rolled_back") throw new Error(`Run ${runId} has an unfinished or completed publish journal; recover it before publishing again`);
        await assertRegularDirectory(paths.candidate, "candidate Wiki");
        await assertDirectoryOrMissing(publishedWiki, "published Wiki");
        await removePath(paths.backup, { recursive: true, force: true });

        const verified = await verifyWikiPublicationSeal(seal);
        assertSealMatchesPublication(verified, runId, paths.candidate);
        const timestamp = now();
        const normalizedMetadata: WikiPublishedMetadata = {
          version: WIKI_FORMAT,
          runId,
          publishedAt: timestamp,
          ...parsePublicationResult({ sourceFingerprint: verified.sourceFingerprint, summary: verified.summary }),
          pages: verified.spec.pages,
          finalTreeDigest: verified.finalTreeDigest,
          wikiSpec: verified.spec,
        };
        let journal: WikiPublishJournal = {
          version: WIKI_FORMAT,
          runId,
          state: "prepared",
          hadPublishedWiki: await exists(publishedWiki),
          preparedAt: timestamp,
          updatedAt: timestamp,
          publishedMetadata: normalizedMetadata,
          metadataDigest: publicationMetadataDigest(normalizedMetadata),
        };
        await writeJournal(paths.journal, journal);
        await options.afterStep?.("prepared");

        try {
          if (journal.hadPublishedWiki) await renamePath(publishedWiki, paths.backup);
          journal = { ...journal, state: "backed_up", updatedAt: now() };
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("backed_up");

        try {
          const reverified = await verifyWikiPublicationSeal(seal);
          assertSealMatchesPublication(reverified, runId, paths.candidate);
          await renamePath(paths.candidate, publishedWiki);
          journal = { ...journal, state: "installed", updatedAt: now() };
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("installed");

        try {
          journal = await finishCommit(journal, paths.backup, publishedMetadataFile, now());
          await writeJournal(paths.journal, journal);
        } catch (error) {
          return await recoverAfterPublishFailure(runId, error);
        }
        await options.afterStep?.("committed");
        return projectCommittedPublication(journal);
      });
    },

    async reconcile(runId): Promise<WikiPublicationReconciliation> {
      return await locked(async () => {
        const recovery = await recoverOperation(runId);
        if (recovery.outcome !== "committed") return { state: "not_published", recovery: recovery.outcome };
        const journal = await readJournal(runId);
        if (!journal || journal.state !== "committed") throw new Error(`Committed Wiki publication for run ${runId} has no committed journal`);
        const provenance = await readPublishedMetadata();
        if (!provenance || provenance.version !== WIKI_FORMAT
          || publicationMetadataDigest(provenance) !== journal.metadataDigest
          || stableStringify(provenance) !== stableStringify(journal.publishedMetadata)) {
          throw new Error(`Committed Wiki publication for run ${runId} has inconsistent published provenance`);
        }
        return projectCommittedPublication(journal);
      });
    },

    async acknowledge(runId): Promise<void> {
      await locked(async () => {
        const paths = pathsFor(runId);
        const archive = path.join(publicationArchiveRoot, `${runId}.json`);
        const journal = await readJournal(runId);
        if (!journal) {
          await assertArchivedJournalOrMissing(archive, runId);
          return;
        }
        if (journal.state !== "committed") throw new Error(`Wiki publication ${runId} cannot be acknowledged before commit`);
        await ensureDirectory(publicationArchiveRoot);
        const archived = await readArchivedJournal(archive, runId);
        if (archived) {
          if (stableStringify(archived) !== stableStringify(journal)) throw new Error(`Wiki publication audit already differs for run ${runId}`);
          await removePath(paths.journal, { force: true });
          return;
        }
        await renamePath(paths.journal, archive);
      });
    },

    async recoverPending(): Promise<void> {
      await locked(async () => {
        let entries: string[];
        try {
          entries = (await readdir(runsRoot, { withFileTypes: true }))
            .filter((entry) => entry.isDirectory() && SAFE_RUN_ID.test(entry.name))
            .map((entry) => entry.name);
        } catch (error) {
          if (isMissing(error)) return;
          throw error;
        }
        for (const runId of entries.sort()) if (await readJournal(runId)) await recoverOperation(runId);
      });
    },

    async readPublishedMetadata(): Promise<WikiPublishedMetadata | undefined> {
      return await locked(readPublishedMetadata);
    },
  };
}

async function finishCommit(
  journal: WikiPublishJournal,
  backup: string,
  publishedMetadataFile: string,
  updatedAt: string,
): Promise<WikiPublishJournal> {
  await writeText(publishedMetadataFile, `${JSON.stringify(journal.publishedMetadata)}\n`);
  await removePath(backup, { recursive: true, force: true });
  return { ...journal, state: "committed", updatedAt };
}

async function createCandidateDirectory(runRoot: string, candidate: string): Promise<void> {
  const runsRoot = path.dirname(runRoot);
  await ensureDirectory(runsRoot);
  await ensureDirectory(runRoot);
  await ensureDirectory(path.dirname(candidate));
  await ensureDirectory(candidate);
}

async function assertPublishedTree(location: string, expectedDigest: string): Promise<void> {
  await assertRegularDirectory(location, "published Wiki");
  if (await digestWikiTree(location) !== expectedDigest) throw new Error("Published Wiki does not match its committed publication digest");
}

async function assertRegularDirectory(location: string, label: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(location);
  } catch (error) {
    if (isMissing(error)) throw new Error(`Missing ${label}: ${location}`);
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a regular directory: ${location}`);
}

async function assertDirectoryOrMissing(location: string, label: string): Promise<void> {
  try {
    await assertRegularDirectory(location, label);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof Error && error.message.startsWith(`Missing ${label}:`))) throw error;
  }
}

async function assertRegularFileOrMissing(location: string, label: string): Promise<void> {
  try {
    const entry = await lstat(location);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file: ${location}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function ensureInternalRoot(okfRoot: string): Promise<void> {
  try {
    const entry = await lstat(okfRoot);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Wiki internal root must be a regular directory: ${okfRoot}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
    await ensureDirectory(okfRoot);
    await assertRegularDirectory(okfRoot, "Wiki internal root");
  }
}

async function exists(location: string): Promise<boolean> {
  try {
    await lstat(location);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function writeJournal(location: string, journal: WikiPublishJournal): Promise<void> {
  await ensureDirectory(path.dirname(location));
  await writeText(location, `${JSON.stringify(journal)}\n`);
}

function parsePublicationMetadata(value: unknown): Pick<WikiPublishedMetadata, "sourceFingerprint" | "summary" | "pages" | "finalTreeDigest" | "wikiSpec"> {
  const metadata = recordValue(value, "Wiki publication metadata");
  const wikiSpec = parseWikiSpec(metadata.wikiSpec);
  const pages = stringList(metadata.pages, "Wiki publication pages");
  if (!sameOrderedStrings(pages, wikiSpec.pages)) throw new Error("Wiki publication pages do not match its WikiSpec");
  return {
    ...parsePublicationResult(metadata),
    pages,
    finalTreeDigest: digestValue(metadata.finalTreeDigest),
    wikiSpec,
  };
}

function projectCommittedPublication(journal: WikiPublishJournal): WikiPublishedPublication {
  if (journal.state !== "committed") throw new Error(`Wiki publication ${journal.runId} is not committed`);
  return {
    state: "published",
    runId: journal.runId,
    pages: [...journal.publishedMetadata.pages],
    sourceFingerprint: journal.publishedMetadata.sourceFingerprint,
    finalTreeDigest: journal.publishedMetadata.finalTreeDigest,
  };
}

function parsePublicationResult(value: unknown): WikiPublicationResult {
  const result = recordValue(value, "Wiki publication result");
  if (typeof result.sourceFingerprint !== "string" || !result.sourceFingerprint) throw new Error("Wiki publication source fingerprint must be a non-empty string");
  if (typeof result.summary !== "string") throw new Error("Wiki publication summary must be a string");
  return { sourceFingerprint: result.sourceFingerprint, summary: result.summary };
}

function parsePublishedMetadata(metadata: Record<string, unknown>): WikiPublishedMetadata {
  exactKeys(metadata, ["version", "runId", "publishedAt", "sourceFingerprint", "summary", "pages", "finalTreeDigest", "wikiSpec"], "published Wiki metadata");
  if (metadata.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError("published.json", metadata.version, WIKI_FORMAT);
  assertPublishedIdentity(metadata);
  return {
    ...parsePublicationMetadata(metadata),
    version: WIKI_FORMAT,
    runId: metadata.runId as string,
    publishedAt: metadata.publishedAt as string,
  };
}

function assertPublishedIdentity(metadata: Record<string, unknown>): void {
  if (typeof metadata.runId !== "string" || !SAFE_RUN_ID.test(metadata.runId) || typeof metadata.publishedAt !== "string") {
    throw new Error("Invalid published Wiki metadata");
  }
}

function assertSealMatchesPublication(
  verified: Awaited<ReturnType<typeof verifyWikiPublicationSeal>>,
  runId: string,
  candidate: string,
): void {
  if (verified.runId !== runId) throw new Error("Wiki publication seal belongs to a different run");
  if (verified.candidateRoot !== path.resolve(candidate)) throw new Error("Wiki publication seal belongs to a different candidate");
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
  return [...value] as string[];
}

function digestValue(value: unknown, label = "Wiki publication tree digest"): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be SHA-256`);
  return value;
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function publicationMetadataDigest(metadata: WikiPublishedMetadata): string {
  return createHash("sha256").update(stableStringify(metadata)).digest("hex");
}

function parsePublishJournal(value: unknown, runId: string): WikiPublishJournal {
  const journal = recordValue(value, `Wiki publish journal for run ${runId}`);
  exactKeys(journal, ["version", "runId", "state", "hadPublishedWiki", "preparedAt", "updatedAt", "publishedMetadata", "metadataDigest"], "Wiki publish journal");
  if (journal.version !== WIKI_FORMAT) throw new UnsupportedWikiRunVersionError(`runs/${runId}/publish.json`, journal.version, WIKI_FORMAT);
  if (journal.runId !== runId
    || !["prepared", "backed_up", "installed", "committed", "rolled_back"].includes(String(journal.state))
    || typeof journal.hadPublishedWiki !== "boolean"
    || typeof journal.preparedAt !== "string" || typeof journal.updatedAt !== "string") {
    throw new Error(`Invalid Wiki publish journal for run ${runId}`);
  }
  const publishedMetadata = parsePublishedMetadata(recordValue(journal.publishedMetadata, "Wiki publication journal metadata"));
  const metadataDigest = digestValue(journal.metadataDigest, "Wiki publication metadata digest");
  if (publishedMetadata.runId !== runId || metadataDigest !== publicationMetadataDigest(publishedMetadata)) {
    throw new Error(`Invalid Wiki publish journal metadata for run ${runId}`);
  }
  return {
    version: WIKI_FORMAT,
    runId,
    state: journal.state as WikiPublishStep,
    hadPublishedWiki: journal.hadPublishedWiki,
    preparedAt: journal.preparedAt,
    updatedAt: journal.updatedAt,
    publishedMetadata,
    metadataDigest,
  };
}

async function readArchivedJournal(location: string, runId: string): Promise<WikiPublishJournal | undefined> {
  try {
    await assertRegularFileOrMissing(location, "Wiki publication audit");
    return parsePublishJournal(JSON.parse(await readFile(location, "utf8")) as unknown, runId);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertArchivedJournalOrMissing(location: string, runId: string): Promise<void> {
  const archived = await readArchivedJournal(location, runId);
  if (archived && archived.state !== "committed") throw new Error(`Wiki publication audit is not committed for run ${runId}`);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (!sameOrderedStrings(actual, wanted)) throw new Error(`${label} has unknown or missing fields`);
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Invalid Wiki publication run identifier");
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT");
}
