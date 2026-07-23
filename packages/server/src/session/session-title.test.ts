/**
 * Session title helpers — default detection + first-prompt auto-title.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultSessionTitle,
  isDefaultSessionTitle,
  titleFromUserPrompt,
} from "./parent-session.ts";

test("defaultSessionTitle includes workspace name", () => {
  assert.equal(defaultSessionTitle("Demo"), "Wiki Agent · Demo");
});

test("isDefaultSessionTitle matches create-time titles", () => {
  assert.equal(isDefaultSessionTitle("Wiki Agent · Demo"), true);
  assert.equal(isDefaultSessionTitle("New session"), true);
  assert.equal(isDefaultSessionTitle("Refactor auth module"), false);
});

test("titleFromUserPrompt uses first line and truncates", () => {
  assert.equal(titleFromUserPrompt("Hello world\nmore detail"), "Hello world");
  const long = "x".repeat(100);
  const titled = titleFromUserPrompt(long, 20);
  assert.ok(titled.length <= 20);
  assert.ok(titled.endsWith("…"));
});
