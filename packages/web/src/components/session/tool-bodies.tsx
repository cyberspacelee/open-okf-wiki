/**
 * Tool body renderers (product semantics). Used by the tool body registry.
 */

import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { FileIcon, FolderIcon } from "lucide-react";
import {
  languageFromPath,
  pathFromToolInput,
} from "./tool-summary";
import { unwrapToolPayload } from "./session-tool-utils";
import { sessionCardCode, sessionCardMeta } from "./session-card-styles";
import { SessionCardAdvanced, SessionCardMono } from "./SessionCard";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type ToolBodyProps = {
  toolName: string;
  input: unknown;
  output: unknown;
  errorText?: string;
};

function contentMeta(
  output: unknown,
  input: unknown,
): { chars?: number; truncated?: boolean; preview?: string } {
  if (isRecord(output)) {
    return {
      chars:
        typeof output.contentChars === "number"
          ? output.contentChars
          : typeof output.content === "string"
            ? output.content.length
            : undefined,
      truncated: Boolean(output.truncated),
      preview:
        typeof output.content === "string" ? output.content : undefined,
    };
  }
  if (isRecord(input)) {
    return {
      chars:
        typeof input.contentChars === "number"
          ? input.contentChars
          : typeof input.content === "string"
            ? input.content.length
            : typeof input.contentPreview === "string"
              ? input.contentPreview.length
              : undefined,
      truncated: Boolean(input.truncated),
      preview:
        typeof input.contentPreview === "string"
          ? input.contentPreview
          : typeof input.content === "string"
            ? input.content
            : undefined,
    };
  }
  return {};
}

function normalizeEntries(
  entries: unknown[],
): Array<{ name: string; path: string; type: string }> {
  return entries.map((e, i) => {
    if (typeof e === "string") {
      const path = e.replace(/\/$/, "");
      const name = path.split("/").pop() || path || String(i);
      const isDir = e.endsWith("/") || !name.includes(".");
      return {
        name,
        path,
        type:
          isDir && (e.endsWith("/") || name === "src") ? "directory" : "file",
      };
    }
    if (isRecord(e)) {
      const path = String(e.path ?? e.name ?? i);
      const name = String(e.name ?? path.split("/").pop() ?? path);
      return { name, path, type: String(e.type ?? "file") };
    }
    return { name: String(i), path: String(i), type: "file" };
  });
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="whitespace-pre-wrap break-words text-xs text-destructive">
      {text}
    </p>
  );
}

export function ListEntriesBody({ output }: { output: unknown }) {
  const body = unwrapToolPayload(output);
  if (!isRecord(body) || !Array.isArray(body.entries)) {
    return (
      <p className={sessionCardMeta} data-testid="session-tool-list-empty">
        No directory entries
      </p>
    );
  }
  const entries = normalizeEntries(body.entries);
  const truncated = Boolean(body.truncated);
  const total =
    typeof body.entryCount === "number" ? body.entryCount : entries.length;
  const sourceId =
    typeof body.sourceId === "string" ? body.sourceId : undefined;

  return (
    <div className="min-w-0 max-w-full space-y-2" data-testid="session-tool-list-body">
      {sourceId ? (
        <p className={`truncate ${sessionCardMeta}`}>
          source: <span className="font-mono">{sourceId}</span>
        </p>
      ) : null}
      <ul className="max-h-48 min-w-0 overflow-y-auto rounded-md border bg-muted/30 text-xs">
        {entries.map((e, i) => {
          const Icon = e.type === "directory" ? FolderIcon : FileIcon;
          return (
            <li
              key={`${e.path}-${i}`}
              className="flex min-w-0 items-center gap-2 border-b border-border/40 px-2 py-1.5 font-mono text-xs last:border-0"
            >
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate" title={e.path}>
                {e.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {e.type}
              </span>
            </li>
          );
        })}
      </ul>
      <p className={sessionCardMeta}>
        {truncated
          ? `Showing ${entries.length} of ${total} entries`
          : `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`}
      </p>
    </div>
  );
}

export function ReadBody({
  toolName,
  path,
  output,
  input,
}: {
  toolName: string;
  path: string;
  output: unknown;
  input: unknown;
}) {
  const body = unwrapToolPayload(output);
  const meta = contentMeta(body, input);
  const text = meta.preview ?? "";
  if (!text) {
    return (
      <div className="space-y-1" data-testid="session-tool-read-empty">
        <p className={`truncate font-mono ${sessionCardMeta}`}>{path}</p>
        <p className={sessionCardMeta}>No content preview</p>
      </div>
    );
  }
  const isMd =
    toolName === "read_wiki" ||
    path.endsWith(".md") ||
    path.endsWith(".mdx");

  return (
    <div className="min-w-0 max-w-full space-y-2" data-testid="session-tool-read-body">
      {meta.truncated ? (
        <p className={sessionCardMeta}>
          Preview truncated
          {meta.chars !== undefined ? ` (${meta.chars} chars total)` : ""}
        </p>
      ) : null}
      {isMd ? (
        <div className="max-h-64 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/20 p-3">
          <MessageResponse className="size-full max-w-full break-words text-xs [&>*:first-child]:mt-0">
            {text}
          </MessageResponse>
        </div>
      ) : (
        <div className="max-h-64 min-w-0 max-w-full overflow-hidden rounded-md bg-muted/50">
          <CodeBlock
            code={text}
            language={languageFromPath(path) as BundledLanguage}
            className={sessionCardCode}
          />
        </div>
      )}
    </div>
  );
}

export function WriteBody({
  path,
  input,
  output,
  errorText,
}: {
  path: string;
  input: unknown;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return <ErrorLine text={errorText} />;
  }
  const out = unwrapToolPayload(output);
  const meta = contentMeta(undefined, input);
  const text = meta.preview ?? "";
  const bytes =
    isRecord(out) && typeof out.bytes === "number" ? out.bytes : undefined;

  return (
    <div className="min-w-0 max-w-full space-y-2" data-testid="session-tool-write-body">
      <div className="flex min-w-0 flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 max-w-full truncate font-mono" title={path}>
          {path}
        </span>
        {bytes !== undefined ? <span>{bytes} bytes written</span> : null}
        {isRecord(out) && out.written === true ? <span>written</span> : null}
        {meta.chars !== undefined ? (
          <span>
            {meta.chars} chars
            {meta.truncated ? " (preview)" : ""}
          </span>
        ) : null}
      </div>
      {text ? (
        <div className="max-h-80 min-w-0 overflow-y-auto overflow-x-hidden rounded-md border bg-muted/20 p-3">
          <MessageResponse className="size-full max-w-full break-words text-xs [&>*:first-child]:mt-0">
            {text}
          </MessageResponse>
        </div>
      ) : (
        <p className={sessionCardMeta}>No content preview</p>
      )}
    </div>
  );
}

export function CodeModeBody({
  input,
  output,
  errorText,
}: {
  input: unknown;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return <ErrorLine text={errorText} />;
  }
  const preview =
    isRecord(input) && typeof input.codePreview === "string"
      ? input.codePreview
      : isRecord(input) && typeof input.code === "string"
        ? String(input.code).slice(0, 800)
        : undefined;
  const outPreview =
    typeof output === "string"
      ? output.slice(0, 800)
      : isRecord(output) && typeof output.preview === "string"
        ? output.preview
        : isRecord(output) && typeof output.result === "string"
          ? String(output.result).slice(0, 800)
          : undefined;

  return (
    <div
      className="min-w-0 max-w-full space-y-2"
      data-testid="session-tool-codemode-body"
    >
      <p className={sessionCardMeta}>
        Orchestration script (CodeMode) — host tools still enforce path policy.
      </p>
      {preview ? (
        <div className="max-h-40 min-w-0 overflow-hidden rounded-md bg-muted/50">
          <CodeBlock
            code={preview}
            language={"typescript" as BundledLanguage}
            className={sessionCardCode}
          />
        </div>
      ) : null}
      {outPreview ? (
        <div className="max-h-32 min-w-0 overflow-auto rounded-md border bg-muted/30 p-3">
          <SessionCardMono>{outPreview}</SessionCardMono>
        </div>
      ) : (
        <p className={sessionCardMeta}>Script completed</p>
      )}
    </div>
  );
}

export function GenericBody({
  toolName,
  input,
  output,
  errorText,
}: ToolBodyProps) {
  if (errorText) {
    return <ErrorLine text={errorText} />;
  }

  const inObj = isRecord(input) ? input : undefined;
  const unwrapped = unwrapToolPayload(output);
  const outObj = isRecord(unwrapped) ? unwrapped : undefined;

  const path =
    (inObj && typeof inObj.path === "string" && inObj.path) ||
    (outObj && typeof outObj.path === "string" && outObj.path) ||
    undefined;

  if (outObj && Array.isArray(outObj.entries)) {
    return <ListEntriesBody output={outObj} />;
  }
  if (
    (outObj && typeof outObj.content === "string") ||
    (inObj && typeof inObj.contentPreview === "string")
  ) {
    return (
      <ReadBody
        toolName={toolName}
        path={path ?? "."}
        output={outObj ?? output}
        input={input}
      />
    );
  }

  const summaryBits: string[] = [];
  if (path) {
    summaryBits.push(path);
  }
  if (outObj && typeof outObj.bytes === "number") {
    summaryBits.push(`${outObj.bytes} B`);
  }
  if (outObj && Array.isArray(outObj.entries)) {
    summaryBits.push(`${outObj.entries.length} entries`);
  }

  return (
    <div
      className="min-w-0 max-w-full space-y-2"
      data-testid="session-tool-generic-body"
    >
      {summaryBits.length > 0 ? (
        <p className={`truncate font-mono ${sessionCardMeta}`}>
          {summaryBits.join(" · ")}
        </p>
      ) : (
        <p className={sessionCardMeta}>{toolName}</p>
      )}
      {inObj && Object.keys(inObj).length > 0 ? (
        <SessionCardAdvanced label="Parameters">
          <ToolInput input={inObj} />
        </SessionCardAdvanced>
      ) : null}
      {output !== undefined ? (
        <SessionCardAdvanced label="Result">
          <ToolOutput
            output={unwrapToolPayload(output)}
            errorText={undefined}
          />
        </SessionCardAdvanced>
      ) : null}
    </div>
  );
}

/** Registry: toolName → body. Unknown names use GenericBody. */
export type ToolBodyRenderer = (props: ToolBodyProps) => ReactNode;

export const TOOL_BODY_REGISTRY: Record<string, ToolBodyRenderer> = {
  list_source: ({ output }) => <ListEntriesBody output={output} />,
  list_skill: ({ output }) => <ListEntriesBody output={output} />,
  list_wiki: ({ output }) => <ListEntriesBody output={output} />,
  read_source: ({ toolName, input, output }) => (
    <ReadBody
      toolName={toolName}
      path={pathFromToolInput(input)}
      output={output}
      input={input}
    />
  ),
  read_skill: ({ toolName, input, output }) => (
    <ReadBody
      toolName={toolName}
      path={pathFromToolInput(input)}
      output={output}
      input={input}
    />
  ),
  read_wiki: ({ toolName, input, output }) => (
    <ReadBody
      toolName={toolName}
      path={pathFromToolInput(input)}
      output={output}
      input={input}
    />
  ),
  write_wiki: ({ input, output, errorText }) => (
    <WriteBody
      path={pathFromToolInput(input)}
      input={input}
      output={output}
      errorText={errorText}
    />
  ),
  execute_typescript: ({ input, output, errorText }) => (
    <CodeModeBody input={input} output={output} errorText={errorText} />
  ),
  code_mode: ({ input, output, errorText }) => (
    <CodeModeBody input={input} output={output} errorText={errorText} />
  ),
};

export function renderToolBody(props: ToolBodyProps): ReactNode {
  if (props.errorText) {
    return <ErrorLine text={props.errorText} />;
  }
  const name = props.toolName.replace(/^tool-/, "");
  const out = unwrapToolPayload(props.output);
  const renderer = TOOL_BODY_REGISTRY[name] ?? GenericBody;
  return renderer({
    toolName: name,
    input: props.input,
    output: out,
    errorText: props.errorText,
  });
}
