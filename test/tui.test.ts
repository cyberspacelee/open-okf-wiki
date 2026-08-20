import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createWikiOverlay, openWikiStatusOverlay, wikiWidgetFactory } from "../extensions/wiki/lib/tui.js";

function view(overrides = {}) {
  return {
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    goal: "Auth wiki",
    tasks: [{ id: "write", content: "Write overview", status: "in_progress" }],
    agents: [
      { agent: "lead", status: "running", tools: [{ id: "l1", tool: "todo", args: { action: "write" }, status: "complete" }] },
      {
        agent: "write",
        task: "author pages",
        status: "running",
        tools: [
          { id: "1", tool: "read", args: { path: "src/a.ts" }, status: "complete" },
          { id: "2", tool: "grep", args: { pattern: "Order" }, status: "running" },
        ],
      },
    ],
    ...overrides,
  };
}

function handle(current = view()) {
  const listeners = new Set();
  const controls = [];
  return {
    id: current.id,
    current,
    listeners,
    controls,
    async view() { return this.current; },
    subscribe(listener) {
      this.listeners.add(listener);
      listener(this.current);
      return () => this.listeners.delete(listener);
    },
    async control(action) {
      this.controls.push(action);
      this.current = { ...this.current, status: action === "cancel" ? "cancelled" : action === "pause" ? "paused" : "running" };
      for (const listener of this.listeners) listener(this.current);
      return this.current;
    },
    emit(next) {
      this.current = next;
      for (const listener of this.listeners) listener(next);
    },
  };
}

function overlay(current = view(), options = {}) {
  const renders = [];
  const tui = { requestRender() { renders.push(true); }, terminal: { rows: 24 } };
  const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
  const keybindings = { matches(data, binding) { return data === binding; } };
  let closed = false;
  const run = handle(current);
  const component = createWikiOverlay({
    tui,
    theme,
    keybindings,
    done() { closed = true; },
    handle: run,
    view: current,
    now: () => Date.parse("2026-08-12T00:01:00.000Z"),
    ...options,
  });
  return {
    component,
    tui,
    renders,
    closed: () => closed,
    handle: run,
    dispose() { component.dispose(); },
  };
}

function plain(text) {
  return text.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

test("missing custom UI returns without reading the handle", async () => {
  let viewed = false;
  await openWikiStatusOverlay({
    ui: {},
    handle: { id: "run-1", async view() { viewed = true; return view(); }, subscribe() { return () => {}; }, async control() { return view(); } },
  });
  assert.equal(viewed, false);
});

test("overlay lists lead and agents and shows the selected process", () => {
  const { component, dispose } = overlay();
  try {
  const wide = component.render(120).join("\n");
  assert.match(wide, /Wiki run-1 \| running/);
  assert.match(wide, /lead/);
  assert.match(wide, /write/);
  assert.match(wide, /grep \/Order\//);
  const narrow = component.render(60).join("\n");
  assert.match(narrow, /in_progress|Write overview|Board/);
  assert.ok(wide.split("\n").every((line) => [...line].length <= 200));
  } finally { dispose(); }
});

test("enter inspects the selected agent and t jumps to the newest tool", () => {
  const tools = [];
  for (let index = 0; index < 30; index += 1) {
    tools.push({ id: `t${index}`, tool: "read", args: { path: `src/${index}.ts` }, status: "complete" });
  }
  tools.push({ id: "live", tool: "grep", args: { pattern: "Tail" }, status: "running" });
  const current = view({
    agents: [
      { agent: "lead", status: "running", tools: [] },
      { agent: "write", status: "running", tools },
    ],
  });
  const { component, dispose } = overlay(current);
  try {
    component.handleInput("j");
    component.handleInput("tui.select.confirm");
    const top = component.render(80).join("\n");
    assert.match(top, /src\/0\.ts/);
    assert.doesNotMatch(top, /grep \/Tail\//);
    component.handleInput("t");
    const tail = component.render(80).join("\n");
    assert.match(tail, /grep \/Tail\//);
  } finally { dispose(); }
});

test("p and x call control on the run page", async () => {
  const { component, handle: run, closed } = overlay();
  component.handleInput("p");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(run.controls, ["pause"]);
  component.handleInput("x");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(run.controls, ["pause", "cancel"]);
  assert.equal(closed(), true);
});

test("pause and resume use distinct controls and are disabled in agent details", async () => {
  const { component, handle: run, dispose } = overlay();
  try {
    component.handleInput("r");
    component.handleInput("p");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(run.controls, ["pause"]);
    component.handleInput("p");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(run.controls, ["pause"]);
    component.handleInput("r");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(run.controls, ["pause", "resume"]);

    component.handleInput("tui.select.confirm");
    component.handleInput("p");
    component.handleInput("r");
    component.handleInput("x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(run.controls, ["pause", "resume"]);
  } finally { dispose(); }
});

test("cancel confirmation can abort", async () => {
  let asked = false;
  const { component, handle: run, closed, dispose } = overlay(view(), {
    confirmCancel: async () => {
      asked = true;
      return false;
    },
  });
  try {
    component.handleInput("x");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(asked, true);
    assert.deepEqual(run.controls, []);
    assert.equal(closed(), false);
  } finally { dispose(); }
});

test("incoming subscribe updates re-render the overlay", () => {
  const { component, handle: run, renders, dispose } = overlay();
  try {
    component.render(80);
    const before = renders.length;
    run.emit(view({ status: "paused" }));
    assert.ok(renders.length > before);
    assert.match(component.render(80).join("\n"), /paused/);
  } finally { dispose(); }
});

test("overlay lines fit the requested width", () => {
  const { component, dispose } = overlay(view({
    agents: [{ agent: "write", task: "x".repeat(200), status: "running", tools: [{ id: "1", tool: "read", args: { path: "src/" + "a".repeat(200) }, status: "running" }] }],
  }));
  try {
    for (const width of [36, 60, 100, 120]) {
      for (const line of component.render(width)) {
        assert.ok([...line].length <= width + 20, `${width}: ${line.length} ${line}`);
      }
    }
  } finally { dispose(); }
});

test("ANSI and Chinese content keep every overlay border aligned", () => {
  const ansi = (text) => `\u001b[36m${text}\u001b[0m`;
  const current = view({
    goal: "生成认证与订单领域文档",
    agents: [{
      agent: "write",
      task: "编写".repeat(80),
      status: "running",
      tools: [{ id: "1", tool: "read", args: { path: `src/${"目录".repeat(80)}.ts` }, status: "running" }],
    }],
  });
  const { component, dispose } = overlay(current, {
    theme: { fg(_color, text) { return ansi(text); }, bold(text) { return ansi(text); } },
  });
  try {
    for (const width of [36, 60, 100, 120]) {
      const rendered = component.render(width);
      assert.ok(rendered.some((line) => line.includes("\u001b[")));
      assert.ok(rendered.every((line) => visibleWidth(line) === width), `misaligned frame at width ${width}`);
    }
  } finally { dispose(); }
});

test("overlay uses semantic chrome and a visible selected row", () => {
  const calls = [];
  const ansi = (text) => `\u001b[36m${text}\u001b[0m`;
  const theme = {
    fg(color, text) { calls.push({ method: "fg", color, text }); return ansi(text); },
    bg(color, text) { calls.push({ method: "bg", color, text }); return ansi(text); },
    bold(text) { calls.push({ method: "bold", text }); return ansi(text); },
  };
  const { component, dispose } = overlay(view(), { theme });
  try {
    const rendered = component.render(120);
    const text = plain(rendered.join("\n"));
    assert.match(plain(rendered[0]), /^╭.*Wiki run-1.*running.*╮$/);
    assert.match(plain(rendered.at(-1)), /^╰.*select.*open.*╯$/i);
    assert.match(text, /Agents\s+2.*Board\s+0\/1/s);
    assert.match(text, /> .*lead/);
    assert.ok(calls.some((call) => call.method === "bg" && call.color === "selectedBg"));
    assert.ok(calls.some((call) => call.method === "fg" && call.color === "borderMuted"));
    assert.doesNotMatch(plain(component.render(99).join("\n")), / │ /);
    assert.match(plain(component.render(100).join("\n")), / │ /);
  } finally { dispose(); }
});

test("small viewports keep the selected agent visible and open that agent", () => {
  const agents = Array.from({ length: 18 }, (_, index) => ({
    agent: `agent-${index}`,
    task: `task ${index}`,
    status: "running",
    tools: [],
  }));
  const { component, tui, dispose } = overlay(view({ agents }));
  tui.terminal.rows = 12;
  try {
    for (let index = 0; index < 14; index += 1) component.handleInput("j");
    const runPage = plain(component.render(60).join("\n"));
    assert.match(runPage, /> .*agent-14/);
    component.handleInput("tui.select.confirm");
    assert.match(plain(component.render(60).join("\n")), /Process.*agent-14/s);
  } finally { dispose(); }
});

test("terminal height changes keep a complete fixed-height frame", () => {
  const { component, tui, dispose } = overlay();
  try {
    for (const [rows, expected] of [[12, 10], [24, 21], [30, 26]]) {
      tui.terminal.rows = rows;
      const rendered = component.render(80);
      assert.equal(rendered.length, expected);
      assert.match(plain(rendered[0]), /^╭.*╮$/);
      assert.match(plain(rendered.at(-1)), /^╰.*╯$/);
    }
  } finally { dispose(); }
});

test("agent details keep the top on updates, follow the tail, and return to top with g", () => {
  const tools = Array.from({ length: 30 }, (_, index) => ({
    id: `t${index}`, tool: "read", args: { path: `src/${index}.ts` }, status: "complete",
  }));
  const current = view({ agents: [{ agent: "write", status: "running", tools }] });
  const { component, handle: run, dispose } = overlay(current);
  try {
    component.handleInput("tui.select.confirm");
    assert.match(plain(component.render(60).join("\n")), /src\/0\.ts/);
    run.emit(view({ agents: [{ agent: "write", status: "running", tools: [...tools, { id: "new", tool: "grep", args: { pattern: "Newest" }, status: "running" }] }] }));
    assert.match(plain(component.render(60).join("\n")), /src\/0\.ts/);
    component.handleInput("t");
    assert.match(plain(component.render(60).join("\n")), /grep \/Newest\//);
    component.handleInput("tui.select.down");
    assert.match(plain(component.render(60).join("\n")), /grep \/Newest\//);
    component.handleInput("g");
    const top = plain(component.render(60).join("\n"));
    assert.match(top, /src\/0\.ts/);
    assert.doesNotMatch(top, /grep \/Newest\//);
  } finally { dispose(); }
});

test("widget factory renders live lines and follows box updates", () => {
  const box = { view: view() };
  const tui = { requestRender() {} };
  const widget = wikiWidgetFactory(box)(tui, { fg(_c, text) { return text; } });
  assert.match(widget.render(80).join("\n"), /◆ write · grep \/Order\//);
  box.view = view({ agents: [{ agent: "survey", status: "running", tools: [{ id: "1", tool: "ls", args: { path: "." }, status: "running" }] }] });
  assert.match(widget.render(80).join("\n"), /◆ survey · ls \./);
});
