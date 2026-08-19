import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendText, claimText, ensureDirectory, removePath, renamePath, withExclusiveLock, writeFileDurable, writeText } from "../extensions/wiki/lib/files.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "okf-wiki-files-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  return root;
}

test("durable text operations expose their completed persistence phases", async (t) => {
  const root = await fixture(t);
  const phases = [];
  const options = { fault: (phase) => phases.push(phase) };
  const file = path.join(root, "state.txt");

  await writeText(file, "one", options);
  assert.deepEqual(phases.splice(0), ["file_synced", "renamed", "directory_synced"]);
  await appendText(file, " two", options);
  assert.deepEqual(phases.splice(0), ["appended", "directory_synced"]);
  assert.equal(await readFile(file, "utf8"), "one two");

  const claim = path.join(root, "active.json");
  await claimText(claim, "{}", options);
  assert.deepEqual(phases.splice(0), ["claimed", "directory_synced"]);
  await assert.rejects(claimText(claim, "{}"), { code: "EEXIST" });
  await removePath(claim, { ...options, force: true });
  assert.deepEqual(phases.splice(0), ["removed", "directory_synced"]);
});

test("faults between entry mutation and directory sync expose the completed logical operation", async (t) => {
  const root = await fixture(t);
  const failAt = (expected) => ({ fault: (phase) => { if (phase === expected) throw new Error(`fault-${phase}`); } });

  const appended = path.join(root, "events.jsonl");
  await writeFile(appended, "one\n");
  await assert.rejects(appendText(appended, "two\n", failAt("appended")), /fault-appended/);
  assert.equal(await readFile(appended, "utf8"), "one\ntwo\n");

  const marker = path.join(root, "active.json");
  await assert.rejects(claimText(marker, "{}", failAt("claimed")), /fault-claimed/);
  assert.equal(await readFile(marker, "utf8"), "{}");

  await assert.rejects(removePath(marker, { ...failAt("removed"), force: true }), /fault-removed/);
  await assert.rejects(readFile(marker), { code: "ENOENT" });

  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await writeFile(source, "moved");
  await assert.rejects(renamePath(source, target, failAt("renamed")), /fault-renamed/);
  assert.equal(await readFile(target, "utf8"), "moved");
});

test("atomic write keeps the previous value when a fault occurs before rename", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  await assert.rejects(writeText(file, "new", {
    fault: (phase) => { if (phase === "file_synced") throw new Error("fault-before-rename"); },
  }), /fault-before-rename/);
  assert.equal(await readFile(file, "utf8"), "old");
});

test("durable rename syncs a cross-directory move and remove tolerates an absent forced target", async (t) => {
  const root = await fixture(t);
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  await mkdir(left);
  await mkdir(right);
  await writeFile(path.join(left, "value"), "moved");
  const phases = [];
  await renamePath(path.join(left, "value"), path.join(right, "value"), { fault: (phase) => phases.push(phase) });
  assert.deepEqual(phases, ["renamed", "directory_synced"]);
  assert.equal(await readFile(path.join(right, "value"), "utf8"), "moved");
  await removePath(path.join(root, "missing", "value"), { force: true });
});

test("durable directory creation syncs every new parent entry and tolerates concurrent creators", async (t) => {
  const root = await fixture(t);
  const target = path.join(root, "one", "two", "three");
  const phases = [];
  await Promise.all([
    ensureDirectory(target, { fault: (phase) => phases.push(phase) }),
    ensureDirectory(target),
  ]);
  assert.equal(phases.filter((phase) => phase === "directory_created").length, 3);
  assert.equal(phases.filter((phase) => phase === "directory_synced").length, 3);

  const faulted = path.join(root, "faulted");
  await assert.rejects(ensureDirectory(faulted, {
    fault: (phase) => { if (phase === "directory_created") throw new Error("fault-directory-created"); },
  }), /fault-directory-created/);
  await ensureDirectory(faulted);

  const bytes = Uint8Array.from([0, 1, 2, 255]);
  const binary = path.join(target, "snapshot.bin");
  await writeFileDurable(binary, bytes);
  assert.deepEqual(await readFile(binary), Buffer.from(bytes));
});

test("durable replace retries transient rename failures and keeps the new value", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  let attempts = 0;
  await writeText(file, "new", {
    delay: async () => {},
    rename: async (source, target) => {
      attempts += 1;
      if (attempts < 3) throw errno("EPERM");
      await rename(source, target);
    },
  });
  assert.equal(attempts, 3);
  assert.equal(await readFile(file, "utf8"), "new");
});

test("durable replace exhaustion keeps the previous value and names the failed replace", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  let attempts = 0;
  await assert.rejects(writeText(file, "new", {
    delay: async () => {},
    rename: async () => {
      attempts += 1;
      throw errno("EPERM");
    },
  }), (error) => {
    assert.equal(error.code, "EPERM");
    assert.match(error.message, /Durable replace failed after \d+ attempt/);
    assert.match(error.message, /state\.json/);
    return true;
  });
  assert.ok(attempts > 1);
  assert.equal(await readFile(file, "utf8"), "old");
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("durable replace clears a Windows read-only file then retries native rename", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  const chmodCalls = [];
  let attempts = 0;
  await writeText(file, "new", {
    platform: "win32",
    delay: async () => {},
    chmod: async (location, mode) => { chmodCalls.push({ location, mode }); },
    rename: async (source, target) => {
      attempts += 1;
      if (attempts === 1) throw errno("EPERM");
      await rename(source, target);
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(chmodCalls, [{ location: file, mode: 0o666 }]);
  assert.equal(await readFile(file, "utf8"), "new");
});

test("durable replace does not chmod on posix platforms", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  const chmodCalls = [];
  let attempts = 0;
  await writeText(file, "new", {
    platform: "linux",
    delay: async () => {},
    chmod: async (location, mode) => { chmodCalls.push({ location, mode }); },
    rename: async (source, target) => {
      attempts += 1;
      if (attempts === 1) throw errno("EPERM");
      await rename(source, target);
    },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(chmodCalls, []);
  assert.equal(await readFile(file, "utf8"), "new");
});

test("durable replace serializes concurrent writers to the same path", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "start");
  const order = [];
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const first = writeText(file, "one", {
    rename: async (source, target) => {
      order.push("first-rename");
      await firstHeld;
      await rename(source, target);
      order.push("first-done");
    },
  });
  await waitUntil(() => order.includes("first-rename"));
  let secondStarted = false;
  const second = writeText(file, "two", {
    rename: async (source, target) => {
      secondStarted = true;
      order.push("second-rename");
      await rename(source, target);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondStarted, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-rename", "first-done", "second-rename"]);
  assert.equal(await readFile(file, "utf8"), "two");
});

test("durable replace does not retry permanent rename errors", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "state.json");
  await writeText(file, "old");
  let attempts = 0;
  let delayed = 0;
  await assert.rejects(writeText(file, "new", {
    delay: async () => { delayed += 1; },
    rename: async () => {
      attempts += 1;
      throw errno("EIO");
    },
  }), (error) => error.code === "EIO");
  assert.equal(attempts, 1);
  assert.equal(delayed, 0);
  assert.equal(await readFile(file, "utf8"), "old");
});

test("durable path rename retries transient replace failures", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  await writeFile(source, "moved");
  await writeFile(target, "old");
  let attempts = 0;
  await renamePath(source, target, {
    delay: async () => {},
    rename: async (from, to) => {
      attempts += 1;
      if (attempts < 2) throw errno("EBUSY");
      await rename(from, to);
    },
  });
  assert.equal(attempts, 2);
  assert.equal(await readFile(target, "utf8"), "moved");
});

test("durable path rename does not chmod a directory destination", async (t) => {
  const root = await fixture(t);
  const source = path.join(root, "from-dir");
  const target = path.join(root, "to-dir");
  await mkdir(source);
  await writeFile(path.join(source, "a"), "1");
  await mkdir(target);
  const chmodCalls = [];
  let attempts = 0;
  await assert.rejects(renamePath(source, target, {
    platform: "win32",
    delay: async () => {},
    chmod: async (location, mode) => { chmodCalls.push({ location, mode }); },
    rename: async () => {
      attempts += 1;
      throw errno(attempts === 1 ? "EPERM" : "EIO");
    },
  }), (error) => error.code === "EIO");
  assert.equal(attempts, 2);
  assert.deepEqual(chmodCalls, []);
});

test("exclusive lock serializes locally, waits on a live owner, and reclaims a dead lease", async (t) => {
  const root = await fixture(t);
  const lockPath = path.join(root, "critical.lock");
  const order = [];
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  const first = withExclusiveLock(lockPath, async () => {
    order.push("first-enter");
    await firstHeld;
    order.push("first-leave");
    return "first";
  });
  await waitUntil(() => order.includes("first-enter"));
  let secondDone = false;
  const second = withExclusiveLock(lockPath, async () => {
    order.push("second");
    secondDone = true;
    return "second";
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondDone, false);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first-enter", "first-leave", "second"]);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });

  await writeFile(lockPath, "");
  let acquiredWhileInitializing = false;
  const initializing = withExclusiveLock(lockPath, async () => {
    acquiredWhileInitializing = true;
    return "reclaimed";
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(acquiredWhileInitializing, false, "a fresh partial lease must not be reclaimed as stale");
  await writeFile(lockPath, JSON.stringify({
    version: 1, pid: 999_999_999, token: "dead-owner", acquiredAt: "2026-08-16T00:00:00.000Z",
  }));
  assert.equal(await initializing, "reclaimed");
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });

  await assert.rejects(withExclusiveLock(lockPath, async () => {
    throw new Error("critical-section-failed");
  }), /critical-section-failed/);
  await assert.rejects(readFile(lockPath), { code: "ENOENT" });
});

function errno(code) {
  const error = new Error(`${code}: operation not permitted, rename`);
  error.code = code;
  error.syscall = "rename";
  return error;
}

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for exclusive lock");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
