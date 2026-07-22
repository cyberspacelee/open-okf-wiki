/**
 * Sources panel from Host data-sources-index (repo:path citations).
 */

import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import { BookIcon } from "lucide-react";

export type SourceIndexEntry = {
  path: string;
  sourceId?: string;
  lines?: string;
  agentId?: string;
};

export type RunSourcesPanelProps = {
  sources: SourceIndexEntry[];
};

export function RunSourcesPanel({ sources }: RunSourcesPanelProps) {
  if (!sources.length) {
    return null;
  }
  // Dedupe by path
  const seen = new Set<string>();
  const unique = sources.filter((s) => {
    const k = `${s.sourceId ?? ""}:${s.path}`;
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });

  return (
    <div className="mb-3" data-testid="session-sources-panel">
      <Sources defaultOpen={false}>
        <SourcesTrigger count={unique.length} />
        <SourcesContent>
          {unique.slice(0, 30).map((s) => {
            const title = s.sourceId
              ? `${s.sourceId}/${s.path}`
              : s.path;
            const href = s.lines
              ? `#source-${encodeURIComponent(s.path)}-${s.lines}`
              : `#source-${encodeURIComponent(s.path)}`;
            return (
              <Source
                key={`${s.sourceId ?? ""}-${s.path}-${s.lines ?? ""}`}
                href={href}
                title={title}
                onClick={(e) => {
                  // Local index only — no external navigation.
                  e.preventDefault();
                }}
                className="cursor-default text-muted-foreground hover:text-foreground"
              >
                <BookIcon className="h-4 w-4 shrink-0" />
                <span className="block font-mono text-xs font-medium">
                  {title}
                  {s.lines ? (
                    <span className="text-muted-foreground"> {s.lines}</span>
                  ) : null}
                </span>
              </Source>
            );
          })}
        </SourcesContent>
      </Sources>
    </div>
  );
}
