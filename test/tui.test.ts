import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createWikiOverlay, openWikiStatusOverlay, wikiWidgetFactory } from "../extensions/wiki/lib/tui.js";

const ACTIVITY_AT = "2026-08-12T00:00:30.000Z";

function view(overrides = {}) {
  const current = {
    id: "run-1",
    cwd: "/repo",
    status: "running",
    focus: "auth",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
    goal: "Auth wiki",
    tasks: [{ id: "write", content: "Write overview", status: "in_progress", note: "Keep citations current" }],
    agents: [
      { id: "lead", agent: "lead", status: "running", tools: [{ id: "l1", tool: "todo", args: { action: "write" }, status: "complete" }] },
      {
        id: "write-1",
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
  return {
    ...current,
    agents: current.agents?.map((agent) => {
      if (agent.activity) return agent;
      const { tools = [], ...rest } = agent;
      return { ...rest, activity: tools.map((tool) => ({ kind: "tool", at: ACTIVITY_AT, ...tool })) };
    }),
  };
}

function handle(current = view(), options = {}) {
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
      if (options.control) return await options.control.call(this, action);
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
  const run = options.run ?? handle(current);
  const component = createWikiOverlay({
    tui,
    theme,
    keybindings,
    done() { closed = true; },
    handle: run,
    initialView: current,
    confirmCancel: async () => true,
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

function rendered(component, width = 80) {
  return plain(component.render(width).join("\n"));
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("missing custom UI returns without reading the handle", async () => {
  let viewed = false;
  await openWikiStatusOverlay({
    ui: {},
    handle: { id: "run-1", async view() { viewed = true; return view(); }, subscribe() { return () => {}; }, async control() { return view(); } },
  });
  assert.equal(viewed, false);
});

test("overlay uses one bounded height contract and a current-run cancel prompt", async () => {
  let options;
  let prompt;
  await openWikiStatusOverlay({
    ui: {
      async custom(factory, next) {
        options = next;
        const component = await factory(
          { requestRender() {}, terminal: { rows: 24 } },
          {},
          { matches() { return false; } },
          () => {},
        );
        component.handleInput("x");
        await nextTurn();
        component.dispose();
      },
      async confirm(title, message) { prompt = [title, message]; return false; },
    },
    handle: handle(),
  });
  assert.equal(options.overlayOptions.maxHeight, 40);
  assert.deepEqual(prompt, ["Cancel Wiki run", "Cancel the current Wiki run?"]);
});

test("agents are the default view and layout responds to readable pane widths", () => {
  const { component, dispose } = overlay();
  try {
    const compact = rendered(component, 60);
    const split = rendered(component, 80);
    assert.match(split, /Wiki status \| running/);
    assert.doesNotMatch(split, /run-1/);
    assert.match(split, /\[Agents 2 · 2 active\].*Board 0\/1/s);
    assert.match(split, /> .*lead/);
    assert.match(split, /Process.*lead/s);
    assert.doesNotMatch(compact, / │ /);
    assert.match(split, / │ /);
    assert.doesNotMatch(compact, /Write overview/);
  } finally { dispose(); }
});

test("Tab opens a complete Board with goal, Task content, notes, and source order", () => {
  const tasks = [
    { id: "survey", content: "Survey the repository", status: "completed", note: "Mapped backend and frontend" },
    { id: "write", content: "Write the authentication and order documentation", status: "in_progress", note: "Keep citations current and precise" },
    { id: "review", content: "Review every generated page", status: "pending" },
  ];
  const { component, dispose } = overlay(view({ goal: "Generate detailed repository documentation", tasks }));
  try {
    component.handleInput("\t");
    const board = rendered(component, 60);
    assert.match(board, /Agents 2.*\[Board 1\/3\]/s);
    assert.match(board, /Goal.*Generate detailed repository documentation/s);
    assert.match(board, /survey.*Survey the repository/s);
    assert.match(board, /write.*authentication and order documentation/s);
    assert.match(board, /note: Keep citations current and precise/s);
    assert.ok(board.indexOf("survey") < board.indexOf("write"));
    assert.ok(board.indexOf("write") < board.indexOf("review"));
    component.handleInput("\t");
    assert.match(rendered(component, 60), /\[Agents 2 · 2 active\]/);
  } finally { dispose(); }
});

test("Process renders complete input, assistant output, tool calls, and tool results", () => {
  const current = view({ agents: [{
    id: "write",
    agent: "write",
    task: "author authentication",
    status: "running",
    activity: [
      { kind: "input", id: "input-1", at: ACTIVITY_AT, text: "Inspect authentication before writing." },
      { kind: "output", id: "output-1", at: ACTIVITY_AT, text: "I found the authentication boundary.", status: "complete" },
      { kind: "tool", id: "tool-1", at: ACTIVITY_AT, tool: "read", args: { path: "src/auth.ts" }, status: "complete", result: "export function authenticate()" },
    ],
  }] });
  const { component, dispose } = overlay(current);
  try {
    component.handleInput("tui.select.confirm");
    const process = rendered(component, 80);
    const localTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" }).format(Date.parse(ACTIVITY_AT));
    assert.match(process, /Process.*write.*author authentication/s);
    assert.match(process, /Input.*Inspect authentication before writing\./s);
    assert.match(process, /Assistant.*I found the authentication boundary\./s);
    assert.match(process, /Tool.*read src\/auth\.ts/s);
    assert.match(process, /Result.*export function authenticate\(\)/s);
    assert.ok(process.includes(localTime));
  } finally { dispose(); }
});

test("Board initially reveals the active Task and exposes every long Task by scrolling", () => {
  const tasks = Array.from({ length: 18 }, (_, index) => ({
    id: `task-${index}`,
    content: `Task content ${index} ${"detail ".repeat(6)}`,
    status: index === 14 ? "in_progress" : "pending",
    ...(index === 14 ? { note: "Current work is here" } : {}),
  }));
  const { component, tui, dispose } = overlay(view({ tasks }));
  tui.terminal.rows = 12;
  try {
    component.handleInput("\t");
    const active = rendered(component, 52);
    assert.match(active, /task-14/);
    assert.match(active, /Current work is here/);
    assert.match(active, /\d+–\d+\/\d+/);
    component.handleInput("g");
    assert.match(rendered(component, 52), /task-0/);
    component.handleInput("\u001b[F");
    assert.match(rendered(component, 52), /task-17/);
  } finally { dispose(); }
});

test("agent focus follows stable id across insertion and reordering", () => {
  const current = view({ agents: [
    { id: "lead", agent: "lead", status: "running", tools: [] },
    { id: "survey-a", agent: "survey", task: "backend", status: "running", tools: [{ id: "a", tool: "read", args: { path: "backend.ts" }, status: "running" }] },
    { id: "survey-b", agent: "survey", task: "frontend", status: "running", tools: [{ id: "b", tool: "read", args: { path: "frontend.ts" }, status: "running" }] },
  ] });
  const { component, handle: run, dispose } = overlay(current);
  try {
    component.handleInput("j");
    component.handleInput("tui.select.confirm");
    assert.match(rendered(component), /Process.*survey.*backend/s);
    run.emit(view({ agents: [
      { id: "new", agent: "survey", task: "new", status: "running", tools: [] },
      current.agents[2],
      current.agents[0],
      current.agents[1],
    ] }));
    const detail = rendered(component);
    assert.match(detail, /Process.*survey.*backend/s);
    assert.match(detail, /backend\.ts/);
    assert.doesNotMatch(detail, /frontend\.ts/);
  } finally { dispose(); }
});

test("removing the selected agent returns to Agents and chooses the nearest row", () => {
  const current = view({ agents: [
    { id: "a", agent: "a", status: "running", tools: [] },
    { id: "b", agent: "b", status: "running", tools: [] },
    { id: "c", agent: "c", status: "running", tools: [] },
  ] });
  const { component, handle: run, dispose } = overlay(current);
  try {
    component.handleInput("j");
    component.handleInput("tui.select.confirm");
    run.emit(view({ agents: [current.agents[0], current.agents[2]] }));
    const listing = rendered(component);
    assert.match(listing, /selected agent is no longer available/i);
    assert.match(listing, /> .*c/);
    assert.doesNotMatch(listing, /Process.* b/);
  } finally { dispose(); }
});

test("Process preserves complete history, reading position, and explicit tail following", () => {
  const tools = Array.from({ length: 30 }, (_, index) => ({
    id: `t${index}`, tool: "read", args: { path: `src/${index}.ts` }, status: "complete",
  }));
  const current = view({ agents: [{ id: "write", agent: "write", status: "running", tools }] });
  const { component, handle: run, dispose } = overlay(current);
  try {
    const preview = rendered(component, 80);
    assert.match(preview, /Process.*write/s);
    assert.match(preview, /src\/29\.ts/);
    component.handleInput("tui.select.confirm");
    assert.match(rendered(component, 60), /src\/0\.ts/);
    run.emit(view({ agents: [{
      id: "write", agent: "write", status: "running",
      tools: [...tools, { id: "new", tool: "grep", args: { pattern: "Newest" }, status: "running" }],
    }] }));
    const stationary = rendered(component, 60);
    assert.match(stationary, /src\/0\.ts/);
    assert.doesNotMatch(stationary, /grep \/Newest\//);
    assert.match(stationary, /new activity/);
    component.handleInput("t");
    const tail = rendered(component, 60);
    assert.match(tail, /grep \/Newest\//);
    assert.doesNotMatch(tail, /new activity/);
    component.handleInput("g");
    assert.match(rendered(component, 60), /src\/0\.ts/);
  } finally { dispose(); }
});

test("Run control keys exactly follow the status matrix", async () => {
  const cases = [
    ["running", "p", "pause"], ["running", "r", undefined], ["running", "x", "cancel"],
    ["paused", "p", undefined], ["paused", "r", "resume"], ["paused", "x", "cancel"],
    ["failed", "p", undefined], ["failed", "r", "resume"], ["failed", "x", "cancel"],
    ["succeeded", "p", undefined], ["succeeded", "r", undefined], ["succeeded", "x", undefined],
    ["cancelled", "p", undefined], ["cancelled", "r", undefined], ["cancelled", "x", undefined],
  ];
  for (const [status, key, expected] of cases) {
    const run = handle(view({ status }));
    const { component, dispose } = overlay(run.current, { run });
    try {
      component.handleInput(key);
      await nextTurn();
      assert.deepEqual(run.controls, expected ? [expected] : [], `${status} ${key}`);
    } finally { dispose(); }
  }
});

test("Run controls remain available from Process, Board, and Error views", async () => {
  for (const [status, open, key, expected] of [
    ["running", "agent", "p", "pause"],
    ["paused", "board", "r", "resume"],
    ["failed", "error", "r", "resume"],
  ]) {
    const current = view({ status, ...(status === "failed" ? { error: "Generation failed" } : {}) });
    const run = handle(current);
    const { component, dispose } = overlay(current, { run });
    try {
      component.handleInput(open === "agent" ? "tui.select.confirm" : open === "board" ? "\t" : "e");
      component.handleInput(key);
      await nextTurn();
      assert.deepEqual(run.controls, [expected]);
    } finally { dispose(); }
  }
});

test("cancel confirmation is exclusive and can abort without controlling the Run", async () => {
  let confirmations = 0;
  let resolveConfirm;
  const confirm = new Promise((resolve) => { resolveConfirm = resolve; });
  const { component, handle: run, closed, dispose } = overlay(view(), {
    confirmCancel: async () => { confirmations += 1; return await confirm; },
  });
  try {
    component.handleInput("x");
    component.handleInput("x");
    assert.equal(confirmations, 1);
    assert.match(rendered(component), /Confirming cancellation/);
    resolveConfirm(false);
    await nextTurn();
    assert.deepEqual(run.controls, []);
    assert.equal(closed(), false);
  } finally { dispose(); }
});

test("disposing during confirmation prevents the delayed destructive action", async () => {
  let resolveConfirm;
  const confirm = new Promise((resolve) => { resolveConfirm = resolve; });
  const { component, handle: run, dispose } = overlay(view(), { confirmCancel: async () => await confirm });
  component.handleInput("x");
  dispose();
  resolveConfirm(true);
  await nextTurn();
  assert.deepEqual(run.controls, []);
});

test("failed Runs show resumable controls and a scrollable full error", () => {
  const error = `Generation failed\n${"Detailed repository validation error. ".repeat(30)}`;
  const { component, dispose } = overlay(view({ status: "failed", error }));
  try {
    const summary = rendered(component, 60);
    assert.match(summary, /Generation failed.*e details/s);
    assert.match(summary, /r resume.*x cancel/s);
    component.handleInput("e");
    const detail = rendered(component, 60);
    assert.match(detail, /Run error/);
    assert.match(detail, /Detailed repository validation error/);
    assert.match(detail, /\d+–\d+\/\d+/);
    component.handleInput("end");
    assert.match(rendered(component, 60), /repository validation error/);
    component.handleInput("tui.select.cancel");
    assert.match(rendered(component, 60), /\[Agents/);
  } finally { dispose(); }
});

test("control failures remain inspectable as full error details", async () => {
  const current = view({ status: "running" });
  const run = handle(current, { async control() { throw new Error(`Pause failed\n${"lock owner unavailable ".repeat(20)}`); } });
  const { component, dispose } = overlay(current, { run });
  try {
    component.handleInput("p");
    await nextTurn();
    assert.match(rendered(component, 60), /Pause failed.*e details/s);
    component.handleInput("e");
    assert.match(rendered(component, 60), /lock owner unavailable/);
  } finally { dispose(); }
});

test("terminal dimensions keep complete frames without Pi-side clipping", () => {
  const { component, tui, dispose } = overlay();
  try {
    for (const [rows, expected] of [[10, 8], [12, 10], [24, 22], [50, 40]]) {
      tui.terminal.rows = rows;
      const lines = component.render(80);
      assert.equal(lines.length, expected);
      assert.match(plain(lines[0]), /^╭.*╮$/);
      assert.match(plain(lines.at(-1)), /^╰.*╯$/);
    }
  } finally { dispose(); }
});

test("ANSI and Chinese content keep every border aligned in every view", () => {
  const ansi = (text) => `\u001b[36m${text}\u001b[0m`;
  const current = view({
    status: "failed",
    error: "生成失败：" + "引用不完整".repeat(30),
    goal: "生成认证与订单领域文档",
    tasks: [{ id: "write", content: "编写".repeat(80), status: "in_progress", note: "核对引用".repeat(20) }],
    agents: [{
      id: "write",
      agent: "write",
      task: "编写".repeat(40),
      status: "failed",
      tools: [{ id: "1", tool: "read", args: { path: `src/${"目录".repeat(80)}.ts` }, status: "failed" }],
    }],
  });
  const { component, dispose } = overlay(current, {
    theme: { fg(_color, text) { return ansi(text); }, bold(text) { return ansi(text); } },
  });
  try {
    for (const width of [36, 60, 80, 100, 120]) {
      for (const open of [undefined, "\t", "tui.select.confirm", "e"]) {
        if (open) component.handleInput(open);
        const lines = component.render(width);
        assert.ok(lines.some((line) => line.includes("\u001b[")));
        assert.ok(lines.every((line) => visibleWidth(line) === width), `misaligned frame at width ${width}`);
        if (width >= 60) assert.match(plain(lines[0]), /─╮$/);
        if (open === "\t") component.handleInput("\t");
        if (open === "tui.select.confirm" || open === "e") component.handleInput("tui.select.cancel");
      }
    }
  } finally { dispose(); }
});

test("small viewports keep selected agents visible and report list position", () => {
  const agents = Array.from({ length: 18 }, (_, index) => ({
    id: `agent-${index}`,
    agent: `agent-${index}`,
    task: `task ${index}`,
    status: "running",
    tools: [],
  }));
  const { component, tui, dispose } = overlay(view({ agents }));
  tui.terminal.rows = 12;
  try {
    for (let index = 0; index < 14; index += 1) component.handleInput("j");
    const listing = rendered(component, 60);
    assert.match(listing, /> .*agent-14/);
    assert.match(listing, /15\/18/);
    component.handleInput("tui.select.confirm");
    assert.match(rendered(component, 60), /Process.*agent-14/s);
  } finally { dispose(); }
});

test("selected agent context usage is shown in Process detail without a permanent context band", () => {
  const current = view({ agents: [{
    id: "survey-a",
    agent: "survey",
    task: "map backend",
    status: "running",
    usage: { input: 2100, output: 400, total: 2500, turns: 3, toolCalls: 8, contextTokens: 12000, contextWindow: 200000, contextPercent: 6 },
    tools: [{ id: "1", tool: "grep", args: { pattern: "Order" }, status: "running" }],
  }] });
  const { component, dispose } = overlay(current);
  try {
    assert.doesNotMatch(rendered(component, 60), /ctx 12k\/200k/);
    component.handleInput("tui.select.confirm");
    const detail = rendered(component, 60);
    assert.match(detail, /ctx 12k\/200k 6%/);
    assert.match(detail, /3 turns/);
    assert.doesNotMatch(detail, /├.*context/);
  } finally { dispose(); }
});

test("incoming subscriptions request rendering and disposal removes the listener", () => {
  const { component, handle: run, renders, dispose } = overlay();
  component.render(80);
  const before = renders.length;
  run.emit(view({ status: "paused" }));
  assert.ok(renders.length > before);
  assert.match(rendered(component), /paused/);
  dispose();
  const after = renders.length;
  run.emit(view({ status: "running" }));
  assert.equal(renders.length, after);
});

test("widget factory renders live lines and follows box updates", () => {
  const box = { view: view() };
  const tui = { requestRender() {} };
  const widget = wikiWidgetFactory(box)(tui, { fg(_color, text) { return text; } });
  assert.match(widget.render(80).join("\n"), /◆ write · grep \/Order\//);
  box.view = view({ agents: [{ id: "survey", agent: "survey", status: "running", tools: [{ id: "1", tool: "ls", args: { path: "." }, status: "running" }] }] });
  assert.match(widget.render(80).join("\n"), /◆ survey · ls \./);
});
