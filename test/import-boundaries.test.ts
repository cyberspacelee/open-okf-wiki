import assert from "node:assert/strict";
import test from "node:test";
import { forbiddenPiImports } from "../scripts/check-import-boundaries.mjs";

test("Pi import boundary parser covers every module-loading form", () => {
  const source = [
    'import "@earendil-works/side-effect";',
    'import {',
    '  value,',
    '} from "@earendil-works/static";',
    'export { other } from "@earendil-works/exported";',
    'const dynamic = import("@earendil-works/dynamic");',
    'const template = import(`@earendil-works/template`);',
    'const legacy = require("@earendil-works/legacy");',
    '// import "@earendil-works/comment";',
    'const text = \'require("@earendil-works/string")\';',
  ].join("\n");
  assert.deepEqual(forbiddenPiImports(source).map(({ specifier }) => specifier), [
    "@earendil-works/side-effect",
    "@earendil-works/static",
    "@earendil-works/exported",
    "@earendil-works/dynamic",
    "@earendil-works/template",
    "@earendil-works/legacy",
  ]);
});
