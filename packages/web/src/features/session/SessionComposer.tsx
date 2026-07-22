/**
 * Session composer: suggestions, slash palette, prompt input, stop.
 */

import type { KeyboardEvent } from "react";
import type { ChatStatus } from "ai";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Suggestion,
  Suggestions,
} from "@/components/ai-elements/suggestion";
import { Badge } from "@/components/ui/badge";
import { SlashIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "../../i18n";
import {
  clampSlashHighlight,
  type SessionCommandDef,
} from "../../lib/session-commands";
import type { PendingInteraction } from "../../components/session/decision-types";
import type { OperatorSessionDto } from "../../api";

export type SessionComposerProps = {
  session: OperatorSessionDto;
  input: string;
  onInputChange: (value: string) => void;
  status: ChatStatus | string;
  linkedRunId?: string;
  isBusy: boolean;
  choiceOnly: boolean;
  inputOnly: boolean;
  planReviseMode: boolean;
  canType: boolean;
  hasSources: boolean;
  composerDisabled: boolean;
  pending: PendingInteraction | null;
  suggestionChips: string[];
  slashMenuOpen: boolean;
  slashCommands: SessionCommandDef[];
  slashHighlight: number;
  onSlashHighlight: (index: number) => void;
  onSubmit: (message: PromptInputMessage) => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  onOpenSlash: () => void;
  onApplyCommand: (cmd: SessionCommandDef) => void;
  onSuggestionClick: (value: string) => void;
};

export function SessionComposer({
  session,
  input,
  onInputChange,
  status,
  linkedRunId,
  isBusy,
  choiceOnly,
  inputOnly,
  planReviseMode,
  canType,
  hasSources,
  composerDisabled,
  pending,
  suggestionChips,
  slashMenuOpen,
  slashCommands,
  slashHighlight,
  onSlashHighlight,
  onSubmit,
  onKeyDown,
  onStop,
  onOpenSlash,
  onApplyCommand,
  onSuggestionClick,
}: SessionComposerProps) {
  const { t } = useI18n();
  const chatStatusLabel =
    (t.session.chatStatus as Record<string, string>)[status] ?? status;

  return (
    <div className="shrink-0 border-t bg-card/80 p-3 backdrop-blur-sm supports-backdrop-filter:bg-card/70">
      {(session.status === "running" ||
        session.workflow?.phase === "planning" ||
        session.workflow?.phase === "writing") &&
      !isBusy ? (
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="session-midflight-banner"
        >
          Wiki Run in progress — timeline updates automatically. Use{" "}
          <strong>Stop</strong> to cancel.
        </p>
      ) : null}
      {choiceOnly ? (
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="session-composer-locked"
        >
          {t.session.choiceOnly}
        </p>
      ) : null}
      {planReviseMode && !choiceOnly ? (
        <p
          className="mb-2 text-xs text-muted-foreground"
          data-testid="session-plan-revise-hint"
        >
          {t.session.planReviseHint}
        </p>
      ) : null}
      {inputOnly && pending ? (
        <p className="mb-2 text-xs text-muted-foreground">
          {pending.question}
          {pending.inputPlaceholder
            ? ` — ${pending.inputPlaceholder}`
            : ""}
        </p>
      ) : null}
      {!choiceOnly && suggestionChips.length > 0 ? (
        <Suggestions className="mb-2 px-0.5" data-testid="session-suggestions">
          {suggestionChips.map((s) => (
            <Suggestion
              key={s}
              suggestion={s}
              onClick={(value) => onSuggestionClick(value)}
            />
          ))}
        </Suggestions>
      ) : null}
      <div className="relative">
        {slashMenuOpen ? (
          <div
            className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border bg-popover shadow-md"
            data-testid="session-slash-menu"
          >
            <PromptInputCommand
              shouldFilter={false}
              className="h-auto max-h-56 w-full"
            >
              <PromptInputCommandList className="max-h-56">
                <PromptInputCommandEmpty className="p-3 text-sm text-muted-foreground">
                  {t.session.slashEmpty}
                </PromptInputCommandEmpty>
                <PromptInputCommandGroup heading={t.session.slashHeading}>
                  {slashCommands.map((cmd, index) => {
                    const active =
                      index ===
                      clampSlashHighlight(slashHighlight, slashCommands.length);
                    return (
                      <PromptInputCommandItem
                        key={cmd.id}
                        value={cmd.command}
                        onSelect={() => onApplyCommand(cmd)}
                        data-testid={`session-slash-${cmd.id}`}
                        data-highlighted={active ? "true" : undefined}
                        className={cn(
                          active && "bg-accent text-accent-foreground",
                        )}
                        onMouseEnter={() => onSlashHighlight(index)}
                      >
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium">{cmd.command}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            {cmd.description}
                          </span>
                        </div>
                      </PromptInputCommandItem>
                    );
                  })}
                </PromptInputCommandGroup>
              </PromptInputCommandList>
            </PromptInputCommand>
          </div>
        ) : null}
        <PromptInput
          onSubmit={onSubmit}
          className="w-full [&_[data-slot=input-group]]:shadow-xs"
          data-testid="session-prompt"
        >
          <PromptInputBody>
            <PromptInputTextarea
              value={input}
              onChange={(e) => onInputChange(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              disabled={composerDisabled || !canType}
              placeholder={
                !hasSources
                  ? t.session.placeholderNoSources
                  : choiceOnly
                    ? t.session.placeholderChoice
                    : planReviseMode
                      ? (pending?.inputPlaceholder ??
                        t.session.placeholderPlanRevise)
                      : (pending?.inputPlaceholder ??
                        t.session.placeholderDefault)
              }
              data-testid="session-input"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <Badge
                variant="secondary"
                data-testid="session-chat-status"
                data-status={status}
                className="font-normal"
              >
                {chatStatusLabel}
              </Badge>
              {linkedRunId ? (
                <Badge
                  variant="outline"
                  data-testid="session-chat-run-id"
                  className="font-normal"
                >
                  {linkedRunId.slice(0, 8)}…
                </Badge>
              ) : null}
              <PromptInputButton
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={choiceOnly || isBusy}
                tooltip={t.session.slashTooltip}
                onClick={onOpenSlash}
                data-testid="session-slash-open"
              >
                <SlashIcon data-icon="inline-start" aria-hidden />
              </PromptInputButton>
            </PromptInputTools>
            <PromptInputSubmit
              status={isBusy ? "streaming" : "ready"}
              disabled={
                isBusy ||
                choiceOnly ||
                !canType ||
                !input.trim() ||
                (!hasSources && !input.trim().startsWith("/"))
              }
              data-testid="session-send"
              onStop={onStop}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
