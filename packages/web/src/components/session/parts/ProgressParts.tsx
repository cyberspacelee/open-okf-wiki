/**
 * Progress / workflow / defects / run badge parts on the Session timeline.
 */

import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2Icon,
  CircleIcon,
  LoaderIcon,
  XCircleIcon,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import { PhaseProgress } from "../PhaseProgress";
import {
  SessionCard,
  SessionCardAdvanced,
  SessionCardMono,
} from "../SessionCard";
import { sessionCardMeta } from "../session-card-styles";
import {
  isNoisyWorkflowPart,
  redactUnknown,
  workflowCardStatus,
  workflowErrorFromData,
  workflowProgressLabel,
} from "./message-part-utils";
import { renderPlanFromWorkflow } from "./PlanChrome";

function WorkflowStepCard({
  label,
  data,
  partType,
}: {
  label: string;
  data: unknown;
  partType: string;
}) {
  const { t } = useI18n();
  const status =
    data && typeof data === "object" && "status" in data
      ? String((data as { status?: unknown }).status ?? "")
      : "";
  const err = workflowErrorFromData(data);
  const failed = /fail|error/i.test(status) || Boolean(err);
  const cardStatus = workflowCardStatus(status, failed);
  const Icon =
    cardStatus === "failed"
      ? XCircleIcon
      : cardStatus === "completed"
        ? CheckCircle2Icon
        : cardStatus === "running"
          ? LoaderIcon
          : CircleIcon;

  return (
    <SessionCard
      title={label}
      icon={
        <Icon
          className={
            cardStatus === "running"
              ? "size-4 animate-spin"
              : cardStatus === "failed"
                ? "size-4 text-destructive"
                : cardStatus === "completed"
                  ? "size-4 text-green-600"
                  : "size-4"
          }
        />
      }
      status={cardStatus}
      failed={failed}
      defaultOpen={failed}
      data-testid="session-workflow-progress"
      dataAttrs={{ "part-type": partType, status: status || undefined }}
    >
      {err ? (
        <p className="whitespace-pre-wrap break-words text-xs text-destructive">
          {err}
        </p>
      ) : (
        <p className={sessionCardMeta}>
          {status || partType.replace(/^data-/, "")}
        </p>
      )}
      <SessionCardAdvanced label={t.session.tools.advancedRaw}>
        <SessionCardMono>
          {JSON.stringify(redactUnknown(data), null, 2)}
        </SessionCardMono>
      </SessionCardAdvanced>
    </SessionCard>
  );
}

function DefectsCard({
  data,
}: {
  data: {
    round?: number;
    clean?: boolean;
    defectCount?: number;
    blockingCount?: number;
    summary?: string;
    defects?: Array<{
      severity?: string;
      path?: string;
      issue?: string;
    }>;
  };
}) {
  const { t } = useI18n();
  const clean = Boolean(data.clean);
  const round = data.round ?? 1;
  const blocking = data.blockingCount ?? 0;
  const total = data.defectCount ?? data.defects?.length ?? 0;
  const title = clean
    ? (t.session.tools.reviewClean ?? "Review clean")
    : (t.session.tools.reviewDefects ?? "Review defects")
        .replace("{n}", String(total))
        .replace("{blocking}", String(blocking));
  return (
    <div
      className={`mb-2 rounded-md border px-3 py-2 text-sm ${
        clean
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5"
      }`}
      data-testid="session-defects-card"
      data-clean={clean ? "true" : "false"}
    >
      <p className="font-medium" data-testid="session-defects-title">
        {title}
        <span className={`ml-2 ${sessionCardMeta}`}>
          {(t.session.tools.reviewRound ?? "round {n}").replace(
            "{n}",
            String(round),
          )}
        </span>
      </p>
      {data.summary && !clean ? (
        <p className={`mt-1 ${sessionCardMeta}`}>{data.summary}</p>
      ) : null}
      {!clean && data.defects && data.defects.length > 0 ? (
        <ul
          className="mt-2 list-disc space-y-1 pl-4"
          data-testid="session-defects-list"
        >
          {data.defects.slice(0, 8).map((d, i) => (
            <li key={`${d.path ?? "x"}-${i}`}>
              <span className="font-mono text-xs uppercase opacity-80">
                {d.severity ?? "issue"}
              </span>
              {d.path ? (
                <span className="font-mono text-xs"> `{d.path}`</span>
              ) : null}
              {d.issue ? <span> — {d.issue}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function renderProgressPart(
  key: string,
  part: UIMessage["parts"][number],
  opts: {
    writtenPaths: ReadonlySet<string> | readonly string[];
    hasDataPlan: boolean;
  },
): ReactNode {
  if (part.type === "data-run") {
    const data = "data" in part ? part.data : undefined;
    const runId =
      data && typeof data === "object" && "runId" in data
        ? String((data as { runId?: unknown }).runId ?? "")
        : "";
    const status =
      data && typeof data === "object" && "status" in data
        ? String((data as { status?: unknown }).status ?? "")
        : "";
    if (!runId) {
      return null;
    }
    return (
      <div key={key} className="mb-2" data-testid="session-data-run">
        <Badge variant="outline" className="font-mono text-xs">
          run {runId.slice(0, 8)}…{status ? ` · ${status}` : ""}
        </Badge>
      </div>
    );
  }

  if (part.type === "data-progress") {
    const data = "data" in part ? part.data : undefined;
    if (data && typeof data === "object" && "phase" in data) {
      const d = data as {
        phase?: unknown;
        label?: unknown;
        runId?: unknown;
        failed?: unknown;
      };
      const phase = String(d.phase ?? "");
      if (!phase) {
        return null;
      }
      return (
        <PhaseProgress
          key={key}
          phase={phase}
          label={typeof d.label === "string" ? d.label : undefined}
          runId={typeof d.runId === "string" ? d.runId : undefined}
          failed={Boolean(d.failed)}
        />
      );
    }
    return null;
  }

  if (part.type === "data-sources-index") {
    // Rendered once in message chrome via extractRunTimelineChrome.
    return null;
  }

  if (part.type === "data-defects") {
    const data = "data" in part ? part.data : undefined;
    if (data && typeof data === "object") {
      return (
        <DefectsCard
          key={key}
          data={data as {
            round?: number;
            clean?: boolean;
            defectCount?: number;
            blockingCount?: number;
            summary?: string;
            defects?: Array<{
              severity?: string;
              path?: string;
              issue?: string;
            }>;
          }}
        />
      );
    }
    return null;
  }

  if (
    part.type === "data-workflow" ||
    part.type === "data-workflow-step" ||
    part.type === "data-tool-workflow"
  ) {
    const planNode = renderPlanFromWorkflow(key, part, opts);
    if (planNode !== undefined) {
      return planNode;
    }
    const data = "data" in part ? part.data : undefined;
    if (isNoisyWorkflowPart(data) && !workflowErrorFromData(data)) {
      return null;
    }
    return (
      <WorkflowStepCard
        key={key}
        label={workflowProgressLabel(data, part.type)}
        data={data}
        partType={part.type}
      />
    );
  }

  return undefined;
}
