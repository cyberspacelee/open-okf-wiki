/** One Pi prompt surface. Wiki Runs begin only when the agent calls wiki_produce. */

import { SendIcon, SquareIcon } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { AgentStatus } from "../hooks/useSessionAgent";

export type ComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onAbort: () => void;
  status: AgentStatus;
  disabled?: boolean;
  className?: string;
};

export function Composer({
  input,
  onInputChange,
  onSend,
  onAbort,
  status,
  disabled = false,
  className,
}: ComposerProps) {
  const { t } = useI18n();
  const busy = status === "sending" || status === "streaming";
  const canSend = !disabled && !busy && input.trim().length > 0;

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (canSend) onSend();
    },
    [canSend, onSend],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      event.preventDefault();
      if (canSend) onSend();
    },
    [canSend, onSend],
  );

  return (
    <form
      data-testid="agent-composer"
      onSubmit={submit}
      className={cn(
        "shrink-0 border-t border-border bg-background/95 px-3 py-2.5 md:px-4",
        className,
      )}
    >
      <InputGroup>
        <InputGroupTextarea
          data-testid="agent-composer-input"
          value={input}
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.agentWorkspace.placeholder}
          disabled={disabled || busy}
          rows={2}
          className="min-h-[2.75rem] resize-none text-sm"
        />
        <InputGroupAddon align="block-end" className="justify-between gap-2">
          <div>
            {busy ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="agent-abort"
                onClick={onAbort}
              >
                <SquareIcon data-icon="inline-start" />
                {t.agentWorkspace.stop}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[11px] text-muted-foreground",
                status === "error" && "text-destructive",
                busy && "inline-flex items-center gap-1",
              )}
            >
              {busy ? <Spinner className="size-3" /> : null}
              {busy
                ? t.agentWorkspace.statusBusy
                : status === "error"
                  ? t.agentWorkspace.statusError
                  : t.agentWorkspace.statusReady}
            </span>
            <InputGroupButton
              type="submit"
              size="sm"
              variant="default"
              data-testid="agent-send"
              disabled={!canSend}
            >
              <SendIcon data-icon="inline-start" />
              {t.agentWorkspace.send}
            </InputGroupButton>
          </div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
