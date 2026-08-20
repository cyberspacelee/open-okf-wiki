import type { WikiTask } from "./board.js";

export type WikiRunStatus = "running" | "paused" | "succeeded" | "failed" | "cancelled";

export type WikiRunControl = "pause" | "resume" | "cancel";

export type WikiAgentStatus = "running" | "complete" | "failed";

export type WikiToolStatus = WikiAgentStatus;

export interface WikiProducerRequest {
  cwd: string;
  focus?: string;
}

export interface WikiAgentUsage {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
  compactions?: number;
  turns?: number;
  toolCalls?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercent?: number;
}

export interface WikiToolView {
  id: string;
  tool: string;
  args: unknown;
  status: WikiToolStatus;
}

export interface WikiAgentView {
  id?: string;
  agent: string;
  task?: string;
  status: WikiAgentStatus;
  tools: WikiToolView[];
  usage?: WikiAgentUsage;
}

export interface WikiSessionActivity {
  id: string;
  tool: string;
  args: unknown;
  status: WikiToolStatus;
  scope?: string;
  usage?: WikiAgentUsage;
}

export interface WikiRunView {
  id: string;
  cwd: string;
  status: WikiRunStatus;
  focus?: string;
  goal?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  agents?: WikiAgentView[];
  tasks?: WikiTask[];
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
  subscribe(listener: (view: WikiRunView) => void): () => void;
  control(action: WikiRunControl): Promise<WikiRunView>;
  result(): Promise<WikiProducerResult>;
}

export interface WikiProducer {
  start(request: WikiProducerRequest): Promise<WikiRunHandle>;
  list(cwd: string): Promise<WikiRunView[]>;
  open(runId: string, cwd: string): Promise<WikiRunHandle | undefined>;
}
