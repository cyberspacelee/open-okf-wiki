import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  redactErrorMessage,
  redactSensitiveText,
  redactSensitiveValue,
  sanitizeSummary,
} from "./run-redact.js";

describe("run-redact", () => {
  it("redacts API keys, bearer tokens, URL credentials, and absolute paths", () => {
    const raw =
      "HTTP 401 Authorization: Bearer tokensecret123 " +
      "key=sk-live-abcdefghijklmnopqrstuvwxyz " +
      "api_key=super-secret-value path=/home/cyberspace/secret/key " +
      "url=https://user:hunter2@gateway.example/v1";
    const redacted = redactSensitiveText(raw);
    assert.equal(redacted.includes("sk-live"), false);
    assert.equal(redacted.includes("tokensecret123"), false);
    assert.equal(redacted.includes("hunter2"), false);
    assert.equal(redacted.includes("super-secret-value"), false);
    assert.equal(redacted.includes("/home/cyberspace"), false);
    assert.match(redacted, /\[redacted-key\]/);
    assert.match(redacted, /Bearer \[redacted\]/);
    assert.match(redacted, /api_key=\[redacted\]/);
    assert.match(redacted, /\[redacted-path\]/);
    assert.match(redacted, /\[redacted\]:\[redacted\]@/);
  });

  it("redactErrorMessage never returns [object Object] and redacts secrets", () => {
    assert.notEqual(redactErrorMessage({ weird: true }), "[object Object]");
    const message = redactErrorMessage(
      new Error("provider failed with sk-abc1234567890 at /home/runner/work/key"),
    );
    assert.equal(message.includes("sk-abc"), false);
    assert.equal(message.includes("/home/runner"), false);
    assert.match(message, /\[redacted-key\]/);
    assert.match(message, /\[redacted-path\]/);
  });

  it("redactSensitiveValue deep-clones and redacts nested error fields", () => {
    const input = {
      type: "auto_retry_start",
      errorMessage: "Bearer tokensecret123 api_key=supersecret",
      nested: {
        path: "/tmp/okf/run/secret.json",
        ok: true,
      },
    };
    const out = redactSensitiveValue(input);
    assert.notEqual(out, input);
    assert.notEqual(out.nested, input.nested);
    assert.equal(input.errorMessage.includes("tokensecret123"), true);
    assert.equal(out.errorMessage.includes("tokensecret123"), false);
    assert.match(out.errorMessage, /Bearer \[redacted\]/);
    assert.match(out.nested.path, /\[redacted-path\]/);
    assert.equal(out.nested.ok, true);
    assert.equal(out.type, "auto_retry_start");
  });

  it("sanitizeSummary collapses whitespace and redacts", () => {
    const summary = sanitizeSummary("  key sk-abcdefghijklmn  \n ok  ");
    assert.ok(summary);
    assert.equal(summary.includes("sk-"), false);
    assert.match(summary, /\[redacted-key\]/);
  });
});
