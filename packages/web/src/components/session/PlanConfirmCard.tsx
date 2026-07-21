import { useState } from "react";
import type { WikiRunPlan } from "../../api";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PlanViewer } from "./PlanViewer";

export type PlanConfirmCardProps = {
  plan: WikiRunPlan;
  busy?: boolean;
  onApprove: () => void;
  onDeny: () => void;
  /** Free-text revision; when set, shows a third path with feedback form. */
  onRevise?: (feedback: string) => void;
};

export function PlanConfirmCard({
  plan,
  busy,
  onApprove,
  onDeny,
  onRevise,
}: PlanConfirmCardProps) {
  const { t } = useI18n();
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");

  return (
    <div
      className="session-plan-card flex flex-col gap-3"
      data-testid="session-plan-confirm"
    >
      <PlanViewer plan={plan} />
      {revising && onRevise ? (
        <div className="flex flex-col gap-2" data-testid="run-revise-form">
          <p className="text-xs text-muted-foreground">{t.planConfirm.reviseHint}</p>
          <Textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={busy}
            placeholder={t.planConfirm.revisePlaceholder}
            rows={3}
            data-testid="run-revise-feedback"
          />
          <div className="row-actions flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                const text = feedback.trim();
                if (!text || busy) {
                  return;
                }
                onRevise(text);
              }}
              disabled={busy || !feedback.trim()}
              data-testid="run-revise-submit"
            >
              {busy ? t.planConfirm.working : t.planConfirm.reviseSubmit}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setRevising(false);
                setFeedback("");
              }}
              disabled={busy}
              data-testid="run-revise-cancel"
            >
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row-actions mt-2 flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={onApprove}
            disabled={busy}
            data-testid="run-approve-plan"
          >
            {busy ? t.planConfirm.working : t.planConfirm.approve}
          </Button>
          {onRevise ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setRevising(true)}
              disabled={busy}
              data-testid="run-revise-plan"
            >
              {t.planConfirm.revise}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="destructive"
            onClick={onDeny}
            disabled={busy}
            data-testid="run-deny-plan"
          >
            {t.planConfirm.decline}
          </Button>
        </div>
      )}
    </div>
  );
}
