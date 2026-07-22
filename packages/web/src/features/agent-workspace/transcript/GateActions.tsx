/**
 * HITL controls for product plan / publication gates (ADR 0030).
 * Sends resume_gate; does not invent free-text approve inference.
 */

import { useCallback, useState } from "react";
import { CheckIcon, PencilIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useI18n } from "../../../i18n";
import type { PendingGate, ResumeGateInput } from "../hooks/useSessionAgent";

export type GateActionsProps = {
  pending: PendingGate;
  busy?: boolean;
  disabled?: boolean;
  onResume: (input: ResumeGateInput) => void | Promise<void>;
  className?: string;
  /** Compact layout for transcript cards. */
  compact?: boolean;
};

export function GateActions({
  pending,
  busy = false,
  disabled = false,
  onResume,
  className,
  compact = false,
}: GateActionsProps) {
  const { t } = useI18n();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const locked = busy || disabled;
  const isPlan = pending.gate === "plan";
  const pageCount =
    pending.plan?.pages?.length ?? pending.pages?.length ?? 0;

  const run = useCallback(
    async (action: ResumeGateInput["action"], fb?: string) => {
      await onResume({
        gate: pending.gate,
        action,
        ...(fb?.trim() ? { feedback: fb.trim() } : {}),
        runId: pending.runId,
      });
      setRevising(false);
      setFeedback("");
    },
    [onResume, pending],
  );

  return (
    <div
      data-testid="agent-gate-actions"
      data-gate={pending.gate}
      className={cn("flex flex-col gap-2", className)}
    >
      {pending.question ? (
        <p className={cn("text-xs", compact && "opacity-90")}>
          {pending.question}
        </p>
      ) : null}

      {isPlan && pending.plan?.pages && pending.plan.pages.length > 0 ? (
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded border border-border/60 bg-background/50 p-1.5 font-mono text-[11px]">
          {pending.plan.pages.map((page) => (
            <li key={page.path} className="truncate px-1 py-0.5">
              {page.path}
            </li>
          ))}
        </ul>
      ) : null}

      {!isPlan && pending.pages && pending.pages.length > 0 ? (
        <ul className="flex max-h-32 flex-col gap-0.5 overflow-y-auto rounded border border-border/60 bg-background/50 p-1.5 font-mono text-[11px]">
          {pending.pages.map((p) => (
            <li key={p} className="truncate px-1 py-0.5">
              {p}
            </li>
          ))}
        </ul>
      ) : null}

      {revising && isPlan ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted-foreground">
            {t.planConfirm.reviseHint}
          </p>
          <Textarea
            data-testid="agent-gate-revise-input"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder={t.planConfirm.revisePlaceholder}
            disabled={locked}
            rows={2}
            className="min-h-[2.5rem] resize-none text-xs"
          />
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              size="sm"
              data-testid="agent-gate-revise-submit"
              disabled={locked || !feedback.trim()}
              onClick={() => void run("revise", feedback)}
            >
              {busy ? t.planConfirm.working : t.planConfirm.reviseSubmit}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                setRevising(false);
                setFeedback("");
              }}
            >
              {t.errorBanner.dismiss}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <Button
            type="button"
            size="sm"
            data-testid="agent-gate-approve"
            disabled={locked}
            onClick={() => void run("approve")}
          >
            <CheckIcon data-icon="inline-start" />
            {busy
              ? t.planConfirm.working
              : isPlan
                ? t.planConfirm.chipWrite.replace("{n}", String(pageCount || "?"))
                : t.planConfirm.chipPublish}
          </Button>
          {isPlan ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="agent-gate-revise"
              disabled={locked}
              onClick={() => setRevising(true)}
            >
              <PencilIcon data-icon="inline-start" />
              {t.planConfirm.chipRevise}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="agent-gate-deny"
            disabled={locked}
            onClick={() => void run("deny")}
          >
            <XIcon data-icon="inline-start" />
            {isPlan
              ? t.planConfirm.chipDeny
              : t.planConfirm.chipKeepStaging}
          </Button>
        </div>
      )}
    </div>
  );
}
