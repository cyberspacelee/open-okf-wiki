import { useState } from "react";
import { Maximize2Icon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  Plan,
  PlanAction,
  PlanContent,
  PlanDescription,
  PlanHeader,
  PlanTitle,
  PlanTrigger,
} from "@/components/ai-elements/plan";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "../../i18n";
import { planToMarkdown, type PlanLike } from "./plan-markdown";

export type { PlanLike };

export type PlanViewerProps = {
  plan: PlanLike;
};

/**
 * Structured wiki plan card with Markdown body and a fullscreen reader.
 * Prefer this over raw list markup so long plans remain readable in Session.
 */
export function PlanViewer({ plan }: PlanViewerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const markdown = planToMarkdown(plan);

  return (
    <>
      <Plan defaultOpen data-testid="session-plan-card">
        <PlanHeader>
          <div className="min-w-0 flex-1 space-y-1">
            <PlanTitle>{t.planConfirm.title}</PlanTitle>
            <PlanDescription className="line-clamp-2">
              {plan.summary}
            </PlanDescription>
          </div>
          <PlanAction className="flex items-center gap-1">
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              onClick={() => setOpen(true)}
              data-testid="session-plan-fullscreen"
              title={t.planConfirm.fullscreen}
              aria-label={t.planConfirm.fullscreen}
            >
              <Maximize2Icon className="size-4" />
            </Button>
            <PlanTrigger />
          </PlanAction>
        </PlanHeader>
        <PlanContent>
          <div
            className="max-h-80 overflow-y-auto pr-1"
            data-testid="session-plan-markdown"
          >
            <MessageResponse className="size-full [&>*:first-child]:mt-0">
              {markdown}
            </MessageResponse>
          </div>
        </PlanContent>
      </Plan>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="flex h-[min(92vh,900px)] w-[min(96vw,56rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
          data-testid="session-plan-fullscreen-dialog"
        >
          <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <DialogTitle>{t.planConfirm.title}</DialogTitle>
            <DialogDescription className="line-clamp-2">
              {plan.summary}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <MessageResponse className="size-full [&>*:first-child]:mt-0">
              {markdown}
            </MessageResponse>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
