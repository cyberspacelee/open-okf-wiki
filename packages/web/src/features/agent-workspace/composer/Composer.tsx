/**
 * Agent Workspace composer — textarea + send + Start wiki run.
 * No AI SDK PromptInput; plain shadcn Textarea / Button.
 */

import {
  useCallback,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { PlayIcon, SendIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useI18n } from "../../../i18n";
import type { AgentStatus } from "../hooks/useSessionAgent";

export type ComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStartWikiRun: () => void;
  onAbort: () => void;
  status: AgentStatus;
  disabled?: boolean;
  className?: string;
};

export function Composer({
  input,
  onInputChange,
  onSend,
  onStartWikiRun,
  onAbort,
  status,
  disabled = false,
  className,
}: ComposerProps) {
  const { t } = useI18n();
  const busy = status === "sending" || status === "streaming";
  const canSend = !disabled && !busy && input.trim().length > 0;

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (canSend) {
        onSend();
      }
    },
    [canSend, onSend],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (canSend) {
          onSend();
        }
      }
    },
    [canSend, onSend],
  );

  return (
    <form
      data-testid="agent-composer"
      onSubmit={handleSubmit}
      className={cn(
        "shrink-0 border-t border-border bg-background/95 px-3 py-2.5 md:px-4",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        <Textarea
          data-testid="agent-composer-input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.agentWorkspace.placeholder}
          disabled={disabled || busy}
          rows={2}
          className="min-h-[2.75rem] resize-none text-sm"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid="agent-start-wiki-run"
              disabled={disabled || busy}
              onClick={() => onStartWikiRun()}
            >
              <PlayIcon data-icon="inline-start" />
              {t.agentWorkspace.startWikiRun}
            </Button>
            {busy ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="agent-abort"
                onClick={() => onAbort()}
              >
                <SquareIcon data-icon="inline-start" />
                {t.agentWorkspace.stop}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {busy
                ? t.agentWorkspace.statusBusy
                : t.agentWorkspace.statusReady}
            </span>
            <Button
              type="submit"
              size="sm"
              data-testid="agent-send"
              disabled={!canSend}
            >
              <SendIcon data-icon="inline-start" />
              {t.agentWorkspace.send}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}
