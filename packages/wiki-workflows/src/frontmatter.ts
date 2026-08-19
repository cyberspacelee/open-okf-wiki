import YAML from "yaml";

export interface ParsedPage {
  frontmatter: Record<string, unknown>;
  body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitYamlFence(text: string): { yaml?: string; body: string; hasFence: boolean; terminated: boolean } {
  const hasFence = text.startsWith("---\n") || text.startsWith("---\r\n");
  if (!hasFence) return { body: text, hasFence: false, terminated: true };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { body: text, hasFence: true, terminated: false };
  return { yaml: match[1], body: text.slice(match[0].length), hasFence: true, terminated: true };
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
