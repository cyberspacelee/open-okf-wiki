import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRootDelegationOptions,
  createDelegationCounters,
} from "./delegation.js";

test("onDelegationStart rejects excess domain fan-out", async () => {
  const counters = createDelegationCounters();
  const d = buildRootDelegationOptions({
    orchestration: {
      maxDepth: 2,
      maxDomainFanOut: 1,
      maxLeafFanOut: 2,
      rootMaxSteps: 96,
      domainMaxSteps: 12,
      leafMaxSteps: 8,
      reviewerMaxSteps: 8,
      planMaxSteps: 24,
      reviewCouncilSize: 1,
    },
    counters,
  });

  const first = await d.onDelegationStart({
    primitiveId: "domainResearcher",
    prompt: "scope A",
    iteration: 1,
  });
  assert.equal(first.proceed, true);

  const second = await d.onDelegationStart({
    primitiveId: "domainResearcher",
    prompt: "scope B",
    iteration: 2,
  });
  assert.equal(second.proceed, false);
  assert.match(String(second.rejectionReason), /maxDomainFanOut/i);
});

test("messageFilter keeps only last messages", () => {
  const d = buildRootDelegationOptions({});
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: "user",
    content: `m${i}`,
  }));
  const filtered = d.messageFilter({
    messages,
    primitiveId: "leafResearcher",
    prompt: "x",
  });
  assert.equal(Array.isArray(filtered) && filtered.length, 6);
});
