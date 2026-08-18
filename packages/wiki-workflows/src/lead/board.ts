import { wikiSpecClusterId, wikiSpecClusterPaths, wikiSpecClusters, wikiSpecDomainIds, wikiSpecRelativePath, type WikiSpec } from "./spec.js";
import type { WikiArtifactRef } from "../artifact-store.js";
import type { WikiFollowupKind, WikiResearchDomain } from "../delegate-contracts.js";

export type WikiBoardWaveName = "discovery" | "supplement" | "write" | "review";
export type WikiBoardWaveStatus = "pending" | "queued" | "running" | "complete" | "blocked";

export type WikiBoardClusterStatus =
  | "unplanned"
  | "writing"
  | "reviewing"
  | "accepted"
  | "blocked";

export interface WikiBoardCluster {
  id: string;
  paths: string[];
  status: WikiBoardClusterStatus;
  nextStep: "write" | "review" | "done" | "blocked";
  terminalWriteOrReviewCount: number;
}

export type WikiBoardNextAction = "collect" | "discovery" | "supplement" | "taxonomy" | "plan" | "write" | "review" | "finish" | "blocked";

export interface WikiBoardTask {
  id: string;
  role: "research" | "write" | "review";
  paths: string[];
  phase: "queued" | "running" | "paused" | "terminal";
  batch?: number;
  collected?: boolean;
  receiptStatus?: "complete" | "incomplete" | "failed";
  errorCode?: string;
  wave?: WikiBoardWaveName;
  sourceScopeIds?: string[];
  contextRefs?: string[];
  assignmentIds?: string[];
  domainScopeIds?: string[];
  lensScopeIds?: string[];
  resolvesIds?: string[];
  completedAssignmentIds?: string[];
  coverage?: string[];
  gaps?: string[];
  gapQuestions?: Array<{ question: string; sourceScopeIds?: string[] }>;
  followups?: Array<{ id: string; kind: WikiFollowupKind; question: string; sourceScopeIds: string[] }>;
  conflicts?: string[];
  needsFollowup?: boolean;
  domains?: WikiResearchDomain[];
  artifactRefs?: WikiArtifactRef[];
  blockingReasons?: string[];
}

export interface WikiBoardWave {
  name: WikiBoardWaveName;
  status: WikiBoardWaveStatus;
  taskIds: string[];
  completedTaskIds: string[];
  blockingReasons: string[];
}

export interface WikiBoardResearchAssignment {
  id: string;
  taskId: string;
  wave: "discovery" | "supplement";
  sourceScopeIds: string[];
  domainScopeIds: string[];
  lensScopeIds: string[];
  completed: boolean;
}

export interface WikiBoardModel {
  runId: string;
  specRevision: number;
  candidateRevision: number;
  compactionObserved: boolean;
  directWriteAllowed: boolean;
  declaredSources: string[];
  activeWave?: { name: WikiBoardWaveName; status: WikiBoardWaveStatus };
  researchCoverage: { completed: number; total: number };
  nextAction: WikiBoardNextAction;
  clusters: WikiBoardCluster[];
  tasks: WikiBoardTask[];
  remaining: string[];
  delegatedTaskCount: number;
  delegateBatchCount: number;
  taxonomy?: WikiBoardTaxonomyCheckpoint;
  waves?: Record<WikiBoardWaveName, WikiBoardWave>;
  researchAssignments?: WikiBoardResearchAssignment[];
  blockers?: string[];
  conflicts?: string[];
}

export type WikiBoardTaxonomyDecision = WikiResearchDomain;

export interface WikiBoardTaxonomyCheckpoint {
  accepted: true;
  revision: number;
  decisions: WikiBoardTaxonomyDecision[];
  conflictIds: string[];
  digest: string;
}

export interface WikiBoardProjectionReview {
  verdict: "pass" | "changes_requested";
  reviewedPaths: readonly string[];
}

export interface WikiBoardProjectionTask {
  id: string;
  role: "research" | "write" | "review";
  phase: "queued" | "running" | "paused" | "terminal";
  collected?: boolean;
  writePaths?: readonly string[];
  reviewPaths?: readonly string[];
  mode?: "discovery" | "supplement";
  sourceScopeIds?: readonly string[];
  contextRefs?: readonly string[];
  assignmentIds?: readonly string[];
  domainScopeIds?: readonly string[];
  lensScopeIds?: readonly string[];
  resolvesIds?: readonly string[];
  receipt?: {
    status: "complete" | "incomplete" | "failed";
    error?: { code?: string };
    outputs?: readonly WikiArtifactRef[];
    completedAssignmentIds?: readonly string[];
    needsFollowup?: boolean;
    followups?: readonly { id: string; kind: WikiFollowupKind; question: string; sourceScopeIds: readonly string[] }[];
    coverage?: readonly string[];
    gaps?: readonly { question: string; sourceScopeIds?: readonly string[] }[];
    domains?: readonly WikiResearchDomain[];
    review?: { verdict: "pass" | "changes_requested" };
  };
}

export interface WikiBoardProjectionInput {
  runId: string;
  specRevision: number;
  candidateRevision: number;
  sourceScopeIds?: readonly string[];
  taxonomy?: WikiBoardTaxonomyCheckpoint;
  compactionObserved: boolean;
  spec?: WikiSpec;
  reviews?: readonly WikiBoardProjectionReview[];
  delegates?: {
    batches: readonly {
      batchId?: number;
      tasks: readonly WikiBoardProjectionTask[];
    }[];
  };
}

export interface WikiResearchBlockerTask {
  id: string;
  role: "research" | "write" | "review";
  phase: "queued" | "running" | "paused" | "terminal";
  mode?: "discovery" | "supplement";
  resolvesIds?: readonly string[];
  receipt?: {
    status: "complete" | "incomplete" | "failed";
    error?: { code?: string };
    gaps?: readonly unknown[];
    followups?: readonly { id: string; kind?: WikiFollowupKind }[];
  };
}

/** Return unresolved gap, conflict, and failure IDs after successful supplements close theirs. */
export function wikiOpenResearchBlockerIds(tasks: readonly WikiResearchBlockerTask[]): string[] {
  const blockers = new Set<string>();
  const resolved = new Set<string>();
  for (const task of tasks) {
    if (task.role !== "research") continue;
    const receipt = task.receipt;
    if (task.phase === "terminal" && receipt?.status === "complete" && task.mode === "supplement") {
      for (const id of task.resolvesIds ?? []) resolved.add(id);
    }
    if (receipt?.error?.code && !(receipt.followups?.length || receipt.gaps?.length)) {
      blockers.add(`failure:${task.id}:${receipt.error.code}`);
    }
    for (let index = 0; index < (receipt?.gaps?.length ?? 0); index += 1) blockers.add(`gap:${task.id}:${index + 1}`);
    for (const followup of receipt?.followups ?? []) blockers.add(followup.id);
  }
  return [...blockers].filter((id) => !resolved.has(id));
}

export function wikiLeadMayWrite(spec: WikiSpec | undefined, compactionObserved: boolean): boolean {
  if (!spec || compactionObserved) return false;
  return wikiSpecDomainIds(spec).length === 1 && spec.pages.length <= 3;
}

/** Project Lead state onto the host-owned board. Research tasks have no paths and do not change cluster status. */
export function projectWikiBoard(input: WikiBoardProjectionInput): WikiBoardModel {
  const batches = input.delegates?.batches ?? [];
  const tasks = batches.flatMap((batch) => batch.tasks);
  const reviews = input.reviews ?? [];
  const spec = input.spec;
  const clusters = spec ? wikiSpecClusters(spec).map((id) => projectCluster(id, spec, tasks, reviews)) : [];
  const remaining: string[] = [];
  for (const cluster of clusters) remaining.push(...remainingFor(cluster, reviews));
  const projectedTasks = batches.flatMap((batch) => batch.tasks.map((task) => toBoardTask(task, batch.batchId)));
  const resolvedBlockers = new Set(projectedTasks
    .filter((task) => task.role === "research" && task.wave === "supplement" && task.phase === "terminal" && task.receiptStatus === "complete")
    .flatMap((task) => task.resolvesIds ?? []));
  const boardTasks = projectedTasks.map((task) => withoutResolvedBlockers(task, resolvedBlockers));
  const waves = projectWaves(boardTasks);
  const completedResearchAssignments = new Set(boardTasks
    .filter((task) => task.role === "research" && task.phase === "terminal")
    .flatMap((task) => task.completedAssignmentIds ?? []));
  const researchAssignments = boardTasks.flatMap((task) => task.role === "research"
    ? (task.assignmentIds ?? []).map((id) => ({
      id,
      taskId: task.id,
      wave: task.wave === "supplement" ? "supplement" as const : "discovery" as const,
      sourceScopeIds: [...(task.sourceScopeIds ?? [])],
      domainScopeIds: [...(task.domainScopeIds ?? [])],
      lensScopeIds: [...(task.lensScopeIds ?? [])],
      completed: completedResearchAssignments.has(id),
    }))
    : []);
  for (const assignment of researchAssignments) {
    if (!assignment.completed) remaining.push(`research ${assignment.id}`);
  }
  const blockers = unique(boardTasks.flatMap((task) => task.blockingReasons ?? []));
  const conflicts = unique(boardTasks.flatMap((task) => task.conflicts ?? []));
  const activeTasks = boardTasks.filter((task) => task.collected === false);
  const activeWaveName = activeTasks[0]?.wave;
  const activeWave = activeWaveName ? waves[activeWaveName] : undefined;
  const researchCoverage = {
    completed: researchAssignments.filter((assignment) => assignment.completed).length,
    total: researchAssignments.length,
  };
  const model: WikiBoardModel = {
    runId: input.runId,
    specRevision: input.specRevision,
    candidateRevision: input.candidateRevision,
    compactionObserved: input.compactionObserved,
    directWriteAllowed: wikiLeadMayWrite(input.spec, input.compactionObserved),
    declaredSources: [...(input.sourceScopeIds ?? [])],
    ...(activeWave ? { activeWave: { name: activeWave.name, status: activeWave.status } } : {}),
    researchCoverage,
    nextAction: "discovery",
    clusters,
    ...(input.taxonomy ? { taxonomy: structuredClone(input.taxonomy) } : {}),
    tasks: boardTasks,
    remaining,
    delegatedTaskCount: tasks.length,
    delegateBatchCount: batches.length,
    waves,
    researchAssignments,
    blockers,
    conflicts,
  };
  model.nextAction = wikiNextAction(model);
  return model;
}

function projectCluster(
  id: string,
  spec: WikiSpec,
  tasks: readonly WikiBoardProjectionTask[],
  reviews: readonly WikiBoardProjectionReview[],
): WikiBoardCluster {
  const paths = wikiSpecClusterPaths(spec, id);
  const touching = tasks.filter((task) => task.role !== "research" && taskTouchesCluster(task, id));
  const terminalWriteOrReviewCount = touching.filter((task) => task.phase === "terminal").length;
  const accepted = clusterAccepted(paths, reviews);
  const nextStep = clusterNextStep(touching, terminalWriteOrReviewCount, accepted);
  return { id, paths: [...paths], status: clusterStatus(touching, terminalWriteOrReviewCount, accepted), nextStep, terminalWriteOrReviewCount };
}

function clusterNextStep(
  touching: readonly WikiBoardProjectionTask[],
  terminalWriteOrReviewCount: number,
  accepted: boolean,
): WikiBoardCluster["nextStep"] {
  if (accepted) return "done";
  const latest = touching.at(-1);
  if (!latest) return "write";
  if (latest.role === "write") return latest.phase === "terminal" && latest.receipt?.status === "complete" ? "review" : "write";
  if (latest.role === "review" && latest.phase === "terminal" && latest.receipt?.review?.verdict === "changes_requested") return "write";
  if (terminalWriteOrReviewCount >= 3) return "blocked";
  return "review";
}

function clusterStatus(
  touching: readonly WikiBoardProjectionTask[],
  terminalWriteOrReviewCount: number,
  accepted: boolean,
): WikiBoardClusterStatus {
  if (terminalWriteOrReviewCount >= 3 && !accepted) return "blocked";
  if (accepted) return "accepted";
  if (touching.some((task) => task.role === "review" && task.phase !== "terminal")) return "reviewing";
  if (touching.some((task) => task.role === "write" && (task.phase !== "terminal" || !accepted))) return "writing";
  return "unplanned";
}

function remainingFor(
  cluster: WikiBoardCluster,
  reviews: readonly WikiBoardProjectionReview[],
): string[] {
  if (cluster.status === "accepted") return [];
  const lines: string[] = [];
  if (cluster.nextStep === "write") lines.push(`write ${cluster.id}`);
  if (cluster.nextStep === "review") lines.push(`review ${cluster.id}`);
  if (reviews.some((review) => review.verdict === "changes_requested" && reviewTouchesCluster(review, cluster.id))) {
    lines.push(`changes_requested ${cluster.id}`);
  }
  if (cluster.nextStep === "blocked") lines.push(`blocked ${cluster.id}`);
  return lines;
}

function clusterAccepted(paths: readonly string[], reviews: readonly WikiBoardProjectionReview[]): boolean {
  const covered = new Set(
    reviews.filter((review) => review.verdict === "pass").flatMap((review) => review.reviewedPaths.map(wikiSpecRelativePath)),
  );
  return paths.length > 0 && paths.every((page) => covered.has(page));
}

function taskPaths(task: WikiBoardProjectionTask): readonly string[] {
  if (task.role === "write") return task.writePaths ?? [];
  if (task.role === "review") return task.reviewPaths ?? [];
  return [];
}

function taskTouchesCluster(task: WikiBoardProjectionTask, clusterId: string): boolean {
  return taskPaths(task).some((page) => wikiSpecClusterId(page) === clusterId);
}

function reviewTouchesCluster(review: WikiBoardProjectionReview, clusterId: string): boolean {
  return review.reviewedPaths.some((page) => wikiSpecClusterId(page) === clusterId);
}

function toBoardTask(task: WikiBoardProjectionTask, batchId?: number): WikiBoardTask {
  const wave = task.role === "research" ? (task.mode === "supplement" ? "supplement" : "discovery") : task.role;
  const receipt = task.receipt;
  const gaps = receipt?.gaps?.map((gap, index) => `gap:${task.id}:${index + 1}`) ?? [];
  const followups = receipt?.followups ?? [];
  const conflicts = followups.filter((followup) => followup.kind === "conflict").map((followup) => followup.id);
  const blockingReasons = [
    ...gaps,
    ...(receipt?.needsFollowup ? followups.map((followup) => followup.id) : []),
    ...(receipt?.error?.code && !(gaps.length || followups.length) ? [`failure:${task.id}:${receipt.error.code}`] : []),
  ];
  return {
    id: task.id,
    role: task.role,
    paths: [...taskPaths(task)],
    phase: task.phase,
    wave,
    ...(task.sourceScopeIds ? { sourceScopeIds: [...task.sourceScopeIds] } : {}),
    ...(task.contextRefs ? { contextRefs: [...task.contextRefs] } : {}),
    ...(task.assignmentIds ? { assignmentIds: [...task.assignmentIds] } : {}),
    ...(task.domainScopeIds ? { domainScopeIds: [...task.domainScopeIds] } : {}),
    ...(task.lensScopeIds ? { lensScopeIds: [...task.lensScopeIds] } : {}),
    ...(task.resolvesIds ? { resolvesIds: [...task.resolvesIds] } : {}),
    ...(batchId !== undefined ? { batch: batchId } : {}),
    ...(task.collected !== undefined ? { collected: task.collected } : {}),
    ...(receipt ? { receiptStatus: receipt.status } : {}),
    ...(receipt?.error?.code ? { errorCode: receipt.error.code } : {}),
    ...(receipt?.completedAssignmentIds ? { completedAssignmentIds: [...receipt.completedAssignmentIds] } : {}),
    ...(receipt?.coverage || receipt?.completedAssignmentIds ? { coverage: [...(receipt.coverage ?? receipt.completedAssignmentIds ?? [])] } : {}),
    ...(gaps.length ? { gaps } : {}),
    ...(receipt?.gaps ? { gapQuestions: receipt.gaps.map((gap) => ({ question: gap.question, ...(gap.sourceScopeIds ? { sourceScopeIds: [...gap.sourceScopeIds] } : {}) })) } : {}),
    ...(followups.length ? { followups: followups.map((followup) => ({ id: followup.id, kind: followup.kind, question: followup.question, sourceScopeIds: [...followup.sourceScopeIds] })) } : {}),
    ...(conflicts.length ? { conflicts } : {}),
    ...(receipt?.needsFollowup !== undefined ? { needsFollowup: receipt.needsFollowup } : {}),
    ...(receipt?.domains ? { domains: receipt.domains.map((domain) => ({ ...domain, conceptIds: [...domain.conceptIds] })) } : {}),
    ...(receipt?.outputs ? { artifactRefs: [...receipt.outputs] } : {}),
    ...(blockingReasons.length ? { blockingReasons } : {}),
  };
}

function withoutResolvedBlockers(task: WikiBoardTask, resolved: ReadonlySet<string>): WikiBoardTask {
  const gaps = task.gaps?.filter((id) => !resolved.has(id));
  const followups = task.followups?.filter((followup) => !resolved.has(followup.id));
  const conflicts = task.conflicts?.filter((id) => !resolved.has(id));
  const blockingReasons = task.blockingReasons?.filter((id) => !resolved.has(id));
  const gapIndexes = new Set((task.gaps ?? []).flatMap((id, index) => resolved.has(id) ? [] : [index]));
  const gapQuestions = task.gapQuestions?.filter((_gap, index) => gapIndexes.has(index));
  return {
    ...task,
    ...(task.gaps ? { gaps } : {}),
    ...(task.gapQuestions ? { gapQuestions } : {}),
    ...(task.followups ? { followups } : {}),
    ...(task.conflicts ? { conflicts } : {}),
    ...(task.blockingReasons ? { blockingReasons } : {}),
    ...(task.needsFollowup !== undefined ? { needsFollowup: task.needsFollowup && Boolean(followups?.length) } : {}),
  };
}

function projectWaves(tasks: readonly WikiBoardTask[]): Record<WikiBoardWaveName, WikiBoardWave> {
  const names: WikiBoardWaveName[] = ["discovery", "supplement", "write", "review"];
  return Object.fromEntries(names.map((name) => {
    const members = tasks.filter((task) => task.wave === name);
    const pending = members.filter((task) => task.phase !== "terminal");
    const blockers = unique(members.flatMap((task) => task.blockingReasons ?? []));
    const status: WikiBoardWaveStatus = blockers.length && pending.length === 0 ? "blocked"
      : pending.length === 0 ? (members.length ? "complete" : "pending")
        : members.some((task) => task.phase === "running" || task.phase === "paused") ? "running" : "queued";
    return [name, {
      name,
      status,
      taskIds: members.map((task) => task.id),
      completedTaskIds: members.filter((task) => task.phase === "terminal").map((task) => task.id),
      blockingReasons: blockers,
    }];
  })) as Record<WikiBoardWaveName, WikiBoardWave>;
}

function unique(values: readonly string[]): string[] { return [...new Set(values)]; }

/** Host-owned Markdown projection of Lead state so remaining work survives compaction. */
export function renderWikiBoard(model: WikiBoardModel): string {
  const clusters = [...model.clusters]
    .map((cluster) => ({ ...cluster, paths: [...cluster.paths].sort(compareText) }))
    .sort((left, right) => compareText(left.id, right.id));
  const tasks = [...model.tasks].sort((left, right) => compareText(left.id, right.id));

  const lines = [
    "# Wiki board",
    "",
    `- run: ${model.runId}`,
    `- specRevision: ${model.specRevision}`,
    `- candidateRevision: ${model.candidateRevision}`,
    `- compactionObserved: ${yesNo(model.compactionObserved)}`,
    `- directWriteAllowed: ${yesNo(model.directWriteAllowed)}`,
    `- delegatedTasks: ${model.delegatedTaskCount}`,
    `- delegateBatches: ${model.delegateBatchCount}`,
    ...(model.declaredSources ? [`- declaredSources: ${model.declaredSources.join(", ") || "(none)"}`] : []),
    ...(model.activeWave ? [`- activeWave: ${model.activeWave.name} ${model.activeWave.status}`] : []),
    ...(model.researchCoverage ? [`- researchCoverage: ${model.researchCoverage.completed}/${model.researchCoverage.total}`] : []),
    ...(model.nextAction ? [`- nextAction: ${model.nextAction}`] : []),
    "",
    "## Clusters",
    "",
  ];

  for (const cluster of clusters) {
    lines.push(`- \`${cluster.id}\` **${cluster.status}** (writes/reviews: ${cluster.terminalWriteOrReviewCount})`);
    for (const page of cluster.paths) lines.push(`  - ${page}`);
  }
  if (clusters.length) lines.push("");

  if (model.taxonomy) {
    lines.push("## Taxonomy", "", `- revision: ${model.taxonomy.revision}`, `- digest: ${model.taxonomy.digest}`);
    for (const decision of model.taxonomy.decisions) {
      lines.push(`- ${decision.sourceScopeId}/${decision.domainId}: ${decision.conceptIds.join(", ") || "(none)"}`);
    }
    for (const conflict of model.taxonomy.conflictIds) lines.push(`- conflict: ${conflict}`);
    lines.push("");
  }

  lines.push("## Tasks", "");
  for (const task of tasks) lines.push(formatTask(task));
  if (tasks.length) lines.push("");

  const advancedTasks = tasks.some((task) => task.wave !== undefined);
  if (advancedTasks || model.waves) {
    lines.push("## Waves", "");
    for (const name of ["discovery", "supplement", "write", "review"] as const) {
      const wave = model.waves?.[name];
      if (!wave) continue;
      lines.push(`- **${name}** ${wave.status} (${wave.completedTaskIds.length}/${wave.taskIds.length})`);
      for (const reason of wave.blockingReasons) lines.push(`  - blocked: ${reason}`);
    }
    lines.push("");
  }

  if (model.researchAssignments?.length || model.blockers?.length || model.conflicts?.length
    || tasks.some((task) => task.role === "research" && (task.coverage?.length || task.artifactRefs?.length))) {
    lines.push("## Research", "");
    for (const assignment of model.researchAssignments ?? []) {
      lines.push(`- assignment \`${assignment.id}\` ${assignment.completed ? "complete" : "pending"} task \`${assignment.taskId}\``);
      if (assignment.sourceScopeIds.length) lines.push(`  - sources: ${assignment.sourceScopeIds.join(", ")}`);
      if (assignment.domainScopeIds.length) lines.push(`  - domains: ${assignment.domainScopeIds.join(", ")}`);
    }
    for (const task of tasks.filter((task) => task.role === "research")) {
      for (const domain of task.domains ?? []) {
        lines.push(`- ${domain.sourceScopeId}/${domain.domainId}: ${domain.conceptIds.join(", ") || "(none)"}`);
      }
      for (const coverage of task.coverage ?? []) lines.push(`- coverage: ${coverage}`);
      for (const gap of task.gaps ?? []) lines.push(`- blocker: ${gap}`);
      for (const gap of task.gapQuestions ?? []) lines.push(`  - question: ${gap.question}`);
      for (const followup of task.followups ?? []) lines.push(`- blocker ${followup.id}: ${followup.question}`);
    }
    for (const reason of model.blockers ?? []) lines.push(`- blocker: ${reason}`);
    for (const conflict of model.conflicts ?? []) lines.push(`- conflict: ${conflict}`);
    lines.push("");
  }

  lines.push("## Remaining", "");
  if (model.remaining.length) {
    for (const line of model.remaining) lines.push(`- ${line}`);
  } else {
    lines.push("- none");
  }

  return `${lines.join("\n")}\n`;
}

function formatTask(task: WikiBoardTask): string {
  const parts = [`\`${task.id}\``, task.role, task.phase, ...(task.wave && task.wave !== task.role ? [task.wave] : [])];
  if (task.batch !== undefined) parts.push(`batch ${task.batch}`);
  if (task.receiptStatus) parts.push(task.receiptStatus);
  if (task.errorCode) parts.push(task.errorCode);
  return `- ${parts.join(" ")}`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Latest complete research inventory per Source, as taxonomy decisions. */
export function researchTaxonomyDecisions(
  tasks: readonly {
    role: string;
    phase: string;
    sourceScopeIds?: readonly string[];
    receipt?: { domains?: readonly WikiResearchDomain[] };
  }[],
): WikiBoardTaxonomyDecision[] {
  const bySource = new Map<string, WikiBoardTaxonomyDecision[]>();
  for (const task of tasks) {
    if (task.role !== "research" || task.phase !== "terminal" || !task.receipt?.domains?.length) continue;
    const source = task.sourceScopeIds?.[0] ?? task.receipt.domains[0]?.sourceScopeId;
    if (!source) continue;
    bySource.set(source, structuredClone([...task.receipt.domains]));
  }
  return [...bySource.values()].flat();
}

export function mergeTaxonomyDecisions(
  current: readonly WikiBoardTaxonomyDecision[],
  incoming: readonly WikiBoardTaxonomyDecision[],
  replaceSourceIds: readonly string[],
): WikiBoardTaxonomyDecision[] {
  const replace = new Set(replaceSourceIds);
  return [
    ...current.filter((decision) => !replace.has(decision.sourceScopeId)),
    ...incoming.filter((decision) => replace.has(decision.sourceScopeId)),
  ];
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

/** One shared lifecycle decision used by the Board and coordinator. */
export function wikiNextAction(model: Pick<WikiBoardModel, "activeWave" | "blockers" | "taxonomy" | "clusters" | "researchAssignments" | "specRevision">): WikiBoardNextAction {
  if (model.activeWave) return "collect";
  if (!model.researchAssignments?.length) return "discovery";
  if (model.blockers?.length) return "supplement";
  if (!model.taxonomy) return "taxonomy";
  if (model.specRevision === 0) return "plan";
  if (model.clusters.some((cluster) => cluster.nextStep === "blocked")) return "blocked";
  if (model.clusters.some((cluster) => cluster.nextStep === "write")) return "write";
  if (model.clusters.some((cluster) => cluster.nextStep === "review")) return "review";
  return "finish";
}
