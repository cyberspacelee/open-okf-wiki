import type { WikiRunPlan } from "../../api";
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
  return (
    <div className="session-plan-card" data-testid="session-plan-card">
      <h3 className="panel-subtitle">Proposed page plan</h3>
      <p className="text-sm">{plan.summary}</p>
      <ul className="session-plan-pages mono small">
        {plan.pages.map((page) => (
          <li key={page.path}>
            <strong>{page.path}</strong> — {page.purpose}
          </li>
        ))}
      </ul>
      {plan.notes ? <p className="muted small">Notes: {plan.notes}</p> : null}
      <div className="row-actions mt-2">
        <Button
          type="button"
          onClick={onApprove}
          disabled={busy}
          data-testid="run-approve-plan"
        >
          {busy ? "Working…" : "Approve plan & write"}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={onDeny}
          disabled={busy}
          data-testid="run-deny-plan"
        >
          Decline plan
        </Button>
      </div>
    </div>
  );
}
