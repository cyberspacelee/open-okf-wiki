import { useState } from "react";
import {
  CheckCircle2Icon,
  CircleIcon,
  Maximize2Icon,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

export type { PlanLike };

export type PlanViewerProps = {
  plan: PlanLike;
  /**
   * Paths already written via write_wiki (normalized). Used for page checklist
   * progress on the plan card (Claude Code–style todo / queue).
   */
  writtenPaths?: ReadonlySet<string> | readonly string[];
};

function normalizePath(path: string): string {
  return path.replace(/^\.\/+/, "").replace(/^\/+/, "");
}

/**
 * Structured wiki plan card with page checklist, Markdown body, and fullscreen.
 */
export function PlanViewer({ plan, writtenPaths }: PlanViewerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const markdown = planToMarkdown(plan);

  const written = new Set(
    [...(writtenPaths ?? [])].map((p) => normalizePath(String(p))),
  );
  const writtenCount = plan.pages.filter((p) =>
    written.has(normalizePath(p.path)),
  ).length;

  return (
    <>
      <Plan defaultOpen data-testid="session-plan-card">
        <PlanHeader>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
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
            className="mb-3 space-y-1.5"
            data-testid="session-plan-pages"
          >
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t.planConfirm.pagesLabel}</span>
              <span data-testid="session-plan-pages-count">
                {writtenCount}/{plan.pages.length}
              </span>
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border bg-muted/20 p-2">
              {plan.pages.map((page) => {
                const done = written.has(normalizePath(page.path));
                return (
                  <li
                    key={page.path}
                    className="flex items-start gap-2 text-xs"
                    data-testid={`session-plan-page-${page.path}`}
                    data-status={done ? "written" : "pending"}
                  >
                    {done ? (
                      <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0 text-green-600" />
                    ) : (
                      <CircleIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "font-mono font-medium",
                          done && "text-muted-foreground line-through",
                        )}
                      >
                        {page.path}
                      </div>
                      <div className="text-[11px] text-muted-foreground line-clamp-2">
                        {page.purpose}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
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
