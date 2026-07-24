import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertSafeWikiToolList,
  isReadOnlyToolList,
  roleMayWrite,
  toolNamesForRole,
} from "./tool-policy.js";

describe("tool-policy", () => {
  it("plan / research / reviewer are read-only Pi tools", () => {
    for (const role of ["plan", "root_research", "domain", "leaf", "reviewer"] as const) {
      const tools = toolNamesForRole(role);
      assert.deepEqual([...tools], ["read", "grep", "find", "ls"]);
      assert.equal(roleMayWrite(role), false);
      assert.equal(isReadOnlyToolList(tools), true);
      assertSafeWikiToolList(tools);
    }
  });

  it("operator chat exposes no file tools", () => {
    assert.deepEqual([...toolNamesForRole("operator_chat")], []);
  });

  it("root_write adds write and edit only", () => {
    const tools = toolNamesForRole("root_write");
    assert.deepEqual([...tools], ["read", "grep", "find", "ls", "write", "edit"]);
    assert.equal(roleMayWrite("root_write"), true);
    assertSafeWikiToolList(tools);
  });

  it("rejects bash and unknown tools", () => {
    assert.throws(() => assertSafeWikiToolList(["bash"]), /forbidden/);
    assert.throws(() => assertSafeWikiToolList(["list_source"]), /unknown/);
  });
});
