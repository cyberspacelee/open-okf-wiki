import { readFile } from "node:fs/promises";
import path from "node:path";
import { candidateRevision } from "./revisions.js";
import { ensureDirectory, exists, removePath, renamePath, withExclusiveLock, writeText } from "./files.js";

const PUBLICATION_VERSION = 1;

type PublicationPhase = "previous_moved" | "candidate_installed";

interface PublicationOptions {
  fault?: (phase: PublicationPhase) => void | Promise<void>;
}

interface PublicationJournal {
  version: 1;
  candidateDigest: string;
}

/** Install one full Candidate while retaining the previous Wiki only as a transaction backup. */
export async function installWikiPublication(
  workspaceRoot: string,
  candidateRoot: string,
  options: PublicationOptions = {},
): Promise<void> {
  const layout = publicationLayout(workspaceRoot);
  if (path.resolve(candidateRoot) !== layout.candidate) {
    throw new Error(`Publication Candidate must be the current Run Candidate: ${candidateRoot}`);
  }
  await withExclusiveLock(layout.lock, async () => {
    await recoverLocked(layout);
    if (!await exists(layout.candidate)) throw new Error("Current Run Candidate is missing");
    const candidateDigest = (await candidateRevision(layout.candidate)).digest;
    await ensureDirectory(layout.transaction);
    await writeText(layout.journal, `${JSON.stringify({ version: PUBLICATION_VERSION, candidateDigest }, null, 2)}\n`);
    if (await exists(layout.wiki)) await renamePath(layout.wiki, layout.previous);
    await options.fault?.("previous_moved");
    await renamePath(layout.candidate, layout.wiki);
    await options.fault?.("candidate_installed");
    if ((await candidateRevision(layout.wiki)).digest !== candidateDigest) {
      throw new Error("Installed Wiki does not match the frozen Candidate");
    }
    await cleanupTransaction(layout);
  });
}

/** Finish or roll back the only in-flight publication transaction after a crash. */
export async function recoverWikiPublication(workspaceRoot: string): Promise<void> {
  const layout = publicationLayout(workspaceRoot);
  await withExclusiveLock(layout.lock, async () => await recoverLocked(layout));
}

async function recoverLocked(layout: ReturnType<typeof publicationLayout>): Promise<void> {
  const journal = await readJournal(layout.journal);
  if (!journal) {
    if (!await exists(layout.wiki) && await exists(layout.previous)) {
      await renamePath(layout.previous, layout.wiki);
    } else if (await exists(layout.previous)) {
      await removePath(layout.previous, { recursive: true, force: true });
    }
    if (await exists(layout.transaction)) await removePath(layout.transaction, { recursive: true, force: true });
    return;
  }

  if (await revisionMatches(layout.wiki, journal.candidateDigest)) {
    await cleanupTransaction(layout);
    return;
  }

  const wikiExists = await exists(layout.wiki);
  const previousExists = await exists(layout.previous);
  if (!wikiExists && await revisionMatches(layout.candidate, journal.candidateDigest)) {
    await renamePath(layout.candidate, layout.wiki);
    await cleanupTransaction(layout);
    return;
  }

  if (previousExists) {
    if (wikiExists) await removePath(layout.wiki, { recursive: true, force: true });
    await renamePath(layout.previous, layout.wiki);
  }
  await removePath(layout.journal, { force: true });
  if (await exists(layout.transaction)) await removePath(layout.transaction, { recursive: true, force: true });
}

async function cleanupTransaction(layout: ReturnType<typeof publicationLayout>): Promise<void> {
  if (await exists(layout.previous)) await removePath(layout.previous, { recursive: true, force: true });
  if (await exists(layout.journal)) await removePath(layout.journal, { force: true });
  if (await exists(layout.transaction)) await removePath(layout.transaction, { recursive: true, force: true });
}

async function revisionMatches(location: string, expected: string): Promise<boolean> {
  try { return (await candidateRevision(location)).digest === expected; }
  catch { return false; }
}

async function readJournal(location: string): Promise<PublicationJournal | undefined> {
  try {
    const value = JSON.parse(await readFile(location, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (record.version !== PUBLICATION_VERSION || typeof record.candidateDigest !== "string") return undefined;
    return { version: PUBLICATION_VERSION, candidateDigest: record.candidateDigest };
  } catch {
    return undefined;
  }
}

function publicationLayout(workspaceRoot: string) {
  const root = path.resolve(workspaceRoot);
  const transaction = path.join(root, ".okf-wiki", "publication");
  return {
    candidate: path.join(root, ".okf-wiki", "run", "candidate"),
    wiki: path.join(root, "wiki"),
    transaction,
    previous: path.join(transaction, "previous"),
    journal: path.join(transaction, "journal.json"),
    lock: path.join(root, ".okf-wiki", "publication.lock"),
  };
}
