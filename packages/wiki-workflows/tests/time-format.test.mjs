import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("formats absolute timestamps in the system timezone", () => {
  const script = [
    'import { formatLocalDateTime } from "./dist/ui/time-format.js";',
    'process.stdout.write(JSON.stringify({',
    '  dateTime: formatLocalDateTime("2026-08-12T00:01:02.000Z"),',
    '}));',
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, LANG: "en_US.UTF-8", TZ: "Asia/Shanghai" },
  });
  assert.deepEqual(JSON.parse(output), {
    dateTime: "Aug 12, 2026, 8:01:02 AM",
  });
});

test("preserves invalid timestamp text", async () => {
  const { formatLocalDateTime } = await import("../dist/ui/time-format.js");
  assert.equal(formatLocalDateTime("not-a-date"), "not-a-date");
});
