import { truncateUtf8 } from "./delegate-contracts.js";

export const MAX_WIKI_WORK_FILE_BYTES = 256 * 1024;

export function decodeUtf8Fatal(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("Malformed UTF-8 input", { cause: error });
  }
}

export function summarizeWikiMarkdown(markdown: string, _field?: string): string {
  return truncateUtf8(
    firstSubstantiveParagraph(markdown) ?? firstNonstructuralLine(markdown) ?? "Handoff accepted.",
    1024,
  );
}

function firstSubstantiveParagraph(body: string): string | undefined {
  const paragraph: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    if (/^#{1,6}(?:\s|$)|^(?:```|~~~)|^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    const listItem = /^(?:[-+*]|\d+[.)])\s+/.test(line);
    const prose = line
      .replace(/^>\s*/, "")
      .replace(/^(?:[-+*]|\d+[.)])\s+/, "")
      .trim();
    const structuralLabel = /^(?:\*\*[^*]+[:：]?\*\*|__[^_]+[:：]?__|[\p{L}\p{N}][\p{L}\p{N} _/-]{0,60}[:：])(?:\s+.*)?$/u;
    if (!prose || structuralLabel.test(prose) && (listItem || /^\S[^.!?。！？]*[:：]$/.test(prose))) {
      if (paragraph.length) return paragraph.join(" ");
      continue;
    }
    paragraph.push(prose);
  }
  if (paragraph.length) return paragraph.join(" ");
  return undefined;
}

function firstNonstructuralLine(body: string): string | undefined {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}(?:\s|$)|^(?:```|~~~)|^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) continue;
    const prose = line.replace(/^>\s*/, "").replace(/^(?:[-+*]|\d+[.)])\s+/, "").trim();
    if (prose) return prose;
  }
  return undefined;
}
