import { useEffect, useRef, useState, type FormEvent } from "react"
import {
  CloudUploadIcon,
  FileSearchIcon,
  SearchIcon,
  ShieldAlertIcon,
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
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  investigateSource,
  type InvestigationSegment,
  type SourceInvestigationAnswer,
  type SourceInvestigationError,
} from "@/lib/source-investigation"

export type InvestigationLaunch = {
  id: string
  question: string
}

type Turn = {
  id: string
  question: string
  answer?: SourceInvestigationAnswer
  error?: SourceInvestigationError
}

export function SourceInvestigationSheet({
  token,
  runId,
  sourceSetDigest,
  open,
  onOpenChange,
  launch,
  identityKey,
}: {
  token: string
  runId: string
  sourceSetDigest: string
  open: boolean
  onOpenChange: (open: boolean) => void
  launch: InvestigationLaunch | null
  identityKey: string
}) {
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
  }, [identityKey, runId, sourceSetDigest])

  useEffect(() => {
    if (launch) setQuestion(launch.question)
  }, [launch])

  useEffect(() => () => controller.current?.abort(), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const text = question.trim()
    if (!text || pending) return
    const id = crypto.randomUUID()
    const next = new AbortController()
    controller.current = next
    setQuestion("")
    setPending(true)
    setTurns((current) => [...current, { id, question: text }])
    try {
      const answer = await investigateSource(
        token,
        {
          question: text,
          run_id: runId,
          source_set_digest: sourceSetDigest,
        },
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
            turn.id === id
              ? { ...turn, error: error as SourceInvestigationError }
              : turn
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
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <div className="flex flex-wrap items-center gap-2">
            <SheetTitle>Investigate fixed sources</SheetTitle>
            <Badge variant="secondary">
              Provisional · not part of Knowledge Bundle
            </Badge>
          </div>
          <SheetDescription>
            This separate read-only mode explores the exact Source Snapshots
            pinned by the selected Run. It cannot change accepted knowledge.
          </SheetDescription>
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">Run {runId}</Badge>
            <Badge variant="outline">Source Set {sourceSetDigest}</Badge>
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-col gap-3 border-b p-4">
            <Alert>
              <ShieldAlertIcon />
              <AlertTitle>Explicit provisional investigation</AlertTitle>
              <AlertDescription>
                Review the prefilled question, then choose Investigate fixed
                sources. A result can enter the Knowledge Bundle only through a
                later normal Production Run, verification, and review.
              </AlertDescription>
            </Alert>
            <Alert>
              <CloudUploadIcon />
              <AlertTitle>Data egress</AlertTitle>
              <AlertDescription>
                Your question and bounded excerpts from the fixed Source
                Snapshots are sent to the selected Gateway Profile.
              </AlertDescription>
            </Alert>
          </div>

          <MessageScrollerProvider autoScroll>
            <MessageScroller className="min-h-0 flex-1">
              <MessageScrollerViewport className="px-4 py-5">
                <MessageScrollerContent>
                  {turns.length === 0 ? (
                    <MessageScrollerItem messageId="investigation-empty">
                      <Empty className="min-h-64">
                        <EmptyHeader>
                          <EmptyMedia variant="icon">
                            <FileSearchIcon />
                          </EmptyMedia>
                          <EmptyTitle>Separate provisional history</EmptyTitle>
                          <EmptyDescription>
                            Source Investigation turns are kept apart from
                            accepted Knowledge Queries and clear when the page
                            reloads.
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
                            <MessageHeader>
                              You · provisional mode
                            </MessageHeader>
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
                        <InvestigationResponse turn={turn} />
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
                <FieldLabel
                  htmlFor="source-investigation-question"
                  className="sr-only"
                >
                  Source investigation question
                </FieldLabel>
                <Textarea
                  id="source-investigation-question"
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  placeholder="Investigate the fixed Source Snapshots…"
                  maxLength={4000}
                  rows={3}
                  disabled={pending}
                />
                <FieldDescription>
                  Submitting creates no Claim, Concept, review decision, or
                  Bundle page.
                </FieldDescription>
              </Field>
              <Button type="submit" disabled={pending || !question.trim()}>
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SearchIcon data-icon="inline-start" />
                )}
                {pending ? "Investigating…" : "Investigate fixed sources"}
              </Button>
            </FieldGroup>
          </form>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function InvestigationResponse({ turn }: { turn: Turn }) {
  if (turn.error)
    return (
      <Message align="start">
        <MessageContent>
          <MessageHeader>Source Investigator · provisional</MessageHeader>
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
          <MessageHeader>Source Investigator · provisional</MessageHeader>
          <Bubble variant="muted">
            <BubbleContent>
              <span className="shimmer">Reading fixed Source Snapshots…</span>
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
          <MessageHeader>Source Investigator · provisional</MessageHeader>
          <Bubble variant="destructive">
            <BubbleContent>{answer.error}</BubbleContent>
          </Bubble>
          <InvestigationMetadata answer={answer} />
        </MessageContent>
      </Message>
    )
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>Source Investigator · provisional</MessageHeader>
        <BubbleGroup>
          {answer.segments.map((segment, index) => (
            <InvestigationAnswerSegment key={index} segment={segment} />
          ))}
        </BubbleGroup>
        <InvestigationMetadata answer={answer} />
      </MessageContent>
    </Message>
  )
}

function InvestigationAnswerSegment({
  segment,
}: {
  segment: InvestigationSegment
}) {
  return (
    <Bubble variant={segment.kind === "fact" ? "muted" : "outline"}>
      <BubbleContent className="flex flex-col gap-3">
        <p>{segment.text}</p>
        {segment.citations.map((citation) => (
          <div
            key={`${citation.source_id}:${citation.path}:${citation.start_line}:${citation.end_line}`}
            className="flex min-w-0 flex-col gap-2"
          >
            <Marker variant="border">
              <MarkerIcon>
                <FileSearchIcon />
              </MarkerIcon>
              <MarkerContent>Exact Source Snapshot citation</MarkerContent>
            </Marker>
            <code className="text-xs break-all">
              {`${citation.source_id}@${citation.revision}/${citation.path}#L${citation.start_line}-L${citation.end_line}`}
            </code>
            <code className="text-xs break-all text-muted-foreground">
              {citation.digest}
            </code>
          </div>
        ))}
      </BubbleContent>
    </Bubble>
  )
}

function InvestigationMetadata({
  answer,
}: {
  answer: SourceInvestigationAnswer
}) {
  return (
    <MessageFooter className="flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        <Badge variant="secondary">{answer.notice}</Badge>
        <Badge variant="outline">{answer.model}</Badge>
        <Badge variant="outline">{answer.latency_ms} ms</Badge>
        <Badge variant="outline">{answer.usage.total_tokens} tokens</Badge>
      </div>
      <p>
        Run <code className="break-all">{answer.run_id}</code>
      </p>
      <p>
        Source Set <code className="break-all">{answer.source_set_digest}</code>
      </p>
      {answer.sources.map((source) => (
        <p key={`${source.source_id}:${source.revision}`}>
          Source{" "}
          <code className="break-all">
            {source.source_id}@{source.revision}
          </code>
        </p>
      ))}
      <Marker>
        <MarkerIcon>
          <CloudUploadIcon />
        </MarkerIcon>
        <MarkerContent>{answer.data_egress}</MarkerContent>
      </Marker>
    </MessageFooter>
  )
}
