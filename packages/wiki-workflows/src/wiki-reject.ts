export const WIKI_DEFECT_LIST_LIMIT = 20;

/** One-line agent observation built from every collected accept-tool defect. */
export class WikiRejectedError extends Error {
  readonly name = "WikiRejectedError";
  readonly defects: readonly string[];

  constructor(defects: readonly string[]) {
    const unique = [...new Set(defects.map(oneLine).filter(Boolean))];
    super(unique.join("; "));
    this.defects = unique;
  }
}

/** One-line reject for wiki_* tools — Pi's observer shows only the first error line. */
export function wikiToolRejected(tool: string, reason: string): Error {
  return new Error(`${oneLine(tool)} rejected: ${oneLine(reason)}`);
}

export function listed(values: readonly string[], limit = WIKI_DEFECT_LIST_LIMIT): string {
  const unique = [...new Set(values.filter(Boolean))];
  if (unique.length <= limit) return unique.join(", ");
  return `${unique.slice(0, limit).join(", ")} +${unique.length - limit} more`;
}

export function allowedList(values: readonly string[]): string {
  return values.length ? listed(values) : "(none)";
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
