/**
 * Atomic JSON write: temp file + rename.
 * Callers that need per-path serialization wrap this.
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
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
