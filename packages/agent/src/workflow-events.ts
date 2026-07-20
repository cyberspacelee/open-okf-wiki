/**
 * Map Mastra workflow stream events → product-facing job log lines.
 * Used by Run console SSE so job timeline stays homologous with the wiki-run workflow.
 */

export type WikiWorkflowJobEvent = {
  type: "log" | "part";
  message: string;
  partType?: string;
  text?: string;
  nodeId?: string;
};

function stepName(payload: Record<string, unknown> | undefined): string {
  if (!payload) {
    return "step";
  }
  const id =
    (typeof payload.id === "string" && payload.id) ||
    (typeof payload.stepId === "string" && payload.stepId) ||
    (typeof payload.stepName === "string" && payload.stepName) ||
    (typeof payload.name === "string" && payload.name) ||
    "";
  return id || "step";
}

/**
 * Best-effort projection of a Mastra WorkflowStreamEvent into a job log event.
 * Unknown shapes become a short log line (never throw).
 */
export function mapWorkflowStreamEvent(event: unknown): WikiWorkflowJobEvent | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const e = event as { type?: string; payload?: Record<string, unknown> };
  const type = e.type ?? "";
  const payload = e.payload;

  if (type === "workflow-start" || type === "start") {
    return { type: "log", message: "wiki workflow running", nodeId: "workflow" };
  }
  if (type === "workflow-step-start") {
    return {
      type: "log",
      message: `workflow step started: ${stepName(payload)}`,
      nodeId: stepName(payload),
    };
  }
  if (type === "workflow-step-result" || type === "workflow-step-finish") {
    const status =
      typeof payload?.status === "string" ? payload.status : "done";
    return {
      type: "log",
      message: `workflow step ${stepName(payload)}: ${status}`,
      nodeId: stepName(payload),
    };
  }
  if (type === "workflow-step-suspended") {
    const gate =
      payload?.suspendPayload &&
      typeof payload.suspendPayload === "object" &&
      "gate" in (payload.suspendPayload as object)
        ? String((payload.suspendPayload as { gate?: string }).gate)
        : "hitl";
    return {
      type: "log",
      message: `workflow suspended (${gate}) at ${stepName(payload)}`,
      nodeId: stepName(payload),
    };
  }
  if (type === "workflow-finish" || type === "finish") {
    return { type: "log", message: "wiki workflow finished", nodeId: "workflow" };
  }
  if (type === "workflow-step-output" && payload) {
    // Skip noisy raw outputs; optional short log
    return null;
  }
  // Ignore other high-volume agent token events inside steps
  if (
    type.includes("text-delta") ||
    type.includes("tool-call") ||
    type.includes("reasoning")
  ) {
    return null;
  }
  if (type) {
    return {
      type: "log",
      message: `workflow: ${type}`,
      nodeId: "workflow",
    };
  }
  return null;
}
