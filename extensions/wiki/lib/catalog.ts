import path from "node:path";

export interface WikiCatalogConfig {
  url: string;
  schema: string;
  tables: string[];
}

export interface WikiTableRef {
  name: string;
  kind: "table" | "view" | "materialized_view";
  comment?: string;
}

export interface WikiTableColumn {
  name: string;
  type: string;
  nullable: boolean;
  default?: string;
  comment?: string;
}

export interface WikiTableConstraint {
  type: "primary_key" | "foreign_key" | "unique" | "check";
  name: string;
  columns: string[];
  referenced?: string;
}

export interface WikiTableIndex {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface WikiTableDefinition {
  ref: WikiTableRef;
  columns: WikiTableColumn[];
  constraints: WikiTableConstraint[];
  indexes: WikiTableIndex[];
}

export interface WikiCatalogDescription {
  text: string;
  tables: string[];
}

export type CatalogQuery = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface WikiCatalog {
  config: WikiCatalogConfig;
  listTables(query?: string): Promise<string>;
  describeTables(names: readonly string[]): Promise<WikiCatalogDescription>;
}

export type WikiCatalogRegistry = ReadonlyMap<string, WikiCatalog>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_DESCRIBE_TABLES = 20;
const MAX_LIST_TABLES = 200;

export function parseCatalogConfig(
  value: unknown,
  field = "database",
  env: Readonly<Record<string, string | undefined>> = process.env,
): WikiCatalogConfig {
  if (!isRecord(value)) throw new Error(`workspace.yaml ${field} must be an object`);
  const unknown = Object.keys(value).filter((key) => !["url", "schema", "tables"].includes(key));
  if (unknown.length > 0) throw new Error(`workspace.yaml ${field} has unknown field: ${unknown[0]}`);
  if (typeof value.url !== "string" || !value.url.trim()) {
    throw new Error(`workspace.yaml ${field}.url must be a non-empty openGauss URL`);
  }
  const url = expandEnv(value.url.trim(), `${field}.url`, env);
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(`workspace.yaml ${field}.url must be an openGauss postgres:// or postgresql:// connection string`);
  }
  const schema = value.schema === undefined ? "public" : parseIdentifier(value.schema, `${field}.schema`);
  const tables = parsePatterns(value.tables, `${field}.tables`);
  return { url, schema, tables };
}

export function redactDatabaseUrl(url: string): string {
  return url.replace(/:([^:@/?#]+)@/, ":***@");
}

export function matchTableNames(names: readonly string[], patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [...names].sort((left, right) => left.localeCompare(right));
  const matched = new Set<string>();
  for (const pattern of patterns) {
    for (const name of names) {
      if (tableMatches(name, pattern)) matched.add(name);
    }
  }
  return [...matched].sort((left, right) => left.localeCompare(right));
}

export function tableMatches(name: string, pattern: string): boolean {
  const n = name.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p) return false;
  if (n === p) return true;
  if (hasWildcards(p) && path.matchesGlob(n, toGlob(p))) return true;
  if (n.includes(p)) return true;
  const compact = (value: string) => value.replace(/[_-]/g, "");
  if (compact(n).includes(compact(p))) return true;
  return n.split(/[_-]/).some((token) => token === p || (token.startsWith(p) && p.length >= 2));
}

export function createCatalog(config: WikiCatalogConfig, query: CatalogQuery): WikiCatalog {
  return {
    config,
    async listTables(filter) {
      const refs = await loadTableRefs(query, config.schema);
      const scoped = matchTableNames(refs.map((ref) => ref.name), config.tables);
      const filtered = filter?.trim()
        ? matchTableNames(scoped, [filter.trim()])
        : scoped;
      const selected = refs.filter((ref) => filtered.includes(ref.name));
      return formatTableList(config, selected, filter);
    },
    async describeTables(names) {
      const requested = names.map((name) => name.trim()).filter(Boolean);
      if (requested.length === 0) return { text: "Provide at least one table name.", tables: [] };
      const refs = await loadTableRefs(query, config.schema);
      const scoped = matchTableNames(refs.map((ref) => ref.name), config.tables);
      const matched = matchTableNames(scoped, requested);
      if (matched.length === 0) {
        return { text: `No Catalog tables matched ${requested.join(", ")}.`, tables: [] };
      }
      if (matched.length > MAX_DESCRIBE_TABLES) {
        return {
          text: `Matched ${matched.length} tables; describe at most ${MAX_DESCRIBE_TABLES} at a time. Refine the names.`,
          tables: [],
        };
      }
      const definitions = await loadTableDefinitions(
        query,
        config.schema,
        refs.filter((ref) => matched.includes(ref.name)),
      );
      return {
        text: definitions.map(formatTableDefinition).join("\n\n"),
        tables: definitions.map(({ ref }) => ref.name),
      };
    },
  };
}

function formatTableList(config: WikiCatalogConfig, tables: readonly WikiTableRef[], filter?: string): string {
  const header = [
    "Catalog",
    config.tables.length ? `patterns: ${config.tables.join(", ")}` : "patterns: (all configured tables)",
    ...(filter?.trim() ? [`query: ${filter.trim()}`] : []),
  ].join(" · ");
  if (tables.length === 0) return `${header}\nNo matching tables.`;
  if (tables.length > MAX_LIST_TABLES) {
    return `${header}\n${tables.length} matching tables; narrow the query instead of listing them all.`;
  }
  const lines = [header, `${tables.length} table(s):`];
  for (const table of tables) {
    const comment = table.comment ? ` — ${table.comment}` : "";
    lines.push(`- ${table.name} (${table.kind})${comment}`);
  }
  return lines.join("\n");
}

export function formatTableDefinition(table: WikiTableDefinition): string {
  const comment = table.ref.comment ? `\n${table.ref.comment}` : "";
  const columns = table.columns.length
    ? table.columns.map((column) => {
      const nullability = column.nullable ? "nullable" : "not null";
      const fallback = column.default ? ` default ${column.default}` : "";
      const note = column.comment ? ` — ${column.comment}` : "";
      return `- ${column.name} ${column.type} ${nullability}${fallback}${note}`;
    })
    : ["- (no columns)"];
  const constraints = table.constraints.map((constraint) => {
    const cols = constraint.columns.join(", ");
    const referenced = constraint.referenced ? ` → ${constraint.referenced}` : "";
    return `- ${constraint.type} ${constraint.name} (${cols})${referenced}`;
  });
  const indexes = table.indexes.map((index) => {
    const unique = index.unique ? " UNIQUE" : "";
    return `- ${index.name}${unique} (${index.columns.join(", ")})`;
  });
  return [
    `# ${table.ref.name} (${table.ref.kind})${comment}`,
    "",
    "## columns",
    ...columns,
    ...(constraints.length ? ["", "## constraints", ...constraints] : []),
    ...(indexes.length ? ["", "## indexes", ...indexes] : []),
  ].join("\n");
}

async function loadTableRefs(query: CatalogQuery, schema: string): Promise<WikiTableRef[]> {
  const rows = await query(
    `SELECT c.relname AS name, c.relkind AS kind, obj_description(c.oid) AS comment
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = ANY($2)
     ORDER BY c.relname`,
    [schema, ["r", "v", "m"]],
  );
  return rows.map((row) => ({
    name: String(row.name),
    kind: kindFromRelkind(String(row.kind ?? "r")),
    ...(row.comment ? { comment: String(row.comment) } : {}),
  }));
}

async function loadTableDefinitions(
  query: CatalogQuery,
  schema: string,
  refs: readonly WikiTableRef[],
): Promise<WikiTableDefinition[]> {
  const names = refs.map((ref) => ref.name);
  const columns = await query(
    `SELECT c.relname AS table_name, a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
            pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
            col_description(a.attrelid, a.attnum) AS comment, a.attnum AS position
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = $1 AND c.relname = ANY($2) AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`,
    [schema, [...names]],
  );
  const constraints = await query(
    `SELECT rel.relname AS table_name, con.conname AS name, con.contype AS type,
            ARRAY(SELECT att.attname FROM generate_subscripts(con.conkey, 1) AS cols(ord)
                  JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[cols.ord]
                  ORDER BY cols.ord)::text[] AS columns,
            CASE WHEN con.confrelid <> 0
              THEN (SELECT ref.relname || '(' ||
                    array_to_string(ARRAY(SELECT att.attname
                      FROM generate_subscripts(con.confkey, 1) AS cols(ord)
                      JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = con.confkey[cols.ord]
                      ORDER BY cols.ord), ', ') || ')'
                    FROM pg_class ref
                    WHERE ref.oid = con.confrelid)
              ELSE NULL END AS referenced
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = $1 AND rel.relname = ANY($2)
     ORDER BY rel.relname, con.conname`,
    [schema, [...names]],
  );
  const indexes = await query(
    `SELECT rel.relname AS table_name, idx.relname AS name, i.indisunique AS unique,
            ARRAY(SELECT att.attname FROM generate_subscripts(i.indkey::smallint[], 1) AS cols(ord)
                  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = (i.indkey::smallint[])[cols.ord]
                  ORDER BY cols.ord)::text[] AS columns
     FROM pg_index i
     JOIN pg_class rel ON rel.oid = i.indrelid
     JOIN pg_class idx ON idx.oid = i.indexrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = $1 AND rel.relname = ANY($2)
     ORDER BY rel.relname, idx.relname`,
    [schema, [...names]],
  );
  return refs.map((ref) => ({
    ref,
    columns: columns.filter((row) => row.table_name === ref.name).map((row) => ({
      name: String(row.name),
      type: String(row.type),
      nullable: Boolean(row.nullable),
      ...(row.default_value ? { default: String(row.default_value) } : {}),
      ...(row.comment ? { comment: String(row.comment) } : {}),
    })),
    constraints: constraints.filter((row) => row.table_name === ref.name).map((row) => ({
      type: constraintType(String(row.type)),
      name: String(row.name),
      columns: asStringArray(row.columns),
      ...(row.referenced ? { referenced: String(row.referenced) } : {}),
    })),
    indexes: indexes.filter((row) => row.table_name === ref.name).map((row) => ({
      name: String(row.name),
      columns: asStringArray(row.columns),
      unique: Boolean(row.unique),
    })),
  }));
}

function parseIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value.trim())) {
    throw new Error(`workspace.yaml ${field} must be an openGauss identifier`);
  }
  return value.trim();
}

function parsePatterns(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`workspace.yaml ${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((entry) => String(entry).trim()))];
}

function expandEnv(value: string, field: string, env: Readonly<Record<string, string | undefined>>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, braced, bare) => {
    const key = String(braced ?? bare);
    const found = env[key];
    if (!found) throw new Error(`workspace.yaml ${field} references unset environment variable ${key}`);
    return found;
  });
}

function hasWildcards(pattern: string): boolean {
  return /[*?%]/.test(pattern);
}

function toGlob(pattern: string): string {
  const glob = pattern.replaceAll("%", "*");
  return pattern.includes("%") ? glob.replaceAll("_", "?") : glob;
}

function kindFromRelkind(kind: string): WikiTableRef["kind"] {
  if (kind === "v") return "view";
  if (kind === "m") return "materialized_view";
  return "table";
}

function constraintType(type: string): WikiTableConstraint["type"] {
  if (type === "p") return "primary_key";
  if (type === "f") return "foreign_key";
  if (type === "u") return "unique";
  return "check";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
