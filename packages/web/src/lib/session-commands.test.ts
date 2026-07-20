import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampSlashHighlight,
  filterSessionCommands,
  isSlashMenuOpenQuery,
  parseSessionSlashInput,
  tabCompleteSlashInput,
} from "./session-commands.ts";

test("parseSessionSlashInput expands chat slash commands", () => {
  assert.deepEqual(parseSessionSlashInput("generate a wiki plan"), {
    kind: "none",
  });
  assert.deepEqual(parseSessionSlashInput("/generate"), {
    kind: "send",
    text: "generate a wiki plan",
  });
  assert.deepEqual(parseSessionSlashInput("/run overview only"), {
    kind: "send",
    text: "overview only",
  });
  assert.deepEqual(parseSessionSlashInput("/approve"), {
    kind: "send",
    text: "approve",
  });
  assert.deepEqual(parseSessionSlashInput("/deny"), {
    kind: "send",
    text: "deny",
  });
});

test("parseSessionSlashInput local actions", () => {
  assert.deepEqual(parseSessionSlashInput("/reset"), {
    kind: "local",
    action: "reset",
  });
  assert.deepEqual(parseSessionSlashInput("/new"), {
    kind: "local",
    action: "new",
  });
  assert.deepEqual(parseSessionSlashInput("/delete"), {
    kind: "local",
    action: "delete",
  });
  assert.deepEqual(parseSessionSlashInput("/stop"), {
    kind: "local",
    action: "stop",
  });
  assert.deepEqual(parseSessionSlashInput("/help"), {
    kind: "local",
    action: "help",
  });
  assert.deepEqual(parseSessionSlashInput("/unknown"), {
    kind: "local",
    action: "help",
  });
});

test("filterSessionCommands and menu open query", () => {
  assert.ok(filterSessionCommands("/gen").some((c) => c.id === "generate"));
  assert.ok(filterSessionCommands("reset").some((c) => c.id === "reset"));
  assert.equal(isSlashMenuOpenQuery("/"), true);
  assert.equal(isSlashMenuOpenQuery("/gen"), true);
  assert.equal(isSlashMenuOpenQuery("/generate "), false);
  assert.equal(isSlashMenuOpenQuery("hello"), false);
});

test("tabCompleteSlashInput completes and cycles", () => {
  const gen = filterSessionCommands("/gen");
  assert.ok(gen.length >= 1);
  const filled = tabCompleteSlashInput("/gen", gen, 0);
  assert.equal(filled.nextInput, "/generate");
  assert.equal(filled.nextHighlight, 0);

  const all = filterSessionCommands("/");
  const first = tabCompleteSlashInput("/", all, 0);
  assert.equal(first.nextInput, all[0]!.command);
  const cycled = tabCompleteSlashInput(first.nextInput, all, first.nextHighlight);
  assert.equal(cycled.nextInput, all[1]!.command);
  assert.equal(cycled.nextHighlight, 1);

  assert.equal(clampSlashHighlight(-1, 3), 2);
  assert.equal(clampSlashHighlight(3, 3), 0);
});
