import path from "node:path";

export type WikiWriteMode = "subtree" | "directory";

export interface WikiWriteTarget {
  path: string;
  mode: WikiWriteMode;
}

export function writeTargetAllows(target: WikiWriteTarget | undefined, relative: string): boolean {
  if (!target) return true;
  const candidate = relative.replaceAll("\\", "/");
  const root = target.path === "wiki-root" ? "" : target.path;
  if (target.mode === "directory") {
    const directory = path.posix.dirname(candidate);
    return directory === (root || ".");
  }
  return Boolean(root) && candidate.startsWith(`${root}/`);
}

export function writeTargetsOverlap(left: WikiWriteTarget, right: WikiWriteTarget): boolean {
  const leftPath = left.path === "wiki-root" ? "" : left.path;
  const rightPath = right.path === "wiki-root" ? "" : right.path;
  if (leftPath === rightPath) return left.mode === right.mode;
  if (!leftPath || !rightPath) return false;
  if (rightPath.startsWith(`${leftPath}/`)) return left.mode === "subtree";
  if (leftPath.startsWith(`${rightPath}/`)) return right.mode === "subtree";
  return false;
}
