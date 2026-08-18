export interface WikiValidationIssue {
  code: string;
  page?: string;
  message: string;
}

export function issue(issues: WikiValidationIssue[], code: string, message: string, page?: string): void {
  issues.push(page ? { code, page, message } : { code, message });
}

export function formatIssue(value: WikiValidationIssue): string {
  return value.page ? `${value.page}: ${value.message}` : value.message;
}

export interface WikiValidation {
  ok: boolean;
  issues: WikiValidationIssue[];
  pages: string[];
  obsoletePages: string[];
}

export interface WikiFinalization {
  pages: string[];
  obsoletePages: string[];
  removedPages: string[];
  rebuiltIndexes: string[];
}
