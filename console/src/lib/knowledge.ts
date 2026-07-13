export type BundleKind = "staged" | "published"
const MAX_MERMAID_EDGES = 32
const MAX_MERMAID_NODES = MAX_MERMAID_EDGES * 2
const MAX_MERMAID_LABEL_CHARS = 80
export type BundleIdentity = {
  kind: BundleKind | "previous"
  run_id: string
  source_set_digest: string
  state: string
}

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "claim"; claim_id: string }
  | { type: "break" }
  | { type: "math"; source: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "s"; children: InlineNode[] }
  | {
      type: "link"
      href: string
      external: boolean
      page: string | null
      fragment: string | null
      children: InlineNode[]
    }
  | { type: "image"; alt: string; source: string }

export type MarkdownBlock =
  | { type: "heading"; level: number; id: string; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "claim"; claim_id: string }
  | {
      type: "list"
      ordered: boolean
      start: number
      items: Array<{ checked: boolean | null; children: MarkdownBlock[] }>
    }
  | { type: "blockquote"; children: MarkdownBlock[] }
  | {
      type: "table"
      headers: InlineNode[][]
      rows: InlineNode[][][]
    }
  | {
      type: "code"
      language: string
      source: string
      segments: Array<{ kind: string; text: string }>
    }
  | {
      type: "mermaid"
      direction: string
      source: string
      error: string | null
      nodes: Array<{ id: string; label: string }>
      edges: Array<{ from: string; to: string; label: string | null }>
    }
  | { type: "math"; display: true; source: string }
  | { type: "separator" }

export type KnowledgeSnapshot = {
  ok: true
  bundles: BundleIdentity[]
  selected: BundleIdentity
  default_page: string | null
  diff_options: DiffOption[]
  pages: Array<{ path: string; title: string; backlinks: string[] }>
}

export type DiffOption = {
  base: "published" | "previous"
  base_run_id: string
  target: BundleKind
  target_run_id: string
}

export type KnowledgePage = BundleIdentity & {
  ok: true
  path: string
  title: string
  source: string
  metadata: Record<string, unknown>
  blocks: MarkdownBlock[]
  outline: Array<{ level: number; text: string; id: string }>
  backlinks: string[]
  diagnostics: string[]
}

export type KnowledgeDiff = {
  ok: true
  path: string
  page_change: "added" | "changed" | "removed" | "unchanged"
  base: BundleIdentity
  target: BundleIdentity
  lines: Array<{
    kind: "added" | "changed" | "removed" | "unchanged"
    left: string | null
    left_number: number | null
    right: string | null
    right_number: number | null
  }>
}

export type KnowledgeClaim = {
  ok: true
  id: string
  subject: string
  predicate: string
  statement: string
  modality: string
  conditions: string[]
  epistemic_status: string
  conflicts_with: string[]
  supersedes: string[]
  evidence: Array<{
    id: string
    source_id: string
    revision: string
    path: string
    start_line: number
    end_line: number
    digest: string
    evidence_kind: string
    authority: string
    excerpt: string | null
    error: string | null
  }>
}

export type KnowledgeError = { message: string }

export async function fetchKnowledgeSnapshot(
  token: string,
  bundle: BundleKind,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/knowledge?bundle=${bundle}`,
    token,
    signal
  )
  if (!isSnapshot(payload)) throw invalid("Knowledge navigation")
  return payload
}

export async function fetchKnowledgePage(
  token: string,
  bundle: BundleKind,
  runId: string,
  path: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/knowledge/page?bundle=${bundle}&run_id=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`,
    token,
    signal
  )
  if (!isPage(payload)) throw invalid("Knowledge page")
  return payload
}

export async function searchKnowledge(
  token: string,
  bundle: BundleKind,
  runId: string,
  query: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/knowledge/search?bundle=${bundle}&run_id=${encodeURIComponent(runId)}&query=${encodeURIComponent(query)}`,
    token,
    signal
  )
  if (
    !isRecord(payload) ||
    payload.ok !== true ||
    !Array.isArray(payload.results) ||
    !payload.results.every(
      (item) => isRecord(item) && strings(item, ["path", "title", "excerpt"])
    )
  )
    throw invalid("Knowledge search")
  return payload.results as Array<{
    path: string
    title: string
    excerpt: string
  }>
}

export async function fetchKnowledgeDiff(
  token: string,
  path: string,
  option: DiffOption,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/knowledge/diff?base=${option.base}&base_run_id=${encodeURIComponent(option.base_run_id)}&target=${option.target}&target_run_id=${encodeURIComponent(option.target_run_id)}&path=${encodeURIComponent(path)}`,
    token,
    signal
  )
  if (!isDiff(payload)) throw invalid("Knowledge diff")
  return payload
}

export async function fetchKnowledgeClaim(
  token: string,
  bundle: BundleKind,
  runId: string,
  claimId: string,
  signal?: AbortSignal
) {
  const payload = await request(
    `/api/v1/knowledge/claims/${encodeURIComponent(claimId)}?bundle=${bundle}&run_id=${encodeURIComponent(runId)}`,
    token,
    signal
  )
  if (!isClaim(payload)) throw invalid("Accepted Claim")
  return payload
}

async function request(path: string, token: string, signal?: AbortSignal) {
  let response: Response
  try {
    response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    })
  } catch {
    throw {
      message: "The local Knowledge service did not respond.",
    } satisfies KnowledgeError
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      isRecord(payload) &&
      Array.isArray(payload.errors) &&
      typeof payload.errors[0] === "string"
        ? payload.errors[0]
        : "The Knowledge Bundle could not be read."
    throw { message } satisfies KnowledgeError
  }
  return payload
}

function isSnapshot(value: unknown): value is KnowledgeSnapshot {
  return (
    isRecord(value) &&
    value.ok === true &&
    isIdentity(value.selected) &&
    (value.default_page === null || typeof value.default_page === "string") &&
    Array.isArray(value.bundles) &&
    value.bundles.every(isIdentity) &&
    Array.isArray(value.diff_options) &&
    value.diff_options.every(isDiffOption) &&
    Array.isArray(value.pages) &&
    value.pages.every(
      (page) =>
        isRecord(page) &&
        strings(page, ["path", "title"]) &&
        stringArray(page.backlinks)
    )
  )
}

function isPage(value: unknown): value is KnowledgePage {
  return (
    isRecord(value) &&
    value.ok === true &&
    strings(value, ["kind", "run_id", "source_set_digest", "state"]) &&
    strings(value, ["path", "title", "source"]) &&
    isJsonObject(value.metadata) &&
    Array.isArray(value.blocks) &&
    value.blocks.every(isBlock) &&
    Array.isArray(value.outline) &&
    value.outline.every(
      (item) =>
        isRecord(item) &&
        typeof item.level === "number" &&
        strings(item, ["text", "id"])
    ) &&
    stringArray(value.backlinks) &&
    stringArray(value.diagnostics)
  )
}

function isBlock(value: unknown): value is MarkdownBlock {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "heading")
    return (
      typeof value.level === "number" &&
      typeof value.id === "string" &&
      inlineArray(value.children)
    )
  if (value.type === "paragraph") return inlineArray(value.children)
  if (value.type === "claim") return typeof value.claim_id === "string"
  if (value.type === "blockquote")
    return Array.isArray(value.children) && value.children.every(isBlock)
  if (value.type === "list")
    return (
      typeof value.ordered === "boolean" &&
      typeof value.start === "number" &&
      Array.isArray(value.items) &&
      value.items.every(
        (item) =>
          isRecord(item) &&
          (item.checked === null || typeof item.checked === "boolean") &&
          Array.isArray(item.children) &&
          item.children.every(isBlock)
      )
    )
  if (value.type === "table")
    return (
      Array.isArray(value.headers) &&
      value.headers.every(inlineArray) &&
      Array.isArray(value.rows) &&
      value.rows.every((row) => Array.isArray(row) && row.every(inlineArray))
    )
  if (value.type === "code")
    return (
      strings(value, ["language", "source"]) &&
      Array.isArray(value.segments) &&
      value.segments.every(
        (segment) => isRecord(segment) && strings(segment, ["kind", "text"])
      )
    )
  if (value.type === "mermaid")
    return (
      strings(value, ["direction", "source"]) &&
      (value.error === null || typeof value.error === "string") &&
      Array.isArray(value.nodes) &&
      value.nodes.length <= MAX_MERMAID_NODES &&
      value.nodes.every(
        (node) =>
          isRecord(node) &&
          typeof node.id === "string" &&
          typeof node.label === "string" &&
          node.id.length <= MAX_MERMAID_LABEL_CHARS &&
          node.label.length <= MAX_MERMAID_LABEL_CHARS
      ) &&
      Array.isArray(value.edges) &&
      value.edges.length <= MAX_MERMAID_EDGES &&
      value.edges.every(
        (edge) =>
          isRecord(edge) &&
          typeof edge.from === "string" &&
          typeof edge.to === "string" &&
          edge.from.length <= MAX_MERMAID_LABEL_CHARS &&
          edge.to.length <= MAX_MERMAID_LABEL_CHARS &&
          nullableString(edge.label) &&
          (edge.label === null || edge.label.length <= MAX_MERMAID_LABEL_CHARS)
      )
    )
  if (value.type === "math")
    return value.display === true && typeof value.source === "string"
  return value.type === "separator"
}

function inlineArray(value: unknown): value is InlineNode[] {
  return Array.isArray(value) && value.every(isInline)
}

function isInline(value: unknown): value is InlineNode {
  if (!isRecord(value) || typeof value.type !== "string") return false
  if (value.type === "text" || value.type === "code")
    return typeof value.text === "string"
  if (value.type === "claim") return typeof value.claim_id === "string"
  if (value.type === "break") return true
  if (value.type === "math") return typeof value.source === "string"
  if (["strong", "em", "s"].includes(value.type))
    return inlineArray(value.children)
  if (value.type === "link")
    return (
      typeof value.href === "string" &&
      typeof value.external === "boolean" &&
      (value.page === null || typeof value.page === "string") &&
      (value.fragment === null || typeof value.fragment === "string") &&
      inlineArray(value.children)
    )
  return (
    value.type === "image" &&
    typeof value.alt === "string" &&
    typeof value.source === "string"
  )
}

function isDiff(value: unknown): value is KnowledgeDiff {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.path === "string" &&
    ["added", "changed", "removed", "unchanged"].includes(
      String(value.page_change)
    ) &&
    isIdentity(value.base) &&
    isIdentity(value.target) &&
    Array.isArray(value.lines) &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        ["added", "changed", "removed", "unchanged"].includes(
          String(line.kind)
        ) &&
        nullableString(line.left) &&
        nullableString(line.right) &&
        nullableNumber(line.left_number) &&
        nullableNumber(line.right_number)
    )
  )
}

function isClaim(value: unknown): value is KnowledgeClaim {
  return (
    isRecord(value) &&
    value.ok === true &&
    strings(value, [
      "id",
      "subject",
      "predicate",
      "statement",
      "modality",
      "epistemic_status",
    ]) &&
    stringArray(value.conditions) &&
    stringArray(value.conflicts_with) &&
    stringArray(value.supersedes) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        strings(item, [
          "id",
          "source_id",
          "revision",
          "path",
          "digest",
          "evidence_kind",
          "authority",
        ]) &&
        typeof item.start_line === "number" &&
        typeof item.end_line === "number" &&
        nullableString(item.excerpt) &&
        nullableString(item.error)
    )
  )
}

function isIdentity(value: unknown): value is BundleIdentity {
  return (
    isRecord(value) &&
    strings(value, ["kind", "run_id", "source_set_digest", "state"])
  )
}

function isDiffOption(value: unknown): value is DiffOption {
  return (
    isRecord(value) &&
    (value.base === "published" || value.base === "previous") &&
    (value.target === "staged" || value.target === "published") &&
    typeof value.base_run_id === "string" &&
    typeof value.target_run_id === "string"
  )
}

function strings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => typeof value[key] === "string")
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function nullableString(value: unknown) {
  return value === null || typeof value === "string"
}

function nullableNumber(value: unknown) {
  return value === null || typeof value === "number"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function invalid(surface: string): KnowledgeError {
  return {
    message: `The local service returned an invalid ${surface} response.`,
  }
}
