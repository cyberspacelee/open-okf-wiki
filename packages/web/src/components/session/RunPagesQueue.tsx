/**
 * Spec pages queue (AI Elements Queue) from data-plan-progress.
 */

import {
  Queue,
  QueueItem,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { FileTextIcon } from "lucide-react";

export type PlanProgressPage = {
  path: string;
  purpose?: string;
  status?: string;
};

export type RunPagesQueueProps = {
  pages: PlanProgressPage[];
};

export function RunPagesQueue({ pages }: RunPagesQueueProps) {
  if (!pages.length) {
    return null;
  }
  const written = pages.filter((p) => p.status === "written");
  const pending = pages.filter((p) => p.status !== "written");

  return (
    <div className="mb-3" data-testid="session-pages-queue">
      <Queue>
        <QueueSection defaultOpen>
          <QueueSectionTrigger>
            <QueueSectionLabel
              count={pages.length}
              label="pages"
              icon={<FileTextIcon className="size-3.5" />}
            />
          </QueueSectionTrigger>
          <QueueSectionContent>
            <QueueList>
              {pending.map((p) => (
                <QueueItem key={`p-${p.path}`} data-testid={`queue-page-${p.path}`}>
                  <div className="flex items-start gap-2">
                    <QueueItemIndicator completed={false} />
                    <QueueItemContent completed={false}>
                      <span className="font-mono text-xs">{p.path}</span>
                      {p.purpose ? (
                        <span className="ml-1 text-muted-foreground">
                          — {p.purpose}
                        </span>
                      ) : null}
                    </QueueItemContent>
                  </div>
                </QueueItem>
              ))}
              {written.map((p) => (
                <QueueItem key={`w-${p.path}`} data-testid={`queue-page-${p.path}`}>
                  <div className="flex items-start gap-2">
                    <QueueItemIndicator completed />
                    <QueueItemContent completed>
                      <span className="font-mono text-xs">{p.path}</span>
                    </QueueItemContent>
                  </div>
                </QueueItem>
              ))}
            </QueueList>
          </QueueSectionContent>
        </QueueSection>
      </Queue>
    </div>
  );
}
