import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writePartitionAllows } from "./path-policy.js";
import type { WikiTemplatePack } from "./templates.js";

export interface TreeRevision {
  digest: string;
  files: string[];
}

export async function candidateRevision(root: string): Promise<TreeRevision> {
  const files = await regularFiles(root);
  return await treeRevision(root, files);
}

export async function candidatePartitionRevision(root: string, partition: string): Promise<TreeRevision> {
  const files = (await regularFiles(root)).filter((relative) => writePartitionAllows(partition, relative));
  return await treeRevision(root, files);
}

async function treeRevision(root: string, files: readonly string[]): Promise<TreeRevision> {
  const hash = createHash("sha256");
  for (const relative of files) {
    const body = await readFile(path.join(root, ...relative.split("/")));
    hash.update(relative);
    hash.update("\0");
    hash.update(String(body.byteLength));
    hash.update("\0");
    hash.update(body);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files: [...files] };
}

export function templatePackRevision(pack: WikiTemplatePack): string {
  const hash = createHash("sha256");
  for (const template of pack.templates.slice().sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(JSON.stringify(template));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function fileRevision(location: string): Promise<string> {
  return createHash("sha256").update(await readFile(location)).digest("hex");
}

async function regularFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, relative);
        continue;
      }
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Candidate contains a non-regular file: ${relative}`);
      }
      found.push(relative);
    }
  };
  await visit(root, "");
  return found;
}
