import YAML from "yaml";
import { isRecord, splitYamlFence } from "./util.js";

export interface ParsedPage {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface OkfSource {
  id: string;
  resource: string;
}

export function parsePage(text: string): ParsedPage {
  const split = splitYamlFence(text);
  if (!split.hasFence) throw new Error("missing YAML frontmatter");
  if (!split.terminated || split.yaml === undefined) throw new Error("unterminated YAML frontmatter");
  const frontmatter = YAML.parse(split.yaml);
  if (!isRecord(frontmatter)) throw new Error("frontmatter must be a mapping");
  return { frontmatter, body: split.body };
}

export function stringifyPage(page: ParsedPage): string {
  return `---\n${YAML.stringify(page.frontmatter).trimEnd()}\n---\n${page.body}`;
}

export function okfSources(value: unknown): OkfSource[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const sources: OkfSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const source = entry as Record<string, unknown>;
    if (typeof source.id !== "string" || !source.id.trim()) return undefined;
    if (typeof source.resource !== "string" || !source.resource.trim()) return undefined;
    sources.push({ id: source.id.trim(), resource: source.resource.trim() });
  }
  return sources;
}
