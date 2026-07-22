/**
 * Session conversation timeline (messages + empty state).
 */

import type { UIMessage } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
} from "@/components/ai-elements/message";
import { MessageParts } from "../../components/session/MessageParts";
import { useI18n } from "../../i18n";
import { MessageSquareIcon } from "lucide-react";
import type { OperatorSessionDto } from "../../api";

export type SessionTimelineProps = {
  messages: UIMessage[];
  session: OperatorSessionDto;
  sessionWrittenPaths: ReadonlySet<string> | readonly string[];
  latestAssistantId: string | null;
  suppressDecisions: boolean;
  onChoice: (optionId: string) => void;
};

export function SessionTimeline({
  messages,
  session,
  sessionWrittenPaths,
  latestAssistantId,
  suppressDecisions,
  onChoice,
}: SessionTimelineProps) {
  const { t } = useI18n();

  return (
    <Conversation
      className="min-h-0 flex-1"
      data-testid="session-conversation"
    >
      <ConversationContent className="gap-4 p-4">
        {messages.length === 0 ? (
          <ConversationEmptyState
            icon={<MessageSquareIcon className="size-10" />}
            title={t.session.emptyTitle}
            description={t.session.emptyDescription}
          />
        ) : (
          messages.map((message) => (
            <Message from={message.role} key={message.id}>
              <MessageContent>
                <MessageParts
                  message={message}
                  writtenPaths={sessionWrittenPaths}
                  isLatestAssistant={
                    message.id === latestAssistantId &&
                    !suppressDecisions &&
                    // Hide chips while write/plan is in flight (eager gate-exit).
                    session.workflow?.phase !== "planning" &&
                    session.workflow?.phase !== "writing"
                  }
                  onChoice={onChoice}
                />
              </MessageContent>
            </Message>
          ))
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
