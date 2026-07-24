import { chmod, lstat, readdir } from "node:fs/promises";
import path from "node:path";

/** Reject symlinks and special files without following either. */
export async function assertOrdinaryTree(directory: string, label: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a filesystem symlink: ${absolutePath}`);
    }
    if (info.isDirectory()) {
      await assertOrdinaryTree(absolutePath, label);
    } else if (!info.isFile()) {
      throw new Error(`${label} contains a non-regular file: ${absolutePath}`);
    }
  }
}

/** Remove write bits from every ordinary file and directory, bottom-up. */
export async function makeTreeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeReadOnly(absolutePath);
    } else {
      await chmod(absolutePath, 0o444);
    }
  }
  await chmod(directory, 0o555);
}

/** Best-effort unlock used only to remove a failed, run-owned materialisation. */
export async function makeTreeWritable(directory: string): Promise<void> {
  await chmod(directory, 0o755).catch(() => undefined);
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const absolutePath = path.join(directory, entry.name);
    const info = await lstat(absolutePath).catch(() => null);
    if (!info || info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      await makeTreeWritable(absolutePath);
    } else if (info.isFile()) {
      await chmod(absolutePath, 0o644).catch(() => undefined);
    }
  }
}
