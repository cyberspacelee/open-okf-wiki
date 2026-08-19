/**
 * Shared pure helpers for wiki-workflows.
 *
 * Pure module: no @earendil-works/* imports.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deterministic JSON-like stringify with sorted object keys (for fingerprints). */
export function stableStringify(value: unknown): string {
  const serialized = stableJsonValue(value);
  if (serialized === undefined) throw new TypeError("Cannot stringify a non-JSON top-level value");
  return serialized;
}

function stableJsonValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonValue(item) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const serialized = stableJsonValue(record[key]);
    if (serialized !== undefined) fields.push(`${JSON.stringify(key)}:${serialized}`);
  }
  return `{${fields.join(",")}}`;
}

/** Compare string collections by unique membership, independent of order. */
export function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export interface YamlFenceSplit {
  yaml?: string;
  body: string;
  hasFence: boolean;
  terminated: boolean;
}

/** Split optional terminated YAML. Accepts CRLF. */
export function splitYamlFence(text: string): YamlFenceSplit {
  const hasFence = text.startsWith("---\n") || text.startsWith("---\r\n");
  if (!hasFence) return { body: text, hasFence: false, terminated: true };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text, hasFence: true, terminated: false };
  return { yaml: match[1], body: text.slice(match[0].length), hasFence: true, terminated: true };
}
