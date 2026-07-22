/**
 * Agent Workspace composer — textarea + send + Start wiki run.
 * Optional model picker for multi-model wiki generation.
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useI18n } from "../../../i18n";
import type { ModelProfilePublic } from "../../../api";
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
  /** Settings catalog models for wiki-run selection. */
  models?: ModelProfilePublic[];
  /** Selected model profile id for the next wiki run. */
  wikiModelProfileId?: string;
  onWikiModelProfileIdChange?: (profileId: string) => void;
  /** Workspace default profile (shown in labels). */
  defaultModelProfileId?: string;
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
  models = [],
  wikiModelProfileId = "",
  onWikiModelProfileIdChange,
  defaultModelProfileId,
}: ComposerProps) {
  const { t } = useI18n();
  const busy = status === "sending" || status === "streaming";
  const canSend = !disabled && !busy && input.trim().length > 0;
  const showModelSelect = models.length > 0 && onWikiModelProfileIdChange;

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
            {showModelSelect ? (
              <Select
                value={wikiModelProfileId || null}
                onValueChange={(next) => {
                  if (typeof next === "string") {
                    onWikiModelProfileIdChange(next);
                  }
                }}
                items={models.map((m) => ({
                  value: m.id,
                  label: m.name,
                }))}
                disabled={disabled || busy}
              >
                <SelectTrigger
                  className="h-8 w-[min(100%,12rem)] text-xs"
                  data-testid="agent-wiki-model-select"
                  aria-label={t.agentWorkspace.wikiModel}
                >
                  <SelectValue placeholder={t.agentWorkspace.wikiModel} />
                </SelectTrigger>
                <SelectContent>
                  {models.map((m) => {
                    const isDefault = defaultModelProfileId === m.id;
                    return (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                        {isDefault ? ` ${t.modelSelect.defaultSuffix}` : ""}
                        {" · "}
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {m.modelId}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            ) : null}
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
