import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePage } from "./frontmatter.js";

export interface WikiAgentDefinition {
  name: string;
  description: string;
  tools?: string[];
  prompt: string;
  filePath: string;
}

export function packagedAgentsRoot(): string {
  return fileURLToPath(new URL("../../../agents", import.meta.url));
}

export async function loadWikiAgents(directory = packagedAgentsRoot()): Promise<WikiAgentDefinition[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(names.map(async (name) => {
    const filePath = path.join(directory, name);
    return parseAgentMarkdown(await readFile(filePath, "utf8"), filePath);
  }));
}

export function parseAgentMarkdown(text: string, filePath: string): WikiAgentDefinition {
  let page;
  try {
    page = parsePage(text);
  } catch (error) {
    throw new Error(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const fields = page.frontmatter;
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!name || !description) throw new Error(`${filePath}: name and description are required`);
  if (fields.tools !== undefined && typeof fields.tools !== "string") {
    throw new Error(`${filePath}: tools must be a comma-separated string`);
  }
  const tools = fields.tools?.split(/[\s,]+/).map((tool) => tool.trim()).filter(Boolean);
  return {
    name,
    description,
    ...(tools?.length ? { tools } : {}),
    prompt: page.body.trim(),
    filePath,
  };
}
