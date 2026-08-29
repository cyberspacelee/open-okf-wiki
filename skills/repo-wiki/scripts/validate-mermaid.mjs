import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const { default: mermaid } = await import("mermaid");

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const diagrams = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const results = [];

for (const source of diagrams) {
  try {
    const parsed = await mermaid.parse(source);
    results.push({ ok: true, diagramType: parsed.diagramType });
  } catch (error) {
    results.push({ ok: false, error: String(error?.message ?? error).slice(0, 2000) });
  }
}

process.stdout.write(JSON.stringify(results));
