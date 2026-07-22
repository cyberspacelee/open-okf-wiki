import assert from "node:assert/strict";
import { test } from "node:test";
import {
  durableProduceEnabled,
  tryCreateDurableRoot,
} from "./durable-produce.js";

test("durableProduceEnabled reads env flags", () => {
  assert.equal(durableProduceEnabled({}), false);
  assert.equal(durableProduceEnabled({ OKF_WIKI_DURABLE_PRODUCE: "1" }), true);
  assert.equal(durableProduceEnabled({ OKF_WIKI_DURABLE_PRODUCE: "true" }), true);
  assert.equal(durableProduceEnabled({ OKF_WIKI_DURABLE_PRODUCE: "0" }), false);
});

test("tryCreateDurableRoot returns null until durable stream is wired", async () => {
  const prev = process.env.OKF_WIKI_DURABLE_PRODUCE;
  process.env.OKF_WIKI_DURABLE_PRODUCE = "1";
  try {
    assert.equal(await tryCreateDurableRoot({}), null);
  } finally {
    if (prev === undefined) {
      delete process.env.OKF_WIKI_DURABLE_PRODUCE;
    } else {
      process.env.OKF_WIKI_DURABLE_PRODUCE = prev;
    }
  }
});
