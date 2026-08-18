import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { openWikiStatusOverlay } from "../dist/ui/status-overlay.js";

const lead = {
  target: { kind: "lead" }, role: "lead", status: "running", attempt: 1, activity: "synthesizing",
  health: "healthy",
  activeTools: [{ id: "r1", name: "read", startedAt: "2026-08-12T00:00:00Z" }],
  lastActivityAt: "2026-08-12T00:00:01Z", lastHeartbeatAt: "2026-08-12T00:00:02Z",
  usage: { turns: 8, contextPercent: 24 },
};
const view = {
  id: "run-1", cwd: "/repo", status: "running",
  createdAt: "2026-08-12T00:00:00Z", updatedAt: "2026-08-12T00:00:03Z",
  progress: { stage: "lead", language: "en", lead, currentBatch: { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: "write-auth", role: "write", status: "running" }] } },
};

function inspection(target = { kind: "lead" }, summary = "current") {
  return { runId: view.id, agent: target.kind === "lead" ? { ...lead, summary } : { ...lead, target, role: "write", summary }, process: [] };
}

function handle(overrides = {}) {
  return {
    async view() { return view; },
    async inspectAgent(target) { return inspection(target); },
    async *updates(_after, signal) { if (signal) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true })); },
    ...overrides,
  };
}

async function componentFor(runHandle = handle(), rows = 24, initialTarget, theme = { fg: (_color, text) => text }, overlay = {}) {
  let component;
  let options;
  await openWikiStatusOverlay({
    initialTarget,
    ui: { async custom(factory, received) { options = received; component = await factory({ requestRender() {}, terminal: { rows } }, theme, { matches: (data, binding) => ({ "\u001b[A": "tui.select.up", "\u001b[B": "tui.select.down", CONFIRM: "tui.select.confirm", PAGE_DOWN: "tui.select.pageDown", PAGE_UP: "tui.select.pageUp" })[data] === binding }, () => {}); } },
    handle: runHandle,
    ...overlay,
  });
  return { component, options };
}

function recordingTheme(capabilities = "full") {
  const calls = [];
  const wrap = (method) => (tokenOrText, maybeText) => {
    const token = maybeText === undefined ? undefined : tokenOrText;
    const value = maybeText === undefined ? tokenOrText : maybeText;
    calls.push({ method, token, text: String(value) });
    return `\u001b[1m${String(value)}\u001b[0m`;
  };
  const theme = capabilities === "none" ? undefined : { fg: wrap("fg") };
  if (capabilities === "full") Object.assign(theme, { bg: wrap("bg"), bold: wrap("bold") });
  return { theme, calls };
}

function plain(value) {
  return value.replaceAll(/\u001b\[[0-9;]*m/g, "");
}

function dividerCoordinates(lines) {
  return lines.flatMap((line, row) => {
    const text = plain(line);
    const index = text.indexOf(" │ ");
    return index < 0 ? [] : [{ row, column: visibleWidth(text.slice(0, index)) + 1 }];
  });
}

function callFor(calls, token, pattern) {
  return calls.some((call) => call.token === token && pattern.test(call.text));
}

function wikiOverlayMaxHeight(rows) {
  return Math.max(1, Math.min(Math.floor(rows * 0.88), rows - 2));
}

function navigationColumn(lines, width) {
  const text = lines.map((line) => plain(line));
  if (width < 100) return text.join("\n");
  return text.map((line) => {
    const index = line.indexOf(" │ ");
    return index >= 0 ? line.slice(0, index) : line;
  }).join("\n");
}

function withLeadProcess(process) {
  return { ...view, progress: { ...view.progress, lead: { ...lead, process } } };
}

test("process tab lists activity from the top, oldest then newest", async () => {
  const process = [
    { sequence: 1, at: "2026-08-12T00:00:00.000Z", kind: "tool", severity: "info", message: "", toolName: "read", summary: "src/a.ts", completed: true },
    { sequence: 2, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "", toolName: "grep", summary: "TODO  src", completed: true },
  ];
  const { component } = await componentFor(handle({
    async view() { return withLeadProcess(process); },
  }), 24, { kind: "lead" }, { fg: (_color, text) => text }, { process: true });
  const rendered = component.render(80).map((line) => plain(line));
  const tabsRow = rendered.findIndex((line) => /\[Process\]/.test(line));
  const firstRow = rendered.findIndex((line) => /read/.test(line) && /src\/a\.ts/.test(line));
  const secondRow = rendered.findIndex((line) => /grep/.test(line) && /TODO/.test(line));
  const contextRule = rendered.findIndex((line) => /context/.test(line) && /─/.test(line));
  assert.ok(tabsRow >= 0, "expected process tabs");
  assert.ok(firstRow > tabsRow, "expected the first process row below the tabs");
  assert.ok(secondRow > firstRow, "expected later process rows below earlier ones");
  assert.ok(firstRow - tabsRow <= 3, `process should start at the top, gap=${firstRow - tabsRow}`);
  assert.ok(contextRule - secondRow >= 3, `expected empty space below the process rows, gap=${contextRule - secondRow}`);
  component.dispose();
});

test("process tab starts at the oldest row and t jumps to the newest", async () => {
  const process = Array.from({ length: 40 }, (_, index) => ({
    sequence: index,
    at: "2026-08-12T00:00:00.000Z",
    kind: "tool",
    severity: "info",
    message: "",
    toolName: `tool-${index}`,
    summary: `file-${index}.ts`,
    completed: true,
  }));
  const { component } = await componentFor(handle({
    async view() { return withLeadProcess(process); },
  }), 16, { kind: "lead" }, { fg: (_color, text) => text }, { process: true });
  await new Promise((resolve) => setImmediate(resolve));
  const top = plain(component.render(80).join("\n"));
  assert.match(top, /tool-0/);
  assert.doesNotMatch(top, /tool-39/);
  component.handleInput("t");
  assert.match(plain(component.render(80).join("\n")), /tool-39/);
  component.handleInput("\u001b[A");
  const stepped = plain(component.render(80).join("\n"));
  assert.doesNotMatch(stepped, /tool-39/);
  assert.match(stepped, /tool-3[0-8]/);
  component.dispose();
});

test("left and right arrows enter, switch pages, and exit without tab", async () => {
  const { component } = await componentFor();
  component.handleInput("\u001b[C");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(plain(component.render(80).join("\n")), /\[Overview\]/);
  component.handleInput("\u001b[C");
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);
  component.handleInput("\u001b[C");
  assert.match(plain(component.render(80).join("\n")), /\[Output\]/);
  component.handleInput("\u001b[D");
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);
  component.handleInput("\u001b[D");
  assert.match(plain(component.render(80).join("\n")), /\[Overview\]/);
  component.handleInput("\u001b[D");
  const runPage = plain(component.render(80).join("\n"));
  assert.match(runPage, /Leader/);
  assert.doesNotMatch(runPage, /\[Overview\]/);
  component.dispose();
});


test("terminal row changes invalidate same-width frame geometry", async () => {
  const terminal = { rows: 24 };
  let component;
  const terminalView = { ...view, status: "succeeded", completedAt: "2026-08-12T00:00:04Z" };
  await openWikiStatusOverlay({
    ui: {
      async custom(factory) {
        component = await factory(
          { requestRender() {}, terminal },
          { fg: (_color, text) => text },
          { matches: (data, binding) => data === "CONFIRM" && binding === "tui.select.confirm" },
          () => {},
        );
      },
    },
    handle: handle({ async view() { return terminalView; } }),
  });

  const assertCompleteFrame = (rendered, rows) => {
    assert.equal(rendered.length, wikiOverlayMaxHeight(rows));
    assert.match(plain(rendered.join("\n")), /context/);
    assert.match(plain(rendered.at(-1)), /select.*open.*esc/i);
    assert.match(plain(rendered.at(-1)), /^╰.*╯$/);
  };
  assertCompleteFrame(component.render(80), 24);
  terminal.rows = 12;
  assertCompleteFrame(component.render(80), 12);
  terminal.rows = 30;
  assertCompleteFrame(component.render(80), 30);
  component.dispose();
});

test("workbench switches at 100 columns, fixes the divider, and never overflows", async () => {
  const { component } = await componentFor();
  for (const width of [44, 80, 99]) {
    const rendered = component.render(width);
    assert.ok(rendered.length <= wikiOverlayMaxHeight(24));
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.match(rendered.join("\n"), /◆ Lead/);
    assert.deepEqual(dividerCoordinates(rendered), []);
  }
  let expectedColumn;
  for (const width of [100, 120, 160]) {
    const rendered = component.render(width);
    assert.ok(rendered.length <= wikiOverlayMaxHeight(24));
    assert.ok(rendered.every((line) => visibleWidth(line) <= width));
    assert.match(plain(rendered.join("\n")), /Leader.*Overview/s);
    const coordinates = dividerCoordinates(rendered);
    assert.ok(coordinates.length >= 5, `expected a full-height divider at width ${width}`);
    assert.equal(new Set(coordinates.map(({ column }) => column)).size, 1);
    expectedColumn ??= coordinates[0].column;
    assert.equal(coordinates[0].column, expectedColumn);
  }
  component.dispose();
});

test("loading, loaded inspection, context, and health keep the frame geometry stable", async () => {
  let resolveInspection;
  const pending = new Promise((resolve) => { resolveInspection = resolve; });
  const subject = handle({ async inspectAgent() { return await pending; } });
  const { component } = await componentFor(subject);
  const loading = component.render(120);
  resolveInspection(inspection());
  await new Promise((resolve) => setImmediate(resolve));
  const loaded = component.render(120);
  assert.equal(loaded.length, loading.length);
  assert.deepEqual(dividerCoordinates(loaded), dividerCoordinates(loading));
  component.dispose();

  for (const agent of [{ ...lead, usage: undefined }, { ...lead, health: "degraded" }]) {
    const variant = await componentFor(handle({
      async view() { return { ...view, progress: { ...view.progress, lead: agent } }; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = variant.component.render(120);
    assert.equal(rendered.length, loading.length);
    assert.deepEqual(dividerCoordinates(rendered), dividerCoordinates(loading));
    variant.component.dispose();
  }
});

test("theme records semantic status, navigation, chrome, and context threshold tokens", async () => {
  const mixedBatch = { ...view.progress.currentBatch, total: 4, tasks: [
    { id: "running", role: "write", status: "running" },
    { id: "waiting", role: "review", status: "queued" },
    { id: "partial", role: "write", status: "incomplete" },
    { id: "failed", role: "review", status: "failed" },
  ] };
  const semanticView = {
    ...view,
    progress: {
      ...view.progress,
      batches: [{ batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "done", role: "review", status: "complete" }] }, mixedBatch],
      currentBatch: mixedBatch,
    },
  };
  const { theme, calls } = recordingTheme();
  const { component } = await componentFor(handle({ async view() { return semanticView; } }), 24, undefined, theme);
  component.render(120);
  assert.ok(callFor(calls, "accent", /Lead|Leader|running/));
  assert.ok(callFor(calls, "success", /✓|complete/));
  assert.ok(callFor(calls, "warning", /◐|incomplete|partial/));
  assert.ok(callFor(calls, "error", /✗|failed/));
  assert.ok(callFor(calls, "dim", /○|queued|attempt|\d+s/));
  assert.ok(callFor(calls, "muted", /Batch|context|turn|select|esc/i));
  assert.ok(callFor(calls, "border", /[╭╮╰╯│]/));
  assert.ok(callFor(calls, "borderMuted", /[├┤─]/));
  assert.ok(callFor(calls, "selectedBg", />.*Leader/));
  assert.ok(calls.some((call) => call.method === "bold"));
  component.dispose();

  for (const [contextPercent, expected] of [[70, undefined], [71, "warning"], [91, "error"]]) {
    const recorded = recordingTheme();
    const agent = { ...lead, usage: { turns: 8, contextPercent } };
    const variant = await componentFor(handle({
      async view() { return { ...view, progress: { ...view.progress, lead: agent } }; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, { kind: "lead" }, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    variant.component.render(80);
    const percentCalls = recorded.calls.filter((call) => call.text.includes(`${contextPercent}%`));
    assert.ok(percentCalls.length > 0, `expected ${contextPercent}% to be themed`);
    if (expected) assert.ok(percentCalls.some((call) => call.token === expected));
    else assert.ok(percentCalls.every((call) => !["warning", "error"].includes(call.token)));
    variant.component.dispose();
  }
});

test("footers expose only actions available on the current page", async () => {
  const { component } = await componentFor();
  const runPage = plain(component.render(80).join("\n"));
  assert.doesNotMatch(runPage, /\bActivity\b/);
  const runFooter = plain(component.render(80).at(-1));
  assert.match(runFooter, /select.*open.*close.*pause.*cancel.*esc/i);
  assert.doesNotMatch(runFooter, /tab|older|tail/i);

  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  const agentFooter = plain(component.render(80).at(-1));
  assert.match(agentFooter, /scroll.*pages.*tail/i);
  assert.doesNotMatch(agentFooter, /select|pause|cancel|older|tab/i);
  component.dispose();
});

test("long task ids and Chinese content remain within every rendered width", async () => {
  const longId = `身份认证-${"很长".repeat(80)}`;
  const localized = {
    ...view,
    progress: {
      ...view.progress,
      language: "zh",
      currentBatch: { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: longId, role: "write", status: "running" }] },
    },
  };
  const { theme } = recordingTheme();
  const { component } = await componentFor(handle({ async view() { return localized; } }), 24, undefined, theme);
  component.handleInput("CONFIRM");
  await new Promise((resolve) => setImmediate(resolve));
  const zhFooter = plain(component.render(80).at(-1));
  assert.match(zhFooter, /跟随/);
  assert.doesNotMatch(zhFooter, /追尾|主理/);
  component.handleInput("\u001b[D");
  for (const width of [36, 44, 80, 100, 120, 160]) {
    const rendered = component.render(width);
    assert.ok(rendered.some((line) => line.includes("\u001b[")), `expected ANSI styling at width ${width}`);
    assert.ok(rendered.every((line) => visibleWidth(line) <= width), `overflow at width ${width}`);
  }
  component.dispose();
});

test("small viewports keep the selected target visible and Enter opens that target", async () => {
  const tasks = Array.from({ length: 18 }, (_, index) => ({ id: `task-${index + 1}`, role: index % 2 ? "review" : "write", status: "running" }));
  const batches = [
    { batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "hidden", role: "review", status: "complete" }] },
    { batch: 2, status: "partial", completed: 0, total: 6, tasks: tasks.slice(0, 6) },
    { batch: 3, status: "failed", completed: 0, total: 6, tasks: tasks.slice(6, 12) },
    { batch: 4, status: "running", completed: 0, total: 6, tasks: tasks.slice(12) },
  ];
  const crowded = { ...view, progress: { ...view.progress, currentBatch: batches[3], batches } };

  for (const width of [80, 120]) {
    const inspected = [];
    const subject = handle({
      async view() { return crowded; },
      async inspectAgent(target) { inspected.push(target); return inspection(target); },
    });
    const { component } = await componentFor(subject, 12);
    await new Promise((resolve) => setImmediate(resolve));
    let hops = 0;
    while (!/> .*\btask-13\b/.test(plain(navigationColumn(component.render(width), width))) && hops < 40) {
      component.handleInput("j");
      hops += 1;
      await new Promise((resolve) => setImmediate(resolve));
      const rendered = plain(component.render(width).join("\n"));
      assert.equal((rendered.match(/> /g) ?? []).length, 1, `selection disappeared at width ${width} after hop ${hops}`);
    }
    assert.match(navigationColumn(component.render(width), width), /> .*\btask-13\b/);
    component.handleInput("CONFIRM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inspected.length, 0);
    assert.match(plain(component.render(width).join("\n")), /\[Overview\]/);
    component.handleInput("\u001b[D");
    component.handleInput("PAGE_DOWN");
    await new Promise((resolve) => setImmediate(resolve));
    const paged = plain(component.render(width).join("\n"));
    assert.equal((paged.match(/> /g) ?? []).length, 1);
    assert.match(paged, /> /);
    component.dispose();
  }
});

test("control keys only act on the run page and for legal run states", async () => {
  async function controlledComponent(status, initialTarget) {
    const calls = [];
    const runView = { ...view, status };
    const result = await componentFor(handle({ async view() { return runView; } }), 24, initialTarget, undefined, { onControl: async (action) => { calls.push(action); } });
    return { ...result, calls };
  }

  const invalidContexts = [
    await controlledComponent("running", { kind: "lead" }),
    await controlledComponent("running"),
    await controlledComponent("succeeded"),
  ];
  invalidContexts[1].component.handleInput("j");
  invalidContexts[1].component.handleInput("j");
  invalidContexts[1].component.handleInput("j");
  invalidContexts[1].component.handleInput("CONFIRM");
  for (const variant of invalidContexts) {
    for (const input of ["p", "r", "x"]) variant.component.handleInput(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(variant.calls, []);
    variant.component.dispose();
  }

  for (const [status, input, expected] of [["running", "p", "pause"], ["running", "x", "cancel"], ["paused", "r", "resume"], ["paused", "x", "cancel"]]) {
    const variant = await controlledComponent(status);
    variant.component.handleInput(input);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(variant.calls, [expected]);
    variant.component.dispose();
  }
});

test("process tab shows running tools without assistant text and output wraps markdown instead of truncating", async () => {
  const long = `alpha-${"word".repeat(80)}`;
  const markdown = `# Coverage\n\n- auth flow\n- token refresh\n\n\`${long}\``;
  const inspected = [];
  const process = [
    { sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info", message: "", toolName: "read", summary: "src/a.ts", completed: false },
    { sequence: 2, at: "2026-08-12T00:00:02.000Z", kind: "tool", severity: "info", message: "", toolName: "grep", summary: "TODO  src", completed: true },
  ];
  const { component } = await componentFor(handle({
    async view() { return withLeadProcess(process); },
    async inspectAgent(target, options) {
      inspected.push({ target, options });
      return {
        ...inspection(target),
        process,
        messages: [
          { at: "2026-08-12T00:00:01.000Z", text: "I will inspect the source first." },
        ],
        handoff: markdown,
      };
    },
  }), 24, { kind: "lead" });
  await new Promise((resolve) => setImmediate(resolve));
  component.handleInput("\u001b[C");
  const processPage = plain(component.render(80).join("\n"));
  assert.equal(inspected.length, 0);
  assert.match(processPage, /◆ read/);
  assert.match(processPage, /✓ grep/);
  assert.doesNotMatch(processPage, /◆ model/);
  assert.doesNotMatch(processPage, /I will inspect the source first/);
  component.handleInput("\u001b[C");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(inspected, [{ target: { kind: "lead" }, options: { transcript: true, handoff: true } }]);
  const outputPage = component.render(48);
  const outputText = plain(outputPage.join("\n"));
  assert.match(outputText, /Coverage/);
  assert.match(outputText, /auth flow/);
  assert.ok(outputPage.every((line) => visibleWidth(line) <= 48));
  assert.ok(outputPage.filter((line) => /alpha-|word/.test(plain(line))).length >= 2);
  component.dispose();
});

test("process tab keeps an earlier batch task after later batches fill recent activity", async () => {
  const older = {
    sequence: 1, at: "2026-08-12T00:00:01.000Z", kind: "tool", severity: "info",
    message: "", toolName: "read", summary: "wiki/auth.md", completed: true,
    target: { kind: "task", batch: 1, taskId: "old" },
  };
  const recentActivity = Array.from({ length: 20 }, (_, index) => ({
    sequence: 80 + index, at: "2026-08-12T01:00:00.000Z", kind: "tool", severity: "info",
    message: "", toolName: "read", summary: `lead-${index}.md`, completed: true,
    target: { kind: "lead" },
  }));
  const history = {
    batch: 1, status: "complete", completed: 1, total: 1,
    tasks: [{ id: "old", role: "review", status: "complete", summary: "reviewed auth", process: [older] }],
  };
  const current = { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: "current", role: "write", status: "running" }] };
  const crowded = {
    ...view,
    progress: { ...view.progress, currentBatch: current, batches: [history, current], recentActivity },
  };
  const { component } = await componentFor(handle({ async view() { return crowded; } }));
  await new Promise((resolve) => setImmediate(resolve));
  component.handleInput("j");
  component.handleInput("CONFIRM");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  component.handleInput("\u001b[C");
  const processPage = plain(component.render(80).join("\n"));
  assert.match(processPage, /\[Process\]/);
  assert.match(processPage, /wiki\/auth\.md/);
  assert.doesNotMatch(processPage, /lead-19\.md/);
  assert.doesNotMatch(processPage, /暂无过程记录|no process tail/);
  component.dispose();
});

test("leader and batch outcome symbols use their semantic theme roles", async () => {
  for (const [status, icon, token] of [["complete", "✓", "success"], ["incomplete", "◐", "warning"], ["failed", "✗", "error"]]) {
    const recorded = recordingTheme();
    const resultView = {
      ...view,
      progress: {
        stage: "prepare",
        language: "en",
        lead: { ...lead, status },
        batches: [
          { batch: 1, status: "complete", completed: 1, total: 1, tasks: [] },
          { batch: 2, status: "partial", completed: 1, total: 2, tasks: [] },
          { batch: 3, status: "failed", completed: 0, total: 1, tasks: [] },
        ],
      },
    };
    const { component } = await componentFor(handle({ async view() { return resultView; } }), 24, undefined, recorded.theme);
    const rendered = plain(component.render(120).join("\n"));
    assert.match(rendered, new RegExp(`${icon} Leader`));
    assert.match(rendered, /✓ Batch 1/);
    assert.match(rendered, /◐ Batch 2/);
    assert.match(rendered, /✗ Batch 3/);
    assert.ok(callFor(recorded.calls, token, new RegExp(`^${icon}$`)));
    assert.ok(callFor(recorded.calls, "success", /^✓$/));
    assert.ok(callFor(recorded.calls, "warning", /^◐$/));
    assert.ok(callFor(recorded.calls, "error", /^✗$/));
    component.dispose();
  }
});

test("completed, failed, and cancelled agents keep navigation and inspector semantics aligned", async () => {
  for (const { status, icon, token } of [
    { status: "complete", icon: "✓", token: "success" },
    { status: "failed", icon: "✗", token: "error" },
    { status: "cancelled", icon: "○", token: "muted" },
  ]) {
    const recorded = recordingTheme();
    const agent = {
      ...lead,
      status,
      activity: "settled",
      activeTools: [],
      summary: `${status} summary`,
    };
    const resultView = {
      ...view,
      status: "succeeded",
      completedAt: "2026-08-12T00:00:04Z",
      progress: { stage: "prepare", language: "en", lead: agent },
    };
    const { component } = await componentFor(handle({
      async view() { return resultView; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, undefined, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = plain(component.render(120).join("\n"));

    assert.match(rendered, new RegExp(`${icon} Leader\\s+settled`), `${status} navigation icon`);
    assert.match(rendered, new RegExp(`${icon} ${status} · settled`), `${status} inspector live icon`);
    assert.ok(recorded.calls.filter((call) => call.token === token && call.text === icon).length >= 2, `${status} navigation and live icon must both use ${token}`);
    if (status !== "failed") assert.ok(!callFor(recorded.calls, "accent", /^◆$/), `${status} must not render a running live icon`);
    if (status === "cancelled") {
      assert.match(rendered, /lead\s+cancelled/i);
      assert.ok(recorded.calls.every((call) => call.token !== "error"), "cancelled is muted, not failed");
    }
    component.dispose();
  }
});

test("degraded health does not replace terminal status semantics", async () => {
  for (const { status, icon, token } of [
    { status: "complete", icon: "✓", token: "success" },
    { status: "failed", icon: "✗", token: "error" },
    { status: "cancelled", icon: "○", token: "muted" },
  ]) {
    const recorded = recordingTheme();
    const agent = { ...lead, status, health: "degraded", activity: "settled", activeTools: [] };
    const resultView = {
      ...view,
      status: "succeeded",
      completedAt: "2026-08-12T00:00:04Z",
      progress: { stage: "prepare", language: "en", lead: agent },
    };
    const { component } = await componentFor(handle({
      async view() { return resultView; },
      async inspectAgent() { return { ...inspection(), agent }; },
    }), 24, undefined, recorded.theme);
    await new Promise((resolve) => setImmediate(resolve));
    const rendered = plain(component.render(120).join("\n"));

    assert.match(rendered, new RegExp(`${icon} Leader\\s+settled`));
    assert.match(rendered, new RegExp(`${icon} ${status} · settled`));
    assert.match(rendered, /warning  observability degraded/);
    assert.ok(recorded.calls.filter((call) => call.token === token && call.text === icon).length >= 2);
    assert.ok(callFor(recorded.calls, "warning", /observability degraded/));
    component.dispose();
  }
});

test("retrying stays warning in navigation, live status, and inspector under selected background", async () => {
  const recorded = recordingTheme();
  const agent = {
    ...lead,
    status: "retrying",
    activity: "retry_wait",
    activeTools: [],
    summary: "retry scheduled",
  };
  const retryingView = {
    ...view,
    status: "succeeded",
    completedAt: "2026-08-12T00:00:04Z",
    progress: { stage: "prepare", language: "en", lead: agent },
  };
  const { component } = await componentFor(handle({
    async view() { return retryingView; },
    async inspectAgent() { return { ...inspection(), agent }; },
  }), 24, undefined, recorded.theme);
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = plain(component.render(120).join("\n"));

  assert.match(rendered, /◐ Leader\s+retry wait/);
  assert.match(rendered, /◐ retrying · retry wait/);
  assert.match(rendered, /lead\s+retrying\s+·\s+retry wait/i);
  assert.ok(recorded.calls.filter((call) => call.method === "fg" && call.token === "warning" && call.text === "◐").length >= 2);
  assert.ok(recorded.calls.filter((call) => call.method === "fg" && call.token === "warning" && call.text === "retrying").length >= 2);
  assert.ok(recorded.calls.every((call) => !(["◐", "retrying"].includes(call.text) && ["muted", "accent"].includes(call.token))));
  assert.ok(recorded.calls.some((call) => call.method === "bg" && call.token === "selectedBg" && plain(call.text).includes("◐ Leader")));
  component.dispose();
});

test("stale agent inspection cannot replace the selected agent", async () => {
  const pending = new Map();
  const deferred = (target) => new Promise((resolve) => pending.set(JSON.stringify(target), resolve));
  const subject = handle({ async inspectAgent(target) { return await deferred(target); } });
  const { component } = await componentFor(subject);
  component.handleInput("CONFIRM");
  component.handleInput("\u001b[C");
  component.handleInput("\u001b[C");
  await flush();
  component.handleInput("\u001b[D");
  component.handleInput("\u001b[D");
  component.handleInput("\u001b[D");
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  component.handleInput("\u001b[C");
  component.handleInput("\u001b[C");
  await flush();
  pending.get(JSON.stringify({ kind: "task", batch: 2, taskId: "write-auth" }))(inspection({ kind: "task", batch: 2, taskId: "write-auth" }, "new"));
  await flush();
  pending.get(JSON.stringify({ kind: "lead" }))(inspection({ kind: "lead" }, "stale"));
  await flush();
  assert.match(component.render(80).join("\n"), /new/);
  assert.doesNotMatch(component.render(80).join("\n"), /stale/);
  component.dispose();
});

test("switching targets clears old inspection while the new request is pending", async () => {
  const pending = new Map();
  const subject = handle({
    async inspectAgent(target) { return await new Promise((resolve) => pending.set(JSON.stringify(target), resolve)); },
  });
  const { component } = await componentFor(subject);
  component.handleInput("CONFIRM");
  component.handleInput("\u001b[C");
  component.handleInput("\u001b[C");
  await flush();
  const oldLeader = inspection({ kind: "lead" }, "old leader summary");
  pending.get(JSON.stringify({ kind: "lead" }))(oldLeader);
  await flush();
  const oldRendered = component.render(120).join("\n");
  assert.match(oldRendered, /old leader summary/);

  component.handleInput("\u001b[D");
  component.handleInput("\u001b[D");
  component.handleInput("\u001b[D");
  component.handleInput("j");
  component.handleInput("j");
  component.handleInput("CONFIRM");
  component.handleInput("\u001b[C");
  component.handleInput("\u001b[C");
  await flush();
  const pendingWide = component.render(120).join("\n");
  assert.doesNotMatch(pendingWide, /old leader summary/);
  const pendingNarrow = component.render(80).join("\n");
  assert.doesNotMatch(pendingNarrow, /old leader summary/);
  component.dispose();
});

test("cancel uses confirmation and does not fire when rejected", async () => {
  let controlled = 0;
  let component;
  await openWikiStatusOverlay({
    ui: { async custom(factory) { component = await factory({ requestRender() {}, terminal: { rows: 20 } }, { fg: (_color, text) => text }, { matches: () => false }, () => {}); } },
    handle: handle(), confirmCancel: async () => false, onControl: async () => { controlled += 1; },
  });
  component.handleInput("x");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controlled, 0);
  component.dispose();
});

test("selected agent reads health directly and ordinary warnings do not degrade it", async () => {
  const warnings = Array.from({ length: 25 }, (_, index) => ({ sequence: index + 1, at: "2026-08-12T00:00:01Z", kind: "warning", severity: "warning", target: { kind: "lead" }, message: `ordinary warning ${index}` }));
  let currentLead = { ...lead, health: "degraded" };
  const subject = handle({
    async view() { return { ...view, progress: { ...view.progress, lead: currentLead, recentActivity: warnings } }; },
    async inspectAgent() { return { ...inspection({ kind: "lead" }, "current"), agent: currentLead }; },
  });
  const { component } = await componentFor(subject, 24, { kind: "lead" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(component.render(80).join("\n"), /warning  observability degraded/);
  component.dispose();
  currentLead = { ...lead, health: "healthy" };
  const recovered = await componentFor(subject, 24, { kind: "lead" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(recovered.component.render(80).join("\n"), /observability degraded/);
  recovered.component.dispose();
});

test("prepare stage always selects a leader navigation target before inspection exists", async () => {
  const preparing = { ...view, progress: { stage: "prepare", language: "en" } };
  const { component } = await componentFor(handle({ async view() { return preparing; }, async inspectAgent() { return undefined; } }));
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = component.render(120).join("\n");
  assert.match(rendered, /> ◆ Leader  starting/);
  assert.match(rendered, /Leader starting\. Agent details are not available\./);
  component.dispose();
});

test("completed batches stay collapsed until expanded and then inspect their tasks", async () => {
  const history = { batch: 1, status: "complete", completed: 1, total: 1, tasks: [{ id: "old", role: "review", status: "complete", summary: "reviewed auth" }] };
  const current = { batch: 2, status: "running", completed: 0, total: 1, tasks: [{ id: "current", role: "write", status: "running" }] };
  const withHistory = { ...view, progress: { ...view.progress, currentBatch: current, batches: [history, current] } };
  for (const width of [80, 120]) {
    const inspected = [];
    const subject = handle({
      async view() { return withHistory; },
      async inspectAgent(target, options) { inspected.push({ target, options }); return inspection(target); },
    });
    const { component } = await componentFor(subject);
    await new Promise((resolve) => setImmediate(resolve));
    component.handleInput("j");
    await new Promise((resolve) => setImmediate(resolve));
    const collapsedLines = component.render(width);
    const collapsed = plain(collapsedLines.join("\n"));
    const nav = navigationColumn(collapsedLines, width);
    assert.equal((collapsed.match(/> /g) ?? []).length, 1);
    assert.match(nav, /> ✓ Batch 1/);
    assert.doesNotMatch(nav, /review  old/);
    if (width >= 100) assert.match(collapsed, /reviewed auth/);
    component.handleInput("CONFIRM");
    await new Promise((resolve) => setImmediate(resolve));
    const expanded = plain(component.render(width).join("\n"));
    assert.match(expanded, /review  old/);
    component.handleInput("j");
    component.handleInput("CONFIRM");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inspected.length, 0);
    component.handleInput("\u001b[C");
    component.handleInput("\u001b[C");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(inspected.at(-1), { target: { kind: "task", batch: 1, taskId: "old" }, options: { transcript: true, handoff: true } });
    component.dispose();
  }
});

test("navigation and batch inspector show a cluster label from the task id", async () => {
  const clustered = {
    ...view,
    progress: {
      ...view.progress,
      currentBatch: {
        batch: 2, status: "running", completed: 0, total: 2,
        tasks: [
          { id: "wiki/api/core/runtime/concept.md", role: "write", status: "running" },
          { id: "wiki/api/core/runtime/flows.md", role: "review", status: "queued" },
        ],
      },
    },
  };
  const { component } = await componentFor(handle({ async view() { return clustered; } }));
  await new Promise((resolve) => setImmediate(resolve));
  const nav = plain(component.render(80).join("\n"));
  assert.match(nav, /write  api\/core\/runtime  wiki\/api\/core\/runtime\/concept\.md/);
  assert.match(nav, /review  api\/core\/runtime  wiki\/api\/core\/runtime\/flows\.md/);
  component.handleInput("j");
  await new Promise((resolve) => setImmediate(resolve));
  const inspector = plain(component.render(120).join("\n"));
  assert.match(inspector, /write  api\/core\/runtime  wiki\/api\/core\/runtime\/concept\.md/);
  component.dispose();
});

test("missing custom UI returns without reading the handle", async () => {
  await openWikiStatusOverlay({ ui: {}, handle: handle({ async view() { throw new Error("must not run"); } }) });
});

test("overlay ignores stale updates and renders the terminal transaction view", async () => {
  const stale = { ...view, status: "failed" };
  const terminal = { ...view, status: "succeeded", completedAt: "2026-08-12T00:00:04Z" };
  const subject = handle({
    async *updates() {
      yield { event: { version: 1, runId: view.id, sequence: 1, at: view.updatedAt, type: "failed", message: "stale" }, view: stale };
      yield { event: { version: 1, runId: view.id, sequence: 3, at: terminal.completedAt, type: "completed", message: "published" }, view: terminal };
    },
  });
  const { component } = await componentFor(subject);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = plain(component.render(80).join("\n"));
  assert.match(rendered, /wiki run-1  succeeded/);
  assert.doesNotMatch(rendered, /wiki run-1  failed/);
  component.dispose();
});

function pushableUpdates() {
  const queued = [];
  let wake;
  const subscribe = async function* (_after, signal) {
    try {
      while (!signal?.aborted) {
        if (queued.length === 0) {
          await new Promise((resolve) => {
            wake = resolve;
            signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        while (queued.length > 0 && !signal?.aborted) yield queued.shift();
      }
    } finally {
      wake = undefined;
    }
  };
  return {
    subscribe,
    push(nextView) {
      queued.push({
        event: { version: 1, runId: nextView.id, at: nextView.updatedAt, type: "stage", stage: "lead", message: "tick" },
        view: nextView,
      });
      const notify = wake;
      wake = undefined;
      notify?.();
    },
  };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("opening, navigation, and overview updates never inspect", async () => {
  const inspected = [];
  const stream = pushableUpdates();
  const subject = handle({
    async inspectAgent(target, options) {
      inspected.push({ target, options });
      return inspection(target);
    },
    updates: stream.subscribe,
  });
  const { component } = await componentFor(subject);
  await flush();
  assert.deepEqual(inspected, []);

  component.handleInput("j");
  component.handleInput("j");
  await flush();
  assert.equal(inspected.length, 0);

  component.handleInput("k");
  component.handleInput("k");
  component.handleInput("CONFIRM");
  await flush();
  assert.equal(inspected.length, 0);
  assert.match(plain(component.render(80).join("\n")), /\[Overview\]/);

  component.handleInput("\u001b[C");
  await flush();
  assert.equal(inspected.length, 0);
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);
  assert.match(plain(component.render(80).join("\n")), /no process tail/);

  stream.push({
    ...view,
    updatedAt: "2026-08-12T00:00:04Z",
    progress: { ...view.progress, lead: { ...lead, activity: "streaming", activeTools: [] } },
  });
  await flush();
  assert.equal(inspected.length, 0);
  assert.match(plain(component.render(80).join("\n")), /streaming/);
  component.dispose();
});

test("output tab inspects with transcript and reloads only when output identity changes", async () => {
  const inspected = [];
  const stream = pushableUpdates();
  const subject = handle({
    async inspectAgent(target, options) {
      inspected.push({ target, options });
      return inspection(target, `output-${inspected.length}`);
    },
    updates: stream.subscribe,
  });
  const { component } = await componentFor(subject, 24, { kind: "lead" });
  await flush();
  assert.deepEqual(inspected, []);

  component.handleInput("\u001b[C");
  await flush();
  assert.equal(inspected.length, 0);
  assert.match(plain(component.render(80).join("\n")), /\[Process\]/);

  component.handleInput("\u001b[C");
  await flush();
  assert.deepEqual(inspected, [{ target: { kind: "lead" }, options: { transcript: true, handoff: true } }]);
  assert.match(plain(component.render(80).join("\n")), /output-1/);

  stream.push({
    ...view,
    updatedAt: "2026-08-12T00:00:04Z",
    progress: { ...view.progress, lead: { ...lead, activity: "streaming", activeTools: [] } },
  });
  await flush();
  assert.equal(inspected.length, 1);
  assert.match(plain(component.render(80).join("\n")), /streaming/);

  stream.push({
    ...view,
    updatedAt: "2026-08-12T00:00:05Z",
    progress: {
      ...view.progress,
      lead: { ...lead, activity: "streaming", updatedAt: "2026-08-12T00:00:05Z", summary: "fresh handoff" },
    },
  });
  await flush();
  assert.equal(inspected.length, 2);
  assert.deepEqual(inspected.at(-1), { target: { kind: "lead" }, options: { transcript: true, handoff: true } });
  component.dispose();
});
