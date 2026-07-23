/**
 * Session list must emit one row per product session id
 * (meta `.json` + workdir must not both appear).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mergePiSessionEntries } from "./agent-sessions.ts";

test("mergePiSessionEntries dedupes meta json + workdir for the same id", () => {
  const sessions = mergePiSessionEntries([
    {
      name: "729f9b3a-71aa-4961-8074-0d104cfdf6e2",
      isDirectory: true,
      updatedAt: "2026-07-22T15:59:00.000Z",
    },
    {
      name: "729f9b3a-71aa-4961-8074-0d104cfdf6e2.json",
      isDirectory: false,
      updatedAt: "2026-07-22T15:59:01.000Z",
    },
    {
      name: "2b029ada-6042-4cf1-9998-0b4f1e39d20e",
      isDirectory: true,
      updatedAt: "2026-07-22T15:58:00.000Z",
    },
    {
      name: "2b029ada-6042-4cf1-9998-0b4f1e39d20e.json",
      isDirectory: false,
      updatedAt: "2026-07-22T15:58:01.000Z",
    },
    // Pi SessionManager conversation storage — not a product list entry
    {
      name: "2026-07-22T15-59-40-130Z_019f8a8d-da62-7e6d-a6d8-680f28b2f423.jsonl",
      isDirectory: false,
      updatedAt: "2026-07-22T15:59:40.000Z",
    },
  ]);

  assert.equal(sessions.length, 2);
  assert.deepEqual(
    sessions.map((s) => s.id).sort(),
    [
      "2b029ada-6042-4cf1-9998-0b4f1e39d20e",
      "729f9b3a-71aa-4961-8074-0d104cfdf6e2",
    ],
  );
  for (const s of sessions) {
    assert.equal(s.name.endsWith(".json"), true);
    assert.equal(s.placeholder, true);
  }
});

test("mergePiSessionEntries keeps orphan workdir when meta is missing", () => {
  const sessions = mergePiSessionEntries([
    {
      name: "orphan-session-dir",
      isDirectory: true,
      updatedAt: "2026-07-22T16:00:00.000Z",
    },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "orphan-session-dir");
  assert.equal(sessions[0]?.placeholder, false);
});

test("mergePiSessionEntries preserves title from meta json", () => {
  const sessions = mergePiSessionEntries([
    {
      name: "abc-session.json",
      isDirectory: false,
      updatedAt: "2026-07-22T16:00:00.000Z",
      title: "Generate wiki for open-okf-wiki",
    },
    {
      name: "abc-session",
      isDirectory: true,
      updatedAt: "2026-07-22T15:59:00.000Z",
    },
  ]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.id, "abc-session");
  assert.equal(sessions[0]?.title, "Generate wiki for open-okf-wiki");
});
