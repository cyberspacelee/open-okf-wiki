/**
 * Agent Workspace composer — mode: Chat | Wiki run (one primary action).
 */

import {
  useCallback,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { PlayIcon, SendIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import type { ModelProfilePublic } from "../../api";
import type { AgentStatus } from "../hooks/useSessionAgent";

export type ComposerMode = "chat" | "wikiRun";

export type ComposerProps = {
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onStartWikiRun: () => void;
  onAbort: () => void;
  status: AgentStatus;
  disabled?: boolean;
  className?: string;
  models?: ModelProfilePublic[];
  wikiModelProfileId?: string;
  onWikiModelProfileIdChange?: (profileId: string) => void;
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
  const [mode, setMode] = useState<ComposerMode>("chat");
  const busy = status === "sending" || status === "streaming";
  const isError = status === "error";
  const canSend = !disabled && !busy && input.trim().length > 0;
  const showModelSelect =
    mode === "wikiRun" && models.length > 0 && onWikiModelProfileIdChange;

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (mode === "chat" && canSend) {
        onSend();
      }
    },
    [mode, canSend, onSend],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (mode === "chat" && canSend) {
          onSend();
        }
      }
    },
    [mode, canSend, onSend],
  );

  return (
    <form
      data-testid="agent-composer"
      data-mode={mode}
      onSubmit={handleSubmit}
      className={cn(
        "shrink-0 border-t border-border bg-background/95 px-3 py-2.5 md:px-4",
        className,
      )}
    >
      <div className="flex flex-col gap-2">
        <div
          className="flex items-center gap-1"
          role="tablist"
          aria-label={t.agentWorkspace.modeChat}
          data-testid="agent-composer-mode"
        >
          <Button
            type="button"
            size="xs"
            variant={mode === "chat" ? "secondary" : "ghost"}
            data-testid="agent-mode-chat"
            disabled={disabled || busy}
            onClick={() => setMode("chat")}
          >
            {t.agentWorkspace.modeChat}
          </Button>
          <Button
            type="button"
            size="xs"
            variant={mode === "wikiRun" ? "secondary" : "ghost"}
            data-testid="agent-mode-wiki"
            disabled={disabled || busy}
            onClick={() => setMode("wikiRun")}
          >
            {t.agentWorkspace.modeWikiRun}
          </Button>
        </div>

        <InputGroup>
          {mode === "chat" ? (
            <InputGroupTextarea
              data-testid="agent-composer-input"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t.agentWorkspace.placeholder}
              disabled={disabled || busy}
              rows={2}
              className="min-h-[2.75rem] resize-none text-sm"
            />
          ) : (
            <div className="flex min-h-[2.75rem] w-full flex-wrap items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
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
                    className="h-8 w-[min(100%,14rem)] text-xs"
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
              ) : (
                <span>{t.agentWorkspace.wikiModelHint}</span>
              )}
            </div>
          )}
          <InputGroupAddon align="block-end" className="justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
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
              <span
                className={cn(
                  "text-[11px] text-muted-foreground",
                  isError && "text-destructive",
                  busy && "inline-flex items-center gap-1",
                )}
              >
                {busy ? <Spinner className="size-3" /> : null}
                {busy
                  ? t.agentWorkspace.statusBusy
                  : isError
                    ? t.agentWorkspace.statusError
                    : t.agentWorkspace.statusReady}
              </span>
              {mode === "chat" ? (
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
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="agent-start-wiki-run"
                  disabled={disabled || busy}
                  onClick={() => onStartWikiRun()}
                >
                  <PlayIcon data-icon="inline-start" />
                  {t.agentWorkspace.startWikiRun}
                </Button>
              )}
            </div>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </form>
  );
}
