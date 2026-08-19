import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sameStringSet, stableStringify } from "./util.js";

type WikiSpec = { pages: string[] };

/** published.json, publish.json, publication-finalization.json, and review basis. */
export const WIKI_PUBLICATION_FORMAT = 1 as const;

const sealBrand: unique symbol = Symbol("WikiPublicationSeal");
const sealPayloads = new WeakMap<WikiPublicationSeal, VerifiedWikiPublicationSealPayload>();

export interface VerifiedWikiPublicationSealPayload {
  readonly runId: string;
  readonly executionToken: string;
  readonly candidateRoot: string;
  readonly finalTreeDigest: string;
  readonly pages: readonly string[];
  readonly spec: WikiSpec;
  readonly sourceFingerprint: string;
  readonly summary: string;
}

/** Opaque, run-bound proof that Lead governance and deterministic finalization completed. */
export type WikiPublicationSeal = {
  readonly [sealBrand]: true;
};

/** Package-internal issuer. The Lead run is the only caller allowed to mint a seal. */
export async function issueWikiPublicationSeal(input: {
  runId: string;
  executionToken: string;
  candidateRoot: string;
  pages: readonly string[];
  spec: WikiSpec;
  sourceFingerprint: string;
  summary: string;
}): Promise<WikiPublicationSeal> {
  const candidateRoot = path.resolve(input.candidateRoot);
  if (typeof input.executionToken !== "string" || !input.executionToken.trim()) throw new Error("Invalid Wiki publication seal execution token");
  if (typeof input.sourceFingerprint !== "string" || !input.sourceFingerprint) throw new Error("Wiki publication source fingerprint must be a non-empty string");
  if (typeof input.summary !== "string") throw new Error("Wiki publication summary must be a string");
  const spec = input.spec;
  const pages = [...input.pages];
  if (!sameStringSet(pages, spec.pages)) throw new Error("Publication seal pages do not match the WikiSpec");
  const payload: VerifiedWikiPublicationSealPayload = Object.freeze({
    runId: input.runId,
    executionToken: input.executionToken,
    candidateRoot,
    finalTreeDigest: await digestWikiTree(candidateRoot),
    pages: Object.freeze(pages),
    spec: deepFreeze(structuredClone(spec)),
    sourceFingerprint: input.sourceFingerprint,
    summary: input.summary,
  });
  const seal = Object.freeze({ [sealBrand]: true }) as WikiPublicationSeal;
  sealPayloads.set(seal, payload);
  return seal;
}

/** Re-prove the candidate immediately before publication and return trusted metadata. */
export async function verifyWikiPublicationSeal(seal: WikiPublicationSeal): Promise<VerifiedWikiPublicationSealPayload> {
  if (!seal || typeof seal !== "object" || seal[sealBrand] !== true) throw new Error("Invalid Wiki publication seal");
  const stored = sealPayloads.get(seal);
  if (!stored) throw new Error("Invalid Wiki publication seal");
  const candidateRoot = path.resolve(stored.candidateRoot);
  if (candidateRoot !== stored.candidateRoot) throw new Error("Wiki publication seal candidate root is not canonical");
  const spec = stored.spec;
  if (!stored.executionToken || typeof stored.executionToken !== "string") throw new Error("Invalid Wiki publication seal execution token");
  if (!sameStringSet(stored.pages, spec.pages)) throw new Error("Wiki publication seal pages no longer match its WikiSpec");
  const actual = await digestWikiTree(candidateRoot);
  if (actual !== stored.finalTreeDigest) throw new Error("Candidate Wiki changed after it was sealed for publication");
  return Object.freeze({
    runId: stored.runId,
    executionToken: stored.executionToken,
    candidateRoot,
    finalTreeDigest: stored.finalTreeDigest,
    pages: Object.freeze([...stored.pages]),
    spec: deepFreeze(structuredClone(spec)),
    sourceFingerprint: stored.sourceFingerprint,
    summary: stored.summary,
  });
}

export async function digestWikiTree(root: string): Promise<string> {
  const entries: Array<{ path: string; type: "directory" } | { path: string; type: "file"; digest: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(`Candidate Wiki contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        await visit(absolute);
      }
      else if (entry.isFile()) entries.push({
        path: relative,
        type: "file",
        digest: createHash("sha256").update(await readFile(absolute)).digest("hex"),
      });
      else throw new Error(`Candidate Wiki contains a non-regular entry: ${absolute}`);
    }
  };
  await visit(path.resolve(root));
  return createHash("sha256").update(stableStringify(entries)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
