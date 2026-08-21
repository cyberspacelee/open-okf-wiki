import assert from "node:assert/strict";
import test from "node:test";
import {
  createCatalog,
  formatTableDefinition,
  matchTableNames,
  parseDatabaseConfig,
  redactDatabaseUrl,
  tableMatches,
} from "../extensions/wiki/lib/catalog.js";

test("table patterns fuzzy-match without requiring every name", () => {
  const names = ["users", "user_account", "orders", "order_items", "payments", "pg_stat_statements"];
  assert.deepEqual(matchTableNames(names, ["user", "order%"]), ["order_items", "orders", "user_account", "users"]);
  assert.equal(tableMatches("user_account", "user"), true);
  assert.equal(tableMatches("payments", "pay*"), true);
  assert.equal(tableMatches("orders", "user"), false);
  assert.deepEqual(matchTableNames(names, []), [...names].sort());
});

test("parseDatabaseConfig expands env URLs and rejects unknown fields", () => {
  const previous = process.env.WIKI_TEST_PG;
  process.env.WIKI_TEST_PG = "postgresql://wiki:secret@db.example:5432/app";
  try {
    const parsed = parseDatabaseConfig({
      url: "${WIKI_TEST_PG}",
      schema: "billing",
      tables: ["user*", "payment"],
    });
    assert.equal(parsed.url, "postgresql://wiki:secret@db.example:5432/app");
    assert.equal(parsed.schema, "billing");
    assert.deepEqual(parsed.tables, ["user*", "payment"]);
    assert.equal(redactDatabaseUrl(parsed.url), "postgresql://wiki:***@db.example:5432/app");
  } finally {
    if (previous === undefined) delete process.env.WIKI_TEST_PG;
    else process.env.WIKI_TEST_PG = previous;
  }
  assert.throws(() => parseDatabaseConfig({ url: "postgresql://x", extra: true }), /unknown field/);
  assert.throws(() => parseDatabaseConfig({ url: "mysql://x" }), /postgresql:\/\//);
});

test("catalog lists and describes only matching tables", async () => {
  const rows = {
    refs: [
      { schema: "public", name: "users", kind: "r", comment: "accounts" },
      { schema: "public", name: "orders", kind: "r", comment: null },
      { schema: "public", name: "audit_log", kind: "r", comment: null },
    ],
    columns: [
      {
        schema: "public", table_name: "users", name: "id", type: "bigint", nullable: false,
        default_value: null, comment: "pk", position: 1,
      },
      {
        schema: "public", table_name: "users", name: "email", type: "text", nullable: false,
        default_value: null, comment: null, position: 2,
      },
    ],
    constraints: [
      {
        schema: "public", table_name: "users", name: "users_pkey", type: "p",
        columns: ["id"], referenced: null,
      },
    ],
    indexes: [
      {
        schema: "public", table_name: "users", name: "users_email_key", unique: true,
        columns: ["email"],
      },
    ],
  };
  const catalog = createCatalog(
    { url: "postgresql://wiki:***@localhost/app", schema: "public", tables: ["user*"] },
    async (sql) => {
      if (sql.includes("FROM pg_constraint")) return rows.constraints;
      if (sql.includes("FROM pg_index")) return rows.indexes;
      if (sql.includes("FROM pg_attribute")) return rows.columns;
      if (sql.includes("FROM pg_class")) return rows.refs;
      throw new Error(`unexpected sql: ${sql}`);
    },
  );
  const listed = await catalog.listTables("user");
  assert.match(listed, /users/);
  assert.doesNotMatch(listed, /public/);
  assert.doesNotMatch(listed, /orders|audit_log/);
  const described = await catalog.describeTables(["user"]);
  assert.deepEqual(described.tables, ["users"]);
  assert.match(described.text, /# users/);
  assert.doesNotMatch(described.text, /public/);
  assert.match(described.text, /email text not null/);
  assert.match(described.text, /primary_key users_pkey/);
  assert.match((await catalog.describeTables(["orders"])).text, /No Catalog tables matched/);
});

test("formatTableDefinition stays compact", () => {
  const text = formatTableDefinition({
    ref: { name: "users", kind: "table", comment: "accounts" },
    columns: [{ name: "id", type: "bigint", nullable: false }],
    constraints: [{ type: "primary_key", name: "users_pkey", columns: ["id"] }],
    indexes: [],
  });
  assert.match(text, /accounts/);
  assert.match(text, /id bigint not null/);
});
