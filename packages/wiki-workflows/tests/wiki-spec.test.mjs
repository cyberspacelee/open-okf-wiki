import assert from "node:assert/strict";
import test from "node:test";
import {
  isSafeWikiPagePath,
  parseWikiSpec,
  sameWikiCluster,
  wikiSpecClusterId,
  wikiSpecClusterParent,
  wikiSpecClusterPaths,
  wikiSpecClusters,
  wikiSpecClusterSourceId,
  wikiSpecDomainId,
  wikiSpecDomainIds,
  wikiSpecDomainKey,
  wikiSpecPageType,
  wikiSpecPages,
  wikiSpecSourceId,
  wikiSpecSourceIds,
} from "../dist/lead.js";

const validPages = [
  "overview.md",
  "architecture.md",
  "api/source.md",
  "api/billing/domain.md",
  "api/billing/invoice/concept.md",
  "api/billing/invoice/models.md",
  "api/billing/invoice/models/line-item.md",
  "api/billing/invoice/sequences.md",
  "web/source.md",
  "web/billing/domain.md",
];

const validSpec = () => ({ pages: [...validPages] });

test("accepts a source-aware pages spec and derives host-owned page types", () => {
  const spec = parseWikiSpec(validSpec());
  assert.deepEqual(spec, { pages: validPages });
  assert.deepEqual(spec.pages, validPages);
  assert.deepEqual(wikiSpecPages(spec), [
    { path: "overview.md", pageType: "overview" },
    { path: "architecture.md", pageType: "architecture" },
    { path: "api/source.md", pageType: "source" },
    { path: "api/billing/domain.md", pageType: "domain" },
    { path: "api/billing/invoice/concept.md", pageType: "concept" },
    { path: "api/billing/invoice/models.md", pageType: "data" },
    { path: "api/billing/invoice/models/line-item.md", pageType: "data" },
    { path: "api/billing/invoice/sequences.md", pageType: "flow" },
    { path: "web/source.md", pageType: "source" },
    { path: "web/billing/domain.md", pageType: "domain" },
  ]);
  assert.equal(wikiSpecPageType("api/billing/invoice/models.md"), "data");
  assert.equal(wikiSpecPageType("api/billing/invoice/sequences.md"), "flow");
  assert.deepEqual(wikiSpecSourceIds(spec), ["api", "web"]);
  assert.deepEqual(wikiSpecDomainIds(spec), ["api/billing", "web/billing"]);
  assert.deepEqual(wikiSpecDomainIds(spec, "api"), ["billing"]);
});

test("accepts topologyVersion 2 without expanding the control object", () => {
  const spec = parseWikiSpec({ topologyVersion: 2, pages: ["overview.md", "source/source.md", "source/core/domain.md"] });
  assert.deepEqual(spec, { topologyVersion: 2, pages: ["overview.md", "source/source.md", "source/core/domain.md"] });
  assert.throws(() => parseWikiSpec({ topologyVersion: 1, pages: spec.pages }), /topologyVersion/);
});

test("rejects legacy paths, illegal paths, and type-bucket concept names", () => {
  const illegal = [
    "billing/domain.md",
    "api/concepts/invoice.md",
    "api/billing/flows/collection.md",
    "api/billing/states/invoice.md",
    "api/billing/data/invoice.md",
    "api/billing/modules/ledger.md",
    "api/billing/invoice.md",
    "api/billing/invoice/unknown.md",
    "api/billing/invoice/models/line/item.md",
    "wiki/overview.md",
    "MyRepo/Billing/domain.md",
    "MyRepo/Core/domain.md",
  ];
  for (const path of illegal) {
    assert.throws(() => parseWikiSpec({ pages: ["overview.md", "api/source.md", "api/billing/domain.md", path] }));
  }
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "api/source.md", "api/billing/domain.md", "overview.md"] }));
});

test("first path segment keeps original source directory names", () => {
  assert.equal(isSafeWikiPagePath("overview.md"), true);
  assert.equal(isSafeWikiPagePath("architecture.md"), true);
  assert.equal(isSafeWikiPagePath("MyRepo/source.md"), true);
  assert.equal(isSafeWikiPagePath("MyRepo/billing/domain.md"), true);
  assert.equal(isSafeWikiPagePath("MyRepo/billing/invoice/concept.md"), true);
  assert.equal(isSafeWikiPagePath("API/source.md"), true);
  assert.equal(wikiSpecPageType("MyRepo/source.md"), "source");
  assert.equal(wikiSpecPageType("MyRepo/core/domain.md"), "domain");
  assert.equal(wikiSpecPageType("MyRepo/billing/invoice/concept.md"), "concept");
  assert.equal(wikiSpecPageType("API/source.md"), "source");
  const spec = parseWikiSpec({
    pages: ["overview.md", "MyRepo/source.md", "MyRepo/core/domain.md", "API/source.md", "API/billing/domain.md"],
  });
  assert.deepEqual(wikiSpecSourceIds(spec), ["MyRepo", "API"]);
});

test("requires source and domain descriptor pages", () => {
  assert.throws(() => parseWikiSpec({ pages: ["overview.md"] }), /source/);
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "api/source.md"] }), /domain/);
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "api/billing/domain.md"] }), /source/);
  assert.throws(() => parseWikiSpec({ pages: ["overview.md", "api/source.md", "api/billing/invoice/concept.md"] }), /domain/);
});

test("collects every WikiSpec defect in one throw", () => {
  assert.throws(
    () => parseWikiSpec({
      extra: true,
      topologyVersion: 1,
      pages: ["api/billing/invoice.md", "billing/domain.md", "api/billing/invoice.md"],
    }),
    (error) => {
      assert.match(error.message, /unknown fields: extra/);
      assert.match(error.message, /topologyVersion must be 2/);
      assert.match(error.message, /duplicate page paths: api\/billing\/invoice\.md/);
      assert.match(error.message, /illegal page paths: api\/billing\/invoice\.md, billing\/domain\.md/);
      assert.match(error.message, /must include overview\.md/);
      assert.match(error.message, /at least one source\.md/);
      assert.match(error.message, /at least one domain\.md/);
      return true;
    },
  );
});

test("source-aware helpers and clusters preserve same domain slugs", () => {
  const spec = parseWikiSpec(validSpec());
  assert.equal(wikiSpecSourceId("api/source.md"), "api");
  assert.equal(wikiSpecSourceId("wiki/web/billing/domain.md"), "web");
  assert.equal(wikiSpecDomainId("api/billing/domain.md"), "billing");
  assert.equal(wikiSpecDomainKey("web/billing/domain.md"), "web/billing");
  assert.equal(wikiSpecClusterId("overview.md"), "_root");
  assert.equal(wikiSpecClusterId("api/source.md"), "api/_source");
  assert.equal(wikiSpecClusterId("api/billing/domain.md"), "api/billing");
  assert.equal(wikiSpecClusterId("api/billing/invoice/concept.md"), "api/billing/invoice");
  assert.equal(wikiSpecClusterId("wiki/api/billing/invoice/models/line-item.md"), "api/billing/invoice");
  assert.deepEqual(wikiSpecClusters(spec), ["_root", "api/_source", "api/billing", "api/billing/invoice", "web/_source", "web/billing"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "api/_source"), ["api/source.md"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "api/billing"), ["api/billing/domain.md"]);
  assert.deepEqual(wikiSpecClusterPaths(spec, "api/billing/invoice"), [
    "api/billing/invoice/concept.md",
    "api/billing/invoice/models.md",
    "api/billing/invoice/models/line-item.md",
    "api/billing/invoice/sequences.md",
  ]);
  assert.equal(sameWikiCluster(["api/billing/invoice/concept.md", "wiki/api/billing/invoice/sequences.md"]), true);
  assert.equal(sameWikiCluster(["api/billing/domain.md", "web/billing/domain.md"]), false);
  assert.equal(sameWikiCluster(["overview.md", "architecture.md"]), true);
  assert.equal(sameWikiCluster([]), false);
});

test("maps a cluster id to its source and parent", () => {
  assert.equal(wikiSpecClusterSourceId("_root"), undefined);
  assert.equal(wikiSpecClusterSourceId("api/_source"), "api");
  assert.equal(wikiSpecClusterSourceId("api/billing"), "api");
  assert.equal(wikiSpecClusterSourceId("api/billing/invoice"), "api");
  assert.equal(wikiSpecClusterSourceId("web/billing"), "web");
  assert.equal(wikiSpecClusterParent("_root"), undefined);
  assert.equal(wikiSpecClusterParent("api/_source"), "_root");
  assert.equal(wikiSpecClusterParent("api/billing"), "api/_source");
  assert.equal(wikiSpecClusterParent("api/billing/invoice"), "api/billing");
  assert.equal(wikiSpecClusterParent("web/billing"), "web/_source");
});
