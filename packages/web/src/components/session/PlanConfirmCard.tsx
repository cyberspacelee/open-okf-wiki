import type { WikiRunPlan } from "../../api";
import { useI18n } from "../../i18n";
import { Button } from "@/components/ui/button";

export type PlanConfirmCardProps = {
  plan: WikiRunPlan;
  busy?: boolean;
  onApprove: () => void;
  onDeny: () => void;
};

export function PlanConfirmCard({
  plan,
  busy,
  onApprove,
  onDeny,
}: PlanConfirmCardProps) {
  const { t } = useI18n();
  return (
    <div className="session-plan-card" data-testid="session-plan-card">
      <h3 className="panel-subtitle">{t.planConfirm.title}</h3>
      <p className="text-sm">{plan.summary}</p>
      <ul className="session-plan-pages mono small">
        {plan.pages.map((page) => (
          <li key={page.path}>
            <strong>{page.path}</strong> — {page.purpose}
          </li>
        ))}
      </ul>
      {plan.notes ? (
        <p className="muted small">
          {t.planConfirm.notes}: {plan.notes}
        </p>
      ) : null}
      <div className="row-actions mt-2">
        <Button
          type="button"
          onClick={onApprove}
          disabled={busy}
          data-testid="run-approve-plan"
        >
          {busy ? t.planConfirm.working : t.planConfirm.approve}
        </Button>
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
    </div>
  );
}
