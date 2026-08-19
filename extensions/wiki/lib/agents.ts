import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WikiAgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  prompt: string;
  filePath: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function packagedAgentsRoot(): string {
  return fileURLToPath(new URL("../../../agents", import.meta.url));
}

export async function loadWikiAgents(directory = packagedAgentsRoot()): Promise<WikiAgentDefinition[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  const agents: WikiAgentDefinition[] = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    const parsed = parseAgentMarkdown(await readFile(filePath, "utf8"), filePath);
    if (parsed) agents.push(parsed);
  }
  return agents;
}

export function parseAgentMarkdown(text: string, filePath: string): WikiAgentDefinition | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  const fields = parseSimpleYaml(match[1] ?? "");
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!name || !description) return undefined;
  const tools = typeof fields.tools === "string"
    ? fields.tools.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean)
    : undefined;
  return {
    name,
    description,
    ...(tools?.length ? { tools } : {}),
    prompt: text.slice(match[0].length).trim(),
    filePath,
  };
}

function parseSimpleYaml(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const cut = line.indexOf(":");
    if (cut < 1) continue;
    const key = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  return fields;
}
