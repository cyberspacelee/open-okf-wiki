/**
 * Unit tests for the single cancel classifier (isRunCancelledError).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { isRunCancelledError } from "./cancel.js";

test("isRunCancelledError: AbortError / TimeoutError / WikiRunCancelled names", () => {
  for (const name of ["AbortError", "TimeoutError", "WikiRunCancelled"]) {
    const err = new Error("x");
    err.name = name;
    assert.equal(isRunCancelledError(err), true, name);
  }
});

test("isRunCancelledError: message patterns", () => {
  assert.equal(isRunCancelledError(new Error("request aborted")), true);
  assert.equal(isRunCancelledError(new Error("AbortError: cancelled")), true);
  assert.equal(isRunCancelledError(new Error("Wiki Run cancelled")), true);
  assert.equal(isRunCancelledError(new Error("plan declined by operator")), true);
  assert.equal(isRunCancelledError(new Error("worker bailed early")), true);
});

test("isRunCancelledError: non-cancel errors and non-objects", () => {
  assert.equal(isRunCancelledError(new Error("provider timeout after 3 retries")), false);
  assert.equal(isRunCancelledError(new Error("validation failed")), false);
  assert.equal(isRunCancelledError(null), false);
  assert.equal(isRunCancelledError(undefined), false);
  assert.equal(isRunCancelledError("aborted"), false);
  assert.equal(isRunCancelledError(42), false);
});

test("isRunCancelledError: plain objects with name", () => {
  assert.equal(isRunCancelledError({ name: "AbortError" }), true);
  assert.equal(isRunCancelledError({ name: "TimeoutError" }), true);
  assert.equal(isRunCancelledError({ name: "WikiRunCancelled" }), true);
  // Non-Error objects without a cancel name: String(obj) is not matched.
  assert.equal(isRunCancelledError({ name: "Error" }), false);
  assert.equal(isRunCancelledError({ name: "Error", message: "cancelled" }), false);
});
