import assert from "node:assert/strict";
import test from "node:test";
import { extractOkfSources, parseSourceResource, wikiLinkTargets } from "../extensions/wiki/lib/citations.js";

test("parseSourceResource reads scope/path#Lx", () => {
  assert.deepEqual(parseSourceResource("api/src/main.ts#L4-L8"), {
    scope: "api",
    path: "src/main.ts",
    startLine: 4,
    endLine: 8,
  });
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

  const legacy = extractOkfSources({
    sources: [{ id: "main", resource: "api/src/main.ts#L1" }],
  }, "See [main](api/src/main.ts#L1).\n\n[^main]: main\n");
  assert.ok(legacy.invalid.some((issue) => issue.includes("body link")));
});

test("wikiLinkTargets resolves bundle-root and relative links", () => {
  assert.deepEqual(
    wikiLinkTargets("api/billing/invoice/concept.md", "See [flows](/api/billing/invoice/flows.md) and [domain](../domain.md)."),
    ["api/billing/invoice/flows.md", "api/billing/domain.md"],
  );
});
