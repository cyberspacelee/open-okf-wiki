/** CommonMark/GitHub source citations: `[label](scope/path#Lx)` or `#Lx-Ly`. */

const SOURCE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_CITATION = /^(?:\.[/\\])?([^#]+?)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;
const MARKDOWN_LINK = /(?<!!)\[[^\]\n]*\]\([ \t]*(?:<([^>\n]+)>|([^\s)]+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\)/g;
const LINK_DEFINITION = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|([^ \t\n]+))/gm;
const BARE_CITATION = /(?:^|[\s(])((?:repo:|\.\/)?(?:[A-Za-z0-9._-]+\/)+[^#\s)]+#L[^\s)]+)/g;
const REPO_SCHEME = /\brepo:[^\s)]+/g;

export const SOURCE_CITATION_GRAMMAR = "[label](scope/path#Lx)";

export interface SourceCitation {
  scope: string;
  path: string;
  startLine: number;
  endLine: number;
}

export function parseSourceCitation(value: string): SourceCitation | undefined {
  const href = stripHref(value);
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return undefined;
  const match = SOURCE_CITATION.exec(href);
  if (!match) return undefined;
  const resourcePath = match[1].replaceAll("\\", "/");
  if (resourcePath.startsWith("/") || resourcePath.includes("//")) return undefined;
  const slash = resourcePath.indexOf("/");
  if (slash < 1) return undefined;
  const scope = resourcePath.slice(0, slash);
  const remainder = resourcePath.slice(slash + 1);
  if (!SOURCE_SCOPE.test(scope)) return undefined;
  const segments = remainder.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return undefined;
  return {
    scope,
    path: remainder,
    startLine: Number(match[2]),
    endLine: Number(match[3] ?? match[2]),
  };
}

export function sourceCitationsEqual(left: SourceCitation, right: SourceCitation): boolean {
  return left.scope === right.scope
    && left.path === right.path
    && left.startLine === right.startLine
    && left.endLine === right.endLine;
}

export function extractSourceCitations(
  text: string,
  fileLines?: (citation: SourceCitation) => number | "missing" | undefined,
): { citations: SourceCitation[]; invalid: string[] } {
  const citations: SourceCitation[] = [];
  const invalid: string[] = [];
  MARKDOWN_LINK.lastIndex = 0;
  LINK_DEFINITION.lastIndex = 0;
  REPO_SCHEME.lastIndex = 0;
  BARE_CITATION.lastIndex = 0;
  const remainder = text.replace(MARKDOWN_LINK, (full, bracketed: string | undefined, bare: string | undefined) => {
    collectHref(bracketed ?? bare ?? "", citations, invalid, fileLines);
    return " ".repeat(full.length);
  }).replace(LINK_DEFINITION, (full, label: string, bracketed: string | undefined, bare: string | undefined) => {
    if (label.startsWith("^")) return full;
    collectHref(bracketed ?? bare ?? "", citations, invalid, fileLines);
    return " ".repeat(full.length);
  }).replace(REPO_SCHEME, (token) => {
    invalid.push(`${token} need ${SOURCE_CITATION_GRAMMAR}`);
    return " ".repeat(token.length);
  });
  for (const match of remainder.matchAll(BARE_CITATION)) {
    collectHref(match[1], citations, invalid, fileLines);
  }
  return { citations, invalid };
}

function collectHref(
  href: string,
  citations: SourceCitation[],
  invalid: string[],
  fileLines?: (citation: SourceCitation) => number | "missing" | undefined,
): void {
  const target = href.trim().replace(/[.,;:]+$/, "");
  if (!target || skipHref(target)) return;
  const parsed = parseSourceCitation(target);
  if (!parsed) {
    if (looksLikeCitationAttempt(target)) invalid.push(`${target} need ${SOURCE_CITATION_GRAMMAR}`);
    return;
  }
  if (parsed.endLine < parsed.startLine) {
    invalid.push(`${target} end<start`);
    return;
  }
  const file = fileLines?.(parsed);
  if (file === "missing") {
    invalid.push(`${target} missing`);
    return;
  }
  if (typeof file === "number" && parsed.endLine > file) {
    invalid.push(`${target} ${parsed.path.split("/").pop()}:${file} lines`);
    return;
  }
  citations.push(parsed);
}

function stripHref(value: string): string {
  return value.trim().replace(/^<|>$/g, "");
}

function skipHref(href: string): boolean {
  return /^https?:\/\//i.test(href) || href.startsWith("#") || href.startsWith("mailto:");
}

function looksLikeCitationAttempt(href: string): boolean {
  return /#L\d/.test(href);
}
