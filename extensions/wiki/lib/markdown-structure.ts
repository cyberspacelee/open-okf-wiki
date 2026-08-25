export interface MarkdownHeading {
  level: number;
  title: string;
  line: number;
}

export interface MarkdownSection {
  title: string;
  lines: string[];
}

export interface MarkdownStructure {
  headings: MarkdownHeading[];
  summary: string;
  sections: MarkdownSection[];
  placeholders: string[];
}

const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
const PLACEHOLDER = /\{\{[^{}\n]+\}\}/g;

export function markdownStructure(body: string): MarkdownStructure {
  const lines = body.split(/\r?\n/);
  const visibleBody = markdownOutsideCodeFences(body);
  const visibleLines = visibleBody.split(/\r?\n/);
  const headings: MarkdownHeading[] = [];
  for (let index = 0; index < visibleLines.length; index += 1) {
    const line = visibleLines[index] ?? "";
    const heading = ATX_HEADING.exec(line);
    if (!heading?.[1] || !heading[2]) continue;
    headings.push({
      level: heading[1].length,
      title: heading[2].replace(/[ \t]+#+[ \t]*$/, "").trim(),
      line: index,
    });
  }

  const h1 = headings.find((heading) => heading.level === 1);
  const firstH2 = headings.find((heading) => heading.level === 2);
  const summaryLines = h1
    ? lines.slice(h1.line + 1, firstH2?.line ?? lines.length)
    : [];
  const sections = headings
    .filter((heading) => heading.level === 2)
    .map((heading, index, h2s) => ({
      title: heading.title,
      lines: lines.slice(heading.line + 1, h2s[index + 1]?.line ?? lines.length),
    }));
  return {
    headings,
    summary: paragraph(summaryLines),
    sections,
    placeholders: [...new Set(visibleBody.match(PLACEHOLDER) ?? [])],
  };
}

export function markdownOutsideCodeFences(body: string): string {
  const lines = body.split(/\r?\n/);
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return lines.map((line) => {
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`);
      if (close.test(line)) fence = undefined;
      return "";
    }
    const opening = FENCE_OPEN.exec(line)?.[1];
    if (!opening) return line;
    fence = { marker: opening[0] as "`" | "~", length: opening.length };
    return "";
  }).join("\n");
}

export function sectionHasContent(section: MarkdownSection): boolean {
  return section.lines.some((line) => {
    const trimmed = line.trim();
    return Boolean(trimmed)
      && !ATX_HEADING.test(line)
      && !FENCE_OPEN.test(line)
      && !FOOTNOTE_DEFINITION.test(trimmed);
  });
}

function paragraph(lines: readonly string[]): string {
  const content: string[] = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) break;
      continue;
    }
    started = true;
    content.push(trimmed);
  }
  return content.join(" ");
}
