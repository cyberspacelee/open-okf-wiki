/**
 * P1 thin UI projection shell (ADR 0027): product open + one framework conversion.
 *
 * Path (minimal fork of @mastra/ai-sdk handleWorkflowStream):
 *   bind abort → createRun → stream|resumeStream (closeOnSuspend: true)
 *     → toAISdkStream({ from: "workflow", includeTextStreamParts, sendReasoning })
 *     → { stream, result }
 *
 * Why not call handleWorkflowStream directly:
 * 1. Session already owns outer createUIMessageStream and strips nested start/finish
 *    (pipeUiStream). handleWorkflowStream wraps another createUIMessageStream.
 * 2. Session finalize needs workflow result() for mapWorkflowResult; the handler
 *    does not expose result().
 * 3. Product cancel requires bindRunAbortSignal before stream (orchestrator).
 *
 * Conversion logic is only toAISdkStream — do not copy or invent a second protocol.
 * Opening/abort bind lives in wiki-run-orchestrator (not stream conversion).
 * This file is the sole toAISdkStream call site for live wiki-run UI/job streams.
 */

import { toAISdkStream } from "@mastra/ai-sdk";
import type { UIMessageChunk } from "ai";
import {
  openWikiRunWorkflow,
  type WikiRunOpenParams,
} from "./wiki-run-orchestrator.js";

export type WikiWorkflowUiHandle = {
  /** Raw AI SDK UIMessageChunk stream (no nested message framing). */
  stream: ReadableStream<UIMessageChunk>;
  /** Settle workflow result and unbind product abort. */
  result: () => Promise<unknown>;
};

/**
 * Open wiki-run as a framework UI chunk stream + result() for Session finalize
 * and Run console job timeline (via uiChunkToJobEvent).
 * Sole Mastra→UI conversion call site for live wiki-run streams.
 */
export async function openWikiRunUiProjection(
  params: WikiRunOpenParams,
): Promise<WikiWorkflowUiHandle> {
  const handle = await openWikiRunWorkflow(params);

  // Same conversion options as handleWorkflowStream internals (@mastra/ai-sdk).
  // Raw chunks — no nested createUIMessageStream (avoids duplicate assistant ids).
  // includeTextStreamParts + sendReasoning: forward nested agent text/tools/reasoning
  // written via step writer (runWikiAgent fullStream pipe) — ADR 0026 / 0027.
  const stream = toAISdkStream(handle.output as never, {
    from: "workflow",
    includeTextStreamParts: true,
    sendReasoning: true,
  }) as unknown as ReadableStream<UIMessageChunk>;

  // Unbind after the workflow result settles (success, suspend, or error).
  // Do not unbind on stream cancel alone — result() may still be awaited.
  const result = () => handle.output.result.finally(handle.release);

  return { stream, result };
}
