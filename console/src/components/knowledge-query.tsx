import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  CloudUploadIcon,
  MessageCircleQuestionIcon,
  SendIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent, BubbleGroup } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { BundleKind } from "@/lib/knowledge"
import {
  askAcceptedKnowledge,
  type KnowledgeQueryAnswer,
  type QueryError,
  type QueryScope,
  type QuerySegment,
} from "@/lib/query"

type Turn = {
  id: string
  question: string
  answer?: KnowledgeQueryAnswer
  error?: QueryError
}

export function KnowledgeQuery({
  token,
  bundle,
  runId,
  sourceSetDigest,
  page,
  conceptId,
}: {
  token: string
  bundle: BundleKind
  runId: string
  sourceSetDigest: string
  page: string | null
  conceptId: string | null
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<QueryScope>(page ? "concept" : "bundle")
  const [question, setQuestion] = useState("")
  const [turns, setTurns] = useState<Turn[]>([])
  const [pending, setPending] = useState(false)
  const controller = useRef<AbortController | null>(null)

  useEffect(() => {
    controller.current?.abort()
    controller.current = null
    setTurns([])
    setQuestion("")
    setPending(false)
    setScope(page ? "concept" : "bundle")
  }, [bundle, conceptId, page, runId, sourceSetDigest])

  useEffect(() => () => controller.current?.abort(), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = question.trim()
    if (!text || pending || (scope === "concept" && !page)) return
    const id = crypto.randomUUID()
    const next = new AbortController()
    controller.current = next
    setQuestion("")
    setPending(true)
    setTurns((current) => [...current, { id, question: text }])
    try {
      const base = {
        question: text,
        bundle,
        run_id: runId,
        source_set_digest: sourceSetDigest,
      }
      const answer = await askAcceptedKnowledge(
        token,
        scope === "concept"
          ? { ...base, scope, page: page!, concept_id: conceptId }
          : { ...base, scope },
        next.signal
      )
      if (!next.signal.aborted)
        setTurns((current) =>
          current.map((turn) => (turn.id === id ? { ...turn, answer } : turn))
        )
    } catch (error) {
      if (!next.signal.aborted)
        setTurns((current) =>
          current.map((turn) =>
            turn.id === id ? { ...turn, error: error as QueryError } : turn
          )
        )
    } finally {
      if (controller.current === next) {
        controller.current = null
        setPending(false)
      }
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger render={<Button variant="outline" />}>
        <MessageCircleQuestionIcon data-icon="inline-start" />
        Ask accepted knowledge
      </SheetTrigger>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Ask accepted knowledge</SheetTitle>
          <SheetDescription>
            Answers come only from accepted Claims and exact Evidence
            References.
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-3 border-b p-4">
            <Field>
              <FieldLabel id="query-scope-label">Answer scope</FieldLabel>
              <ToggleGroup
                aria-labelledby="query-scope-label"
                value={[scope]}
                onValueChange={(values) => {
                  const selected = values[0] as QueryScope | undefined
                  if (selected) setScope(selected)
                }}
                variant="outline"
                size="sm"
                spacing={0}
              >
                <ToggleGroupItem value="concept" disabled={!page}>
                  Current page
                </ToggleGroupItem>
                <ToggleGroupItem value="bundle">
                  Complete bundle
                </ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>
                {scope === "concept" && page
                  ? page
                  : "All accepted Concepts in this fixed Knowledge Bundle."}
              </FieldDescription>
            </Field>
            <Alert>
              <CloudUploadIcon />
              <AlertTitle>Data egress</AlertTitle>
              <AlertDescription>
                Your question and only the accepted Claims and Evidence
                requested by the Query Agent are sent to the selected Gateway
                Profile.
              </AlertDescription>
            </Alert>
          </div>

          <MessageScrollerProvider autoScroll>
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport className="px-4 py-5">
                <MessageScrollerContent>
                  {turns.length === 0 ? (
                    <MessageScrollerItem messageId="empty">
                      <Empty className="min-h-64">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <ShieldCheckIcon />
                          </EmptyMedia>
                          <EmptyTitle>Grounded answers only</EmptyTitle>
                          <EmptyDescription>
                            Unsupported questions return an explicit
                            insufficient-support result. This session clears
                            when the page reloads.
                          </EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    </MessageScrollerItem>
                  ) : (
                    turns.flatMap((turn) => [
                      <MessageScrollerItem
                        key={`${turn.id}-question`}
                        messageId={`${turn.id}-question`}
                        scrollAnchor
                      >
                        <Message align="end">
                          <MessageContent>
                            <MessageHeader>You</MessageHeader>
                            <Bubble align="end">
                              <BubbleContent>{turn.question}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>,
                      <MessageScrollerItem
                        key={`${turn.id}-answer`}
                        messageId={`${turn.id}-answer`}
                      >
                        <QueryResponse turn={turn} />
                      </MessageScrollerItem>,
                    ])
                  )}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>

          <form className="border-t p-4" onSubmit={submit}>
            <FieldGroup>
              <Field data-disabled={pending || undefined}>
                <FieldLabel htmlFor="knowledge-question" className="sr-only">
                  Ask a question
                </FieldLabel>
                <Textarea
                  id="knowledge-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Ask about accepted knowledge…"
                  maxLength={4000}
                  rows={3}
                  disabled={pending}
                />
              </Field>
              <Button type="submit" disabled={pending || !question.trim()}>
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SendIcon data-icon="inline-start" />
                )}
                {pending ? "Asking…" : "Ask"}
              </Button>
            </FieldGroup>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function QueryResponse({ turn }: { turn: Turn }) {
  if (turn.error)
    return (
      <Message align="start">
        <MessageContent>
          <MessageHeader>Query Agent</MessageHeader>
          <Bubble variant="destructive">
            <BubbleContent>{turn.error.message}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  if (!turn.answer)
    return (
      <Message align="start">
        <MessageContent>
          <MessageHeader>Query Agent</MessageHeader>
          <Bubble variant="muted">
            <BubbleContent>
              <span className="shimmer">Checking accepted knowledge…</span>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  const answer = turn.answer
  if (answer.outcome === "error")
    return (
      <Message align="start">
        <MessageContent>
          <MessageHeader>Query Agent</MessageHeader>
          <Bubble variant="destructive">
            <BubbleContent>{answer.error}</BubbleContent>
          </Bubble>
          <AnswerMetadata answer={answer} />
        </MessageContent>
      </Message>
    )
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>Query Agent</MessageHeader>
        <BubbleGroup>
          {answer.segments.map((segment, index) => (
            <AnswerSegment key={index} segment={segment} />
          ))}
        </BubbleGroup>
        <AnswerMetadata answer={answer} />
      </MessageContent>
    </Message>
  )
}

function AnswerSegment({ segment }: { segment: QuerySegment }) {
  return (
    <Bubble variant={segment.kind === "fact" ? "muted" : "outline"}>
      <BubbleContent className="flex flex-col gap-3">
        <p>{segment.text}</p>
        {segment.citations.map((citation) => (
          <div key={citation.claim_id} className="flex min-w-0 flex-col gap-2">
            <Marker variant="border">
              <MarkerIcon>
                <ShieldCheckIcon />
              </MarkerIcon>
              <MarkerContent>
                Claim <code className="break-all">{citation.claim_id}</code>
              </MarkerContent>
            </Marker>
            {citation.evidence.map((evidence) => (
              <p key={evidence.id} className="text-xs text-muted-foreground">
                Evidence <code className="break-all">{evidence.id}</code>
                <br />
                <code className="break-all">
                  {evidence.source_id}@{evidence.revision}/{evidence.path}#L
                  {evidence.start_line}-L{evidence.end_line}
                </code>
              </p>
            ))}
          </div>
        ))}
      </BubbleContent>
    </Bubble>
  )
}

function AnswerMetadata({ answer }: { answer: KnowledgeQueryAnswer }) {
  return (
    <MessageFooter className="flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{scopeLabel(answer.scope)}</Badge>
        <Badge variant="secondary">{answer.model}</Badge>
        <Badge variant="outline">{answer.latency_ms} ms</Badge>
      </div>
      <p>
        Run <code className="break-all">{answer.run_id}</code>
      </p>
      <p>
        Source Set <code className="break-all">{answer.source_set_digest}</code>
      </p>
      {answer.page && (
        <p>
          Page <code className="break-all">{answer.page}</code>
        </p>
      )}
      <Marker>
        <MarkerIcon>
          <CloudUploadIcon />
        </MarkerIcon>
        <MarkerContent>{answer.data_egress}</MarkerContent>
      </Marker>
    </MessageFooter>
  )
}

function scopeLabel(scope: QueryScope) {
  return scope === "concept" ? "Current page" : "Complete bundle"
}
