export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type WikiRunControl = "pause" | "resume" | "cancel";

export interface WikiProducerRequest {
  cwd: string;
  focus?: string;
}

export interface WikiRunView {
  id: string;
  cwd: string;
  status: WikiRunStatus;
  focus?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  agents?: Array<{ agent: string; task: string; status: "running" | "complete" | "failed" }>;
  pageCount?: number;
}

export interface WikiProducerResult {
  id: string;
  wikiRoot: string;
  pages: string[];
}

export class WikiRunResultError extends Error {
  readonly view: WikiRunView;
  constructor(message: string, view: WikiRunView) {
    super(message);
    this.name = "WikiRunResultError";
    this.view = view;
  }
}

export interface WikiRunHandle {
  readonly id: string;
  view(): Promise<WikiRunView>;
  control(action: WikiRunControl): Promise<WikiRunView>;
  result(): Promise<WikiProducerResult>;
}

export interface WikiProducer {
  start(request: WikiProducerRequest): Promise<WikiRunHandle>;
  list(cwd: string): Promise<WikiRunView[]>;
  open(runId: string, cwd: string): Promise<WikiRunHandle | undefined>;
}
