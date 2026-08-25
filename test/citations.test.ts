import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOkfSources,
  formatWriterCitationContract,
  parseSourceResource,
  resolveSourceCitation,
  wikiLinkTargets,
} from "../extensions/wiki/lib/citations.js";
import { markdownStructure } from "../extensions/wiki/lib/markdown-structure.js";

test("parseSourceResource reads a Workspace-relative path with an optional line range", () => {
  assert.deepEqual(parseSourceResource("api/src/main.ts#L4-L8"), {
    path: "api/src/main.ts",
    startLine: 4,
    endLine: 8,
  });
  assert.deepEqual(parseSourceResource("main.ts#L1"), {
    path: "main.ts",
    startLine: 1,
    endLine: 1,
  });
  assert.deepEqual(parseSourceResource("api/src/main.ts"), {
    path: "api/src/main.ts",
  });
  assert.equal(parseSourceResource("./api/main.ts#L1"), undefined);
  assert.equal(parseSourceResource("../api/main.ts#L1"), undefined);
  assert.equal(parseSourceResource("api\\main.ts#L1"), undefined);
  assert.equal(parseSourceResource("api/main.ts#section"), undefined);
});

test("parseSourceResource reads a Catalog table locator", () => {
  assert.deepEqual(parseSourceResource("catalog:billing/orders"), {
    path: "catalog:billing/orders",
    catalog: "billing",
    catalogTable: "orders",
  });
  assert.equal(parseSourceResource("catalog:orders"), undefined);
  assert.equal(parseSourceResource("catalog:billing/public.orders"), undefined);
  assert.equal(parseSourceResource("catalog:billing/orders#L1"), undefined);
  assert.equal(parseSourceResource("catalog:"), undefined);
});

test("resolveSourceCitation never maps Catalog locators to a pinned Source", () => {
  assert.equal(
    resolveSourceCitation({ path: "catalog:billing/orders" }, [{ scopeId: "self", logicalPath: "." }]),
    undefined,
  );
});

test("resolveSourceCitation maps Workspace paths to pinned Sources", () => {
  assert.deepEqual(
    resolveSourceCitation(
      { path: "api/src/main.ts" },
      [{ scopeId: "api", logicalPath: "api" }],
    ),
    { scopeId: "api", sourcePath: "src/main.ts" },
  );
  assert.deepEqual(
    resolveSourceCitation(
      { path: "src/main.ts" },
      [{ scopeId: "self", logicalPath: "." }],
    ),
    { scopeId: "self", sourcePath: "src/main.ts" },
  );
  assert.equal(
    resolveSourceCitation(
      { path: "src/main.ts" },
      [{ scopeId: "api", logicalPath: "api" }],
    ),
    undefined,
  );
});

test("writer citation contract covers optional line ranges and the current evidence roots", () => {
  const implicit = formatWriterCitationContract([{ scopeId: "self", logicalPath: "." }], []);
  assert.match(implicit, /line suffix is optional/i);
  assert.match(implicit, /`path`, `path#L12`, and `path#L12-L18`/);
  assert.match(implicit, /without a `self\/` prefix/);
  assert.match(implicit, /\[\^source-id\]: Human-readable source/);
  assert.doesNotMatch(implicit, /catalog:<catalog>/);

  const explicit = formatWriterCitationContract([
    { scopeId: "api", logicalPath: "services/api" },
    { scopeId: "web", logicalPath: "web" },
  ], ["billing", "audit"]);
  assert.match(explicit, /`services\/api\/`/);
  assert.match(explicit, /`web\/`/);
  assert.match(explicit, /`billing`/);
  assert.match(explicit, /`audit`/);
  assert.match(explicit, /`catalog:billing\/orders`/);
});

test("extractOkfSources requires sources ids and matching footnotes", () => {
  const ok = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts#L1", title: "main" }],
  }, "Claim. [^main]\n\n[^main]: main\n");
  assert.deepEqual(ok.invalid, []);
  assert.equal(ok.citations[0]?.id, "main");

  const missing = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts#L1" }],
  }, "Claim. [^other]\n");
  assert.ok(missing.invalid.some((issue) => issue.includes("[^other]")));

  const missingDefinition = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts" }],
  }, "Claim. [^main]\n");
  assert.ok(missingDefinition.invalid.some((issue) => issue.includes("missing definition")));

  const legacy = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts#L1" }],
  }, "See [main](api/src/main.ts#L1).\n\n[^main]: main\n");
  assert.ok(legacy.invalid.some((issue) => issue.includes("body link")));

  const wikiLink = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts" }],
  }, "See [architecture](architecture.md). [^main]\n\n[^main]: main\n");
  assert.deepEqual(wikiLink.invalid, []);
});

test("wikiLinkTargets resolves bundle-root and relative links", () => {
  assert.deepEqual(
    wikiLinkTargets("api/billing/invoice/concept.md", "See [flows](/api/billing/invoice/flows.md) and [domain](../domain.md)."),
    ["api/billing/invoice/flows.md", "api/billing/domain.md"],
  );
  assert.deepEqual(wikiLinkTargets("api/overview.md", "See [architecture](architecture.md)."), ["api/architecture.md"]);
});

test("Markdown evidence scans ignore fenced examples", () => {
  const body = [
    "```md",
    "[^ghost]",
    "[missing](missing.md)",
    "{{placeholder}}",
    "```",
  ].join("\n");
  assert.deepEqual(extractOkfSources({}, body), { citations: [], invalid: [] });
  assert.deepEqual(wikiLinkTargets("overview.md", body), []);
  assert.deepEqual(markdownStructure(body).placeholders, []);
});
