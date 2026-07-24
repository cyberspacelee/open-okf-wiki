/**
 * Atomic JSON write: temp file + rename.
 * Callers that need per-path serialization wrap this.
 */

import { link, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Write `value` as pretty-printed JSON to `filePath` via temp + rename.
 * Creates parent directories as needed.
 */
export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, "utf8");
  await rename(tempPath, filePath);
}

/** Atomically create JSON without replacing an existing file. */
export async function atomicCreateJson(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.create.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, body, { encoding: "utf8", flag: "wx" });
  try {
    await link(tempPath, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EEXIST") {
      throw new Error(`file already exists: ${filePath}`, { cause: error });
    }
    throw error;
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
}
