export type Category =
  | 'ビジネスモデル'
  | '現状'
  | '理想'
  | '問題'
  | '原因'
  | '示唆'
  | '課題';

export type EvidenceStatus = '確認済み' | '一部確認' | '未確認' | '仮説';
export type DecisionStatus = '未決定' | '採用' | '保留' | '却下';
export type AnalysisSource = 'rule' | 'openai';

export type AnalysisUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type Fact = {
  id: string;
  category: Category;
  statement: string;
  status: EvidenceStatus;
  source: string;
  metric: string;
  updatedAt: string;
  generatedBy: 'human' | 'rule';
};

export type ProblemCandidate = {
  id: string;
  title: string;
  description: string;
  evidenceIds: string[];
  impact: number;
  frequency: number;
  evidence: number;
  feasibility: number;
  provisional: boolean;
  scoresReviewed: boolean;
};

export type TaskCandidate = {
  id: string;
  problemId: string;
  title: string;
  outcome: string;
  effort: string;
  risk: string;
  firstAction: string;
  evidenceIds: string[];
};

export type DecisionRecord = {
  problemId: string;
  taskId: string;
  status: DecisionStatus;
  finalProblem: string;
  finalTask: string;
  expectedOutcome: string;
  nextAction: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
  nextReview: string;
  needsReview: boolean;
};

export type DecisionContext = {
  projectName: string;
  target: string;
  purpose: string;
  successMetric: string;
  decisionMaker: string;
  constraints: string;
};

export type DecisionSnapshot = {
  snapshotVersion: 1 | 2 | 3;
  id: string;
  recordedAt: string;
  decision: DecisionRecord;
  projectContext: DecisionContext;
  facts: Fact[];
  problems: ProblemCandidate[];
  tasks: TaskCandidate[];
  analysisVersion: string;
  analysisSource: AnalysisSource;
  analysisModel: string;
  analysisResponseId: string;
  analysisUsage: AnalysisUsage | null;
  analysisFallbackReason: string;
  analysisFingerprint: string;
  analysisGeneratedAt: string;
  scoringRule: string;
  problem: ProblemCandidate;
  task: TaskCandidate;
  evidenceFacts: Fact[];
};

export type ProjectData = {
  schemaVersion: 3;
  projectId: string;
  projectName: string;
  target: string;
  purpose: string;
  successMetric: string;
  decisionMaker: string;
  constraints: string;
  facts: Fact[];
  problems: ProblemCandidate[];
  tasks: TaskCandidate[];
  analysisSource: AnalysisSource | '';
  analysisVersion: string;
  analysisModel: string;
  analysisResponseId: string;
  analysisUsage: AnalysisUsage | null;
  analysisFallbackReason: string;
  analysisFingerprint: string;
  analysisGeneratedAt: string;
  decision: DecisionRecord;
  decisionHistory: DecisionSnapshot[];
  draftHistory: DecisionRecord[];
};

export const STORAGE_KEY = 'decision-canvas-project-v2';
export const LEGACY_STORAGE_KEY = 'decision-canvas-project-v1';
export const PROJECT_STORAGE_PREFIX = 'decision-canvas-project-v3:';
export const PROJECT_INDEX_KEY = 'decision-canvas-project-index-v3';
export const LAST_PROJECT_KEY = 'decision-canvas-last-project-v3';
export const SESSION_PROJECT_KEY = 'decision-canvas-session-project-v3';
export const PROJECT_BACKUP_PREFIX = 'decision-canvas-backup-v3:';
export const ANALYSIS_VERSION = 'rule-engine-5';
export const AI_ANALYSIS_VERSION = 'openai-responses-1';
export const PRIORITY_SCORING_RULE = '影響度35% + 発生頻度25% + 根拠25% + 実行可能性15%';

export const boundedBackupKeysToRemove = (
  keys: string[],
  keyPrefix: string,
  limit: number,
) => {
  const matching = keys.filter((key) => key.startsWith(keyPrefix)).sort();
  return matching.slice(0, Math.max(0, matching.length - Math.max(0, limit - 1)));
};

export const resolveConflictCopyWriteTarget = (
  existingCopyId: string,
  existingRevision: number | null,
  expectedRevision: number | null,
  existingWriterId: string | null,
  writerId: string,
  freshProjectId: string,
) => {
  const canContinueOwnedCopy = Boolean(existingCopyId) &&
    existingRevision !== null &&
    existingRevision === expectedRevision &&
    existingWriterId === writerId;
  return canContinueOwnedCopy
    ? { projectId: existingCopyId, revision: existingRevision + 1, branched: false }
    : { projectId: freshProjectId, revision: 1, branched: Boolean(existingCopyId) };
};

const CATEGORY_VALUES: Category[] = [
  'ビジネスモデル',
  '現状',
  '理想',
  '問題',
  '原因',
  '示唆',
  '課題',
];

const STATUS_VALUES: EvidenceStatus[] = ['確認済み', '一部確認', '未確認', '仮説'];
const DECISION_VALUES: DecisionStatus[] = ['未決定', '採用', '保留', '却下'];

const asText = (value: unknown) => (typeof value === 'string' ? value : '');
const asScore = (value: unknown, fallback = 3) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(5, Math.round(value)))
    : fallback;
const asTokenCount = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;

const sanitizeAnalysisUsage = (value: unknown): AnalysisUsage | null => {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const normalized = {
    inputTokens: asTokenCount(usage.inputTokens),
    outputTokens: asTokenCount(usage.outputTokens),
    totalTokens: asTokenCount(usage.totalTokens),
  };
  return normalized.totalTokens || normalized.inputTokens || normalized.outputTokens
    ? normalized
    : null;
};

const makeProjectId = () =>
  `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const createEmptyDecision = (): DecisionRecord => ({
  problemId: '',
  taskId: '',
  status: '未決定',
  finalProblem: '',
  finalTask: '',
  expectedOutcome: '',
  nextAction: '',
  reason: '',
  decidedBy: '',
  decidedAt: '',
  nextReview: '',
  needsReview: false,
});

export const createBlankProject = (): ProjectData => ({
  schemaVersion: 3,
  projectId: makeProjectId(),
  projectName: '',
  target: '',
  purpose: '',
  successMetric: '',
  decisionMaker: '',
  constraints: '',
  facts: [],
  problems: [],
  tasks: [],
  analysisSource: '',
  analysisVersion: '',
  analysisModel: '',
  analysisResponseId: '',
  analysisUsage: null,
  analysisFallbackReason: '',
  analysisFingerprint: '',
  analysisGeneratedAt: '',
  decision: createEmptyDecision(),
  decisionHistory: [],
  draftHistory: [],
});

const statusWeight: Record<EvidenceStatus, number> = {
  確認済み: 5,
  一部確認: 4,
  未確認: 2,
  仮説: 1,
};

const unique = <T,>(items: T[]) => Array.from(new Set(items));

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const projectFingerprint = (project: Pick<
  ProjectData,
  'target' | 'purpose' | 'successMetric' | 'constraints' | 'facts'
>) => {
  const facts = project.facts
    .map((fact) => ({
      id: fact.id,
      category: fact.category,
      statement: fact.statement.trim(),
      status: fact.status,
      source: fact.source.trim(),
      metric: fact.metric.trim(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return hashText(
    JSON.stringify({
      target: project.target.trim(),
      purpose: project.purpose.trim(),
      successMetric: project.successMetric.trim(),
      constraints: project.constraints.trim(),
      analysisVersion: ANALYSIS_VERSION,
      facts,
    }),
  );
};

export const evidenceScoreForFacts = (facts: Fact[], evidenceIds: string[]) => {
  const related = facts.filter((fact) => evidenceIds.includes(fact.id));
  if (!related.length) return 1;
  if (related.every((fact) => fact.status === '確認済み' && fact.source.trim())) {
    return 5;
  }
  const weightedAverage = related.reduce((sum, fact) => {
    const sourcePenalty = fact.source.trim() ? 0 : 1;
    return sum + Math.max(1, statusWeight[fact.status] - sourcePenalty);
  }, 0) / related.length;
  const calculated = asScore(weightedAverage, 1);
  if (related.some((fact) => fact.status === '未確認' || fact.status === '仮説')) {
    return Math.min(calculated, 2);
  }
  return Math.min(calculated, 3);
};

const candidateId = (kind: string, sourceIds: string[]) =>
  `${kind}-${hashText([...sourceIds].sort().join('|'))}`;

const byReliabilityThenId = (left: Fact, right: Fact) =>
  statusWeight[right.status] - statusWeight[left.status] || left.id.localeCompare(right.id);

const problemIsProvisional = (facts: Fact[], evidenceIds: string[], evidence: number) =>
  evidence < 4 ||
  evidenceIds.some((id) => {
    const fact = facts.find((item) => item.id === id);
    return fact?.status === '未確認' || fact?.status === '仮説';
  });

export const buildTaskCandidates = (
  project: Pick<ProjectData, 'facts' | 'successMetric'>,
  problems: ProblemCandidate[],
) => {
  const causeFacts = project.facts
    .filter((fact) => fact.category === '原因' && fact.statement.trim())
    .sort(byReliabilityThenId);
  const openFacts = project.facts
    .filter((fact) => fact.status === '未確認' || fact.status === '仮説')
    .sort(byReliabilityThenId);

  return problems.flatMap<TaskCandidate>((problem) => {
    const relatedOpen = openFacts.filter((fact) =>
      problem.evidenceIds.includes(fact.id),
    );
    const success = project.successMetric.trim();
    const candidates: TaskCandidate[] = [];

    if (relatedOpen.length) {
      candidates.push({
        id: `${problem.id}-verify`,
        problemId: problem.id,
        title: `根拠を確認して「${problem.title}」の判断基準を固める`,
        outcome: `参照中の未確認情報${relatedOpen.length}件について、根拠・期間・単位と、この問題との関連を確定する。`,
        effort: '小 — 追加確認が中心',
        risk: '低 — 情報収集のみ',
        firstAction: '未確認情報ごとに、情報源と確認担当者を決める。',
        evidenceIds: relatedOpen.map((fact) => fact.id),
      });
    }

    candidates.push({
      id: `${problem.id}-pilot`,
      problemId: problem.id,
      title: `「${problem.title}」への最小施策を試行する`,
      outcome: success
        ? `小さく試行し、「${success}」で改善前後を確認する。`
        : '1〜2週間の小さな試行を行い、改善前後を同じ指標で確認する。',
      effort: '小〜中 — 対象を限定して試行',
      risk: '低 — 見直し可能な範囲で実施',
      firstAction: '試行対象・期間・記録する指標・責任者を1枚にまとめる。',
      evidenceIds: [...problem.evidenceIds],
    });

    if (causeFacts.length) {
      candidates.push({
        id: `${problem.id}-routine`,
        problemId: problem.id,
        title: `「${problem.title}」の原因仮説を検証する`,
        outcome: `登録された原因候補${causeFacts.length}件と問題の因果関係を確かめ、取り組む原因を絞る。`,
        effort: '中 — 観察または小さな検証が必要',
        risk: '中 — 因果を断定すると施策がずれる',
        firstAction: '各原因候補について、確かめる方法と否定条件を決める。',
        evidenceIds: unique([
          ...problem.evidenceIds,
          ...causeFacts.map((fact) => fact.id),
        ]),
      });
    } else if (!relatedOpen.length) {
      candidates.push({
        id: `${problem.id}-measure`,
        problemId: problem.id,
        title: `「${problem.title}」の基準値を測る`,
        outcome: success
          ? `現状値を測定し、「${success}」との比較基準を作る。`
          : '現状値・対象期間・測定方法を決め、改善効果を比較できる状態にする。',
        effort: '小 — 測定設計が中心',
        risk: '低 — 情報収集のみ',
        firstAction: '現状値を1週間記録する担当者と記録場所を決める。',
        evidenceIds: [...problem.evidenceIds],
      });
    }

    return candidates;
  });
};

export const buildAnalysis = (
  project: ProjectData,
  generatedAt: string,
  fallbackReason = '',
): Pick<
  ProjectData,
  | 'problems'
  | 'tasks'
  | 'analysisSource'
  | 'analysisVersion'
  | 'analysisModel'
  | 'analysisResponseId'
  | 'analysisUsage'
  | 'analysisFallbackReason'
  | 'analysisFingerprint'
  | 'analysisGeneratedAt'
> => {
  const currentFacts = project.facts
    .filter((fact) => fact.category === '現状' && fact.statement.trim())
    .sort(byReliabilityThenId);
  const idealFacts = project.facts
    .filter((fact) => fact.category === '理想' && fact.statement.trim())
    .sort(byReliabilityThenId);
  const statedProblems = project.facts
    .filter((fact) => fact.category === '問題' && fact.statement.trim())
    .sort(byReliabilityThenId);
  if (!currentFacts.length || !idealFacts.length) {
    return {
      problems: [],
      tasks: [],
      analysisSource: '',
      analysisVersion: '',
      analysisModel: '',
      analysisResponseId: '',
      analysisUsage: null,
      analysisFallbackReason: '',
      analysisFingerprint: '',
      analysisGeneratedAt: '',
    };
  }

  const sourceFacts = statedProblems.length ? statedProblems : currentFacts;

  const problems = sourceFacts.map<ProblemCandidate>((sourceFact) => {
    // A category match alone does not prove that two facts describe the same
    // problem. Keep only the candidate's source fact; a human explicitly links
    // current, ideal, cause, and other supporting facts in the UI.
    const evidenceIds = [sourceFact.id];
    const evidence = evidenceScoreForFacts(project.facts, evidenceIds);
    const title = statedProblems.length
      ? sourceFact.statement.trim()
      : `${sourceFact.statement.trim()}という現状と、目指す状態に差がある`;
    const description = statedProblems.length
      ? `入力された問題文を候補化しました。関連する現状・理想・原因は、候補ごとの「根拠を選択」で人間が対応付けてください。`
      : `現状「${sourceFact.statement.trim()}」を起点とする問題候補です。関連する理想・原因は、候補ごとの「根拠を選択」で人間が対応付けてください。`;

    return {
      id: candidateId('problem', [sourceFact.id]),
      title,
      description,
      evidenceIds,
      impact: 3,
      frequency: 3,
      evidence,
      feasibility: 3,
      provisional: problemIsProvisional(project.facts, evidenceIds, evidence),
      scoresReviewed: false,
    };
  });

  const tasks = buildTaskCandidates(project, problems);

  return {
    problems,
    tasks,
    analysisSource: 'rule',
    analysisVersion: ANALYSIS_VERSION,
    analysisModel: '',
    analysisResponseId: '',
    analysisUsage: null,
    analysisFallbackReason: fallbackReason,
    analysisFingerprint: projectFingerprint(project),
    analysisGeneratedAt: generatedAt,
  };
};

export const updateProblemEvidence = (
  project: ProjectData,
  problemId: string,
  requestedEvidenceIds: string[],
): ProjectData => {
  const target = project.problems.find((problem) => problem.id === problemId);
  if (!target) return project;
  const sourceFactId = target.evidenceIds[0];
  const validIds = new Set(project.facts.map((fact) => fact.id));
  const evidenceIds = unique([
    sourceFactId,
    ...requestedEvidenceIds.filter((id) => validIds.has(id) && id !== sourceFactId).sort(),
  ]).filter(Boolean);
  if (!evidenceIds.length) return project;
  const evidence = evidenceScoreForFacts(project.facts, evidenceIds);
  const problems = project.problems.map((problem) =>
    problem.id === problemId
      ? {
          ...problem,
          evidenceIds,
          evidence,
          provisional: problemIsProvisional(project.facts, evidenceIds, evidence),
          scoresReviewed: false,
        }
      : problem,
  );
  const tasks = project.analysisSource === 'openai'
    ? project.tasks.map((task) =>
        task.problemId === problemId
          ? { ...task, evidenceIds: [...evidenceIds] }
          : task,
      )
    : buildTaskCandidates(project, problems);
  const selectedTaskStillExists = tasks.some((task) => task.id === project.decision.taskId);
  return {
    ...project,
    problems,
    tasks,
    decision: project.decision.problemId === problemId
      ? {
          ...project.decision,
          taskId: selectedTaskStillExists ? project.decision.taskId : '',
          needsReview: true,
        }
      : project.decision,
  };
};

const sameDecisionContent = (left: DecisionRecord, right: DecisionRecord) =>
  left.problemId === right.problemId &&
  left.taskId === right.taskId &&
  left.status === right.status &&
  left.finalProblem === right.finalProblem &&
  left.finalTask === right.finalTask &&
  left.expectedOutcome === right.expectedOutcome &&
  left.nextAction === right.nextAction &&
  left.reason === right.reason &&
  left.decidedBy === right.decidedBy &&
  left.decidedAt === right.decidedAt &&
  left.nextReview === right.nextReview;

export const archiveCurrentDecision = (project: ProjectData): ProjectData => {
  const selectedProblem = project.problems.find(
    (candidate) => candidate.id === project.decision.problemId,
  );
  const selectedTask = project.tasks.find(
    (candidate) => candidate.id === project.decision.taskId,
  );
  const generatedSelectionScaffold =
    project.decision.status === '未決定' &&
    !project.decision.reason.trim() &&
    !project.decision.decidedAt &&
    Boolean(selectedProblem) &&
    project.decision.finalProblem === selectedProblem?.title &&
    (selectedTask
      ? project.decision.finalTask === selectedTask.title &&
        project.decision.expectedOutcome === selectedTask.outcome &&
        project.decision.nextAction === selectedTask.firstAction
      : !project.decision.taskId &&
        !project.decision.finalTask &&
        !project.decision.expectedOutcome &&
        !project.decision.nextAction);
  const hasHumanDecision = !generatedSelectionScaffold && (
    Boolean(project.decision.finalProblem.trim()) ||
    Boolean(project.decision.finalTask.trim()) ||
    Boolean(project.decision.reason.trim())
  );
  const matchesConfirmedSnapshot = project.decisionHistory.some((snapshot) =>
    sameDecisionContent(snapshot.decision, project.decision),
  );
  return {
    ...project,
    draftHistory: hasHumanDecision && !matchesConfirmedSnapshot
      ? [
          { ...project.decision, needsReview: true },
          ...project.draftHistory.filter((entry) =>
            !sameDecisionContent(entry, project.decision),
          ),
        ]
      : project.draftHistory,
    decision: createEmptyDecision(),
  };
};

export const recordConfirmedDecision = (
  project: ProjectData,
  snapshotId: string,
  recordedAt: string,
): ProjectData => {
  const problem = project.problems.find((candidate) => candidate.id === project.decision.problemId);
  const task = project.tasks.find(
    (candidate) =>
      candidate.id === project.decision.taskId &&
      candidate.problemId === project.decision.problemId,
  );
  if (!problem || !task || project.decision.status === '未決定') return project;
  const snapshot: DecisionSnapshot = {
    snapshotVersion: 3,
    id: snapshotId,
    recordedAt,
    decision: { ...project.decision, needsReview: false },
    projectContext: {
      projectName: project.projectName,
      target: project.target,
      purpose: project.purpose,
      successMetric: project.successMetric,
      decisionMaker: project.decisionMaker,
      constraints: project.constraints,
    },
    facts: project.facts.map((fact) => ({ ...fact })),
    problems: project.problems.map((candidate) => ({
      ...candidate,
      evidenceIds: [...candidate.evidenceIds],
    })),
    tasks: project.tasks.map((candidate) => ({
      ...candidate,
      evidenceIds: [...candidate.evidenceIds],
    })),
    analysisVersion: project.analysisVersion,
    analysisSource: project.analysisSource || 'rule',
    analysisModel: project.analysisModel,
    analysisResponseId: project.analysisResponseId,
    analysisUsage: project.analysisUsage ? { ...project.analysisUsage } : null,
    analysisFallbackReason: project.analysisFallbackReason,
    analysisFingerprint: project.analysisFingerprint,
    analysisGeneratedAt: project.analysisGeneratedAt,
    scoringRule: PRIORITY_SCORING_RULE,
    problem: { ...problem, evidenceIds: [...problem.evidenceIds] },
    task: { ...task, evidenceIds: [...task.evidenceIds] },
    evidenceFacts: project.facts
      .filter((fact) => unique([...problem.evidenceIds, ...task.evidenceIds]).includes(fact.id))
      .map((fact) => ({ ...fact })),
  };
  return {
    ...project,
    decisionHistory: [
      snapshot,
      ...project.decisionHistory.filter((entry) => entry.id !== snapshot.id),
    ],
    draftHistory: project.draftHistory.filter(
      (entry) => !sameDecisionContent(entry, project.decision),
    ),
  };
};

export const invalidateAnalysis = (project: ProjectData): ProjectData => {
  const archived = archiveCurrentDecision(project);
  return {
    ...archived,
    problems: [],
    tasks: [],
    analysisSource: '',
    analysisVersion: '',
    analysisModel: '',
    analysisResponseId: '',
    analysisUsage: null,
    analysisFallbackReason: '',
    analysisFingerprint: '',
    analysisGeneratedAt: '',
  };
};

const sanitizeFact = (value: unknown, index: number): Fact | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const statement = asText(record.statement).trim();
  if (!statement) return null;
  const category = CATEGORY_VALUES.includes(record.category as Category)
    ? (record.category as Category)
    : '現状';
  const status = STATUS_VALUES.includes(record.status as EvidenceStatus)
    ? (record.status as EvidenceStatus)
    : '未確認';
  return {
    id: asText(record.id) || `migrated-fact-${index}`,
    category,
    statement,
    status,
    source: asText(record.source),
    metric: asText(record.metric),
    updatedAt: asText(record.updatedAt),
    generatedBy: record.generatedBy === 'rule' ? 'rule' : 'human',
  };
};

const sanitizeDecision = (value: unknown): DecisionRecord => {
  const raw = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    ...createEmptyDecision(),
    problemId: asText(raw.problemId),
    taskId: asText(raw.taskId),
    status: DECISION_VALUES.includes(raw.status as DecisionStatus)
      ? (raw.status as DecisionStatus)
      : '未決定',
    finalProblem: asText(raw.finalProblem),
    finalTask: asText(raw.finalTask),
    expectedOutcome: asText(raw.expectedOutcome),
    nextAction: asText(raw.nextAction),
    reason: asText(raw.reason),
    decidedBy: asText(raw.decidedBy),
    decidedAt: asText(raw.decidedAt),
    nextReview: asText(raw.nextReview),
    needsReview: Boolean(raw.needsReview),
  };
};

const isRecoverableDecision = (decision: DecisionRecord) =>
  Boolean(decision.finalProblem.trim()) ||
  Boolean(decision.finalTask.trim()) ||
  Boolean(decision.reason.trim());

const sameTextArray = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sanitizeProblem = (value: unknown): ProblemCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const problem = value as Record<string, unknown>;
  const id = asText(problem.id);
  const title = asText(problem.title);
  if (!id || !title) return null;
  return {
    id,
    title,
    description: asText(problem.description),
    evidenceIds: Array.isArray(problem.evidenceIds)
      ? unique(problem.evidenceIds.map(asText).filter(Boolean))
      : [],
    impact: asScore(problem.impact),
    frequency: asScore(problem.frequency),
    evidence: asScore(problem.evidence, 1),
    feasibility: asScore(problem.feasibility),
    provisional: Boolean(problem.provisional),
    scoresReviewed: Boolean(problem.scoresReviewed),
  };
};

const sanitizeTask = (value: unknown): TaskCandidate | null => {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;
  const id = asText(task.id);
  const problemId = asText(task.problemId);
  const title = asText(task.title);
  if (!id || !problemId || !title) return null;
  return {
    id,
    problemId,
    title,
    outcome: asText(task.outcome),
    effort: asText(task.effort),
    risk: asText(task.risk),
    firstAction: asText(task.firstAction),
    evidenceIds: Array.isArray(task.evidenceIds)
      ? unique(task.evidenceIds.map(asText).filter(Boolean))
      : [],
  };
};

const sanitizeDecisionContext = (value: unknown): DecisionContext => {
  const context = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {};
  return {
    projectName: asText(context.projectName),
    target: asText(context.target),
    purpose: asText(context.purpose),
    successMetric: asText(context.successMetric),
    decisionMaker: asText(context.decisionMaker),
    constraints: asText(context.constraints),
  };
};

const sanitizeSnapshot = (value: unknown, index: number): DecisionSnapshot | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const decision = sanitizeDecision(record.decision);
  const problem = sanitizeProblem(record.problem);
  const task = sanitizeTask(record.task);
  if (
    !problem ||
    !task ||
    task.problemId !== problem.id ||
    decision.problemId !== problem.id ||
    decision.taskId !== task.id ||
    decision.status === '未決定' ||
    !decision.finalProblem.trim() ||
    !decision.finalTask.trim() ||
    !decision.reason.trim() ||
    !decision.decidedBy.trim() ||
    !decision.decidedAt
  ) return null;
  const evidenceFacts = Array.isArray(record.evidenceFacts)
    ? record.evidenceFacts
        .map(sanitizeFact)
        .filter((fact): fact is Fact => Boolean(fact))
        .filter((fact, factIndex, items) =>
          items.findIndex((candidate) => candidate.id === fact.id) === factIndex,
        )
    : [];
  const facts = Array.isArray(record.facts)
    ? record.facts
        .map(sanitizeFact)
        .filter((fact): fact is Fact => Boolean(fact))
    : evidenceFacts;
  const problems = Array.isArray(record.problems)
    ? record.problems
        .map(sanitizeProblem)
        .filter((candidate): candidate is ProblemCandidate => Boolean(candidate))
    : [problem];
  const tasks = Array.isArray(record.tasks)
    ? record.tasks
        .map(sanitizeTask)
        .filter((candidate): candidate is TaskCandidate => Boolean(candidate))
    : [task];
  const hasFullSnapshot =
    record.projectContext &&
    typeof record.projectContext === 'object' &&
    Array.isArray(record.facts) &&
    Array.isArray(record.problems) &&
    Array.isArray(record.tasks);
  const snapshotVersion = hasFullSnapshot
    ? (record.snapshotVersion === 3 ? 3 : 2)
    : 1;
  const analysisSource: AnalysisSource = record.analysisSource === 'openai'
    ? 'openai'
    : 'rule';
  return {
    snapshotVersion,
    id: asText(record.id) || `migrated-snapshot-${index}`,
    recordedAt: asText(record.recordedAt) || decision.decidedAt,
    decision: { ...decision, needsReview: false },
    projectContext: sanitizeDecisionContext(record.projectContext),
    facts,
    problems,
    tasks,
    analysisVersion: asText(record.analysisVersion),
    analysisSource,
    analysisModel: asText(record.analysisModel),
    analysisResponseId: asText(record.analysisResponseId),
    analysisUsage: sanitizeAnalysisUsage(record.analysisUsage),
    analysisFallbackReason: asText(record.analysisFallbackReason),
    analysisFingerprint: asText(record.analysisFingerprint),
    analysisGeneratedAt: asText(record.analysisGeneratedAt),
    scoringRule: asText(record.scoringRule),
    problem,
    task,
    evidenceFacts,
  };
};

const uniqueDecisions = (decisions: DecisionRecord[]) => {
  const seen = new Set<string>();
  return decisions.filter((decision) => {
    const signature = JSON.stringify({ ...decision, needsReview: true });
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
};

export const migrateProject = (value: unknown): ProjectData => {
  const blank = createBlankProject();
  if (!value || typeof value !== 'object') return blank;
  const record = value as Record<string, unknown>;
  const seenFactIds = new Set<string>();
  const facts = Array.isArray(record.facts)
    ? record.facts
        .map(sanitizeFact)
        .filter((fact): fact is Fact => Boolean(fact))
        .filter((fact) => {
          if (seenFactIds.has(fact.id)) return false;
          seenFactIds.add(fact.id);
          return true;
        })
    : [];

  const storedDecision = sanitizeDecision(record.decision);
  const historyValues = Array.isArray(record.decisionHistory)
    ? record.decisionHistory
    : [];
  const storedHistory = historyValues
    .map(sanitizeSnapshot)
    .filter((snapshot): snapshot is DecisionSnapshot => Boolean(snapshot))
    .filter((snapshot, index, snapshots) =>
      snapshots.findIndex((candidate) => candidate.id === snapshot.id) === index,
    );
  const legacyHistoryDrafts = historyValues
    .filter((item) => !item || typeof item !== 'object' || !('decision' in item))
    .map(sanitizeDecision);
  const explicitDrafts = Array.isArray(record.draftHistory)
    ? record.draftHistory.map(sanitizeDecision)
    : [];
  const lastConfirmedDraft = record.lastConfirmedDecision
    ? [sanitizeDecision(record.lastConfirmedDecision)]
    : [];
  const storedDrafts = uniqueDecisions([
    ...explicitDrafts,
    ...legacyHistoryDrafts,
    ...lastConfirmedDraft,
  ])
    .filter(isRecoverableDecision)
    .map((decision) => ({ ...decision, needsReview: true }));
  const base: ProjectData = {
    ...blank,
    projectId: asText(record.projectId) || blank.projectId,
    projectName: asText(record.projectName),
    target: asText(record.target),
    purpose: asText(record.purpose),
    successMetric: asText(record.successMetric),
    decisionMaker: asText(record.decisionMaker),
    constraints: asText(record.constraints),
    facts,
    decisionHistory: storedHistory,
    draftHistory: storedDrafts,
  };

  if (record.schemaVersion !== 2 && record.schemaVersion !== 3) {
    return isRecoverableDecision(storedDecision)
      ? archiveCurrentDecision({ ...base, decision: storedDecision })
      : base;
  }

  const savedProblems = Array.isArray(record.problems)
    ? record.problems.map(sanitizeProblem).filter((item): item is ProblemCandidate => Boolean(item))
    : [];
  const savedTasks = Array.isArray(record.tasks)
    ? record.tasks.map(sanitizeTask).filter((item): item is TaskCandidate => Boolean(item))
    : [];
  const expected = buildAnalysis(base, asText(record.analysisGeneratedAt));
  const storedSource: AnalysisSource =
    record.schemaVersion === 3 && record.analysisSource === 'openai'
      ? 'openai'
      : 'rule';
  const problemIdsUnique = new Set(savedProblems.map((problem) => problem.id)).size === savedProblems.length;
  const taskIdsUnique = new Set(savedTasks.map((task) => task.id)).size === savedTasks.length;
  const factIds = new Set(base.facts.map((fact) => fact.id));
  const ruleProblemsStructurallyValid =
    problemIdsUnique &&
    savedProblems.length === expected.problems.length &&
    expected.problems.every((problem) => {
      const saved = savedProblems.find((candidate) => candidate.id === problem.id);
      return Boolean(saved) &&
        saved?.title === problem.title &&
        saved.description === problem.description &&
        saved.evidenceIds.length > 0 &&
        saved.evidenceIds[0] === problem.evidenceIds[0] &&
        saved.evidenceIds.every((id) => factIds.has(id)) &&
        saved.evidence === evidenceScoreForFacts(base.facts, saved.evidenceIds) &&
        saved.provisional === problemIsProvisional(base.facts, saved.evidenceIds, saved.evidence);
    });
  const restoredRuleProblems = expected.problems.map((problem) => {
    const saved = savedProblems.find((candidate) => candidate.id === problem.id);
    return saved
      ? {
          ...problem,
          evidenceIds: saved.evidenceIds,
          evidence: saved.evidence,
          provisional: saved.provisional,
          impact: saved.impact,
          frequency: saved.frequency,
          feasibility: saved.feasibility,
          scoresReviewed: saved.scoresReviewed,
        }
      : problem;
  });
  const expectedRuleTasks = buildTaskCandidates(base, restoredRuleProblems);
  const ruleTasksStructurallyValid =
    taskIdsUnique &&
    savedTasks.length === expectedRuleTasks.length &&
    expectedRuleTasks.every((task) => {
      const saved = savedTasks.find((candidate) => candidate.id === task.id);
      return Boolean(saved) &&
        saved?.problemId === task.problemId &&
        saved.title === task.title &&
        saved.outcome === task.outcome &&
        saved.effort === task.effort &&
        saved.risk === task.risk &&
        saved.firstAction === task.firstAction &&
        sameTextArray(saved.evidenceIds, task.evidenceIds);
    });
  const aiProblemsStructurallyValid =
    problemIdsUnique &&
    savedProblems.length > 0 &&
    savedProblems.length <= 5 &&
    savedProblems.every((problem) =>
      problem.id.startsWith('ai-problem-') &&
      Boolean(problem.title.trim()) &&
      problem.title.length <= 240 &&
      Boolean(problem.description.trim()) &&
      problem.description.length <= 1200 &&
      problem.evidenceIds.length > 0 &&
      problem.evidenceIds.length <= 100 &&
      problem.evidenceIds.every((id) => factIds.has(id)) &&
      problem.evidence === evidenceScoreForFacts(base.facts, problem.evidenceIds) &&
      problem.provisional === problemIsProvisional(
        base.facts,
        problem.evidenceIds,
        problem.evidence,
      ),
    );
  const aiTasksStructurallyValid =
    taskIdsUnique &&
    savedTasks.length > 0 &&
    savedTasks.every((task) => {
      const problem = savedProblems.find((candidate) => candidate.id === task.problemId);
      return Boolean(problem) &&
        task.id.startsWith('ai-task-') &&
        Boolean(task.title.trim()) && task.title.length <= 240 &&
        Boolean(task.outcome.trim()) && task.outcome.length <= 1200 &&
        Boolean(task.effort.trim()) && task.effort.length <= 240 &&
        Boolean(task.risk.trim()) && task.risk.length <= 400 &&
        Boolean(task.firstAction.trim()) && task.firstAction.length <= 600 &&
        task.evidenceIds.length > 0 &&
        task.evidenceIds.length <= 100 &&
        task.evidenceIds.every((id) => factIds.has(id)) &&
        task.evidenceIds.some((id) => problem?.evidenceIds.includes(id));
    }) &&
    savedProblems.every((problem) =>
      savedTasks.some((task) => task.problemId === problem.id),
    );

  const ruleAnalysisValid =
    storedSource === 'rule' &&
    asText(record.analysisFingerprint) === expected.analysisFingerprint &&
    expected.problems.length > 0 &&
    expectedRuleTasks.length > 0 &&
    ruleProblemsStructurallyValid &&
    ruleTasksStructurallyValid;
  const aiAnalysisValid =
    storedSource === 'openai' &&
    asText(record.analysisVersion) === AI_ANALYSIS_VERSION &&
    Boolean(asText(record.analysisModel)) &&
    Boolean(asText(record.analysisResponseId)) &&
    Boolean(asText(record.analysisGeneratedAt)) &&
    asText(record.analysisFingerprint) === projectFingerprint(base) &&
    aiProblemsStructurallyValid &&
    aiTasksStructurallyValid;
  const analysisValid = ruleAnalysisValid || aiAnalysisValid;
  if (!analysisValid) {
    return isRecoverableDecision(storedDecision)
      ? archiveCurrentDecision({ ...base, decision: storedDecision })
      : base;
  }

  const restoredProblems = storedSource === 'openai'
    ? savedProblems
    : restoredRuleProblems;
  const restoredTasks = storedSource === 'openai'
    ? savedTasks
    : expectedRuleTasks;
  const decisionReferencesValid =
    Boolean(storedDecision.problemId) &&
    Boolean(storedDecision.taskId) &&
    restoredProblems.some((problem) => problem.id === storedDecision.problemId) &&
    restoredTasks.some(
      (task) =>
        task.id === storedDecision.taskId &&
        task.problemId === storedDecision.problemId,
    );
  const decisionIsCompletelyEmpty =
    !storedDecision.problemId &&
    !storedDecision.taskId &&
    storedDecision.status === '未決定' &&
    !storedDecision.finalProblem &&
    !storedDecision.finalTask &&
    !storedDecision.reason;
  const restored: ProjectData = {
    ...base,
    problems: restoredProblems,
    tasks: restoredTasks,
    analysisSource: storedSource,
    analysisVersion: storedSource === 'openai'
      ? asText(record.analysisVersion)
      : ANALYSIS_VERSION,
    analysisModel: storedSource === 'openai' ? asText(record.analysisModel) : '',
    analysisResponseId: storedSource === 'openai' ? asText(record.analysisResponseId) : '',
    analysisUsage: storedSource === 'openai'
      ? sanitizeAnalysisUsage(record.analysisUsage)
      : null,
    analysisFallbackReason: storedSource === 'rule'
      ? asText(record.analysisFallbackReason)
      : '',
    analysisFingerprint: expected.analysisFingerprint,
    analysisGeneratedAt: asText(record.analysisGeneratedAt),
    decision: decisionReferencesValid || decisionIsCompletelyEmpty
      ? storedDecision
      : createEmptyDecision(),
  };
  return !decisionReferencesValid && !decisionIsCompletelyEmpty && isRecoverableDecision(storedDecision)
    ? archiveCurrentDecision({ ...restored, decision: storedDecision })
    : restored;
};

export const createSampleProject = (): ProjectData => {
  const sample: ProjectData = {
    ...createBlankProject(),
    projectName: '図書館イベント備品の貸出改善（架空）',
    target: '架空の地域図書館における、イベント備品の予約受付から貸出・返却まで',
    purpose: '担当者が交代しても、予約状況と次の行動を2分以内に確認し、貸出準備の遅れを防げる状態をつくる。',
    successMetric: '架空予約30件を2週間確認し、確認時間・次行動の未記載件数・期限超過件数を測る。',
    decisionMaker: 'デモ用：図書館運営責任者',
    constraints: '実在する利用者情報は使わない。架空データ30件、既存端末1台、追加入力は1件1分以内で試す。',
    facts: [
      ['f-business-1', 'ビジネスモデル', '架空の地域図書館は、地域イベント向けにプロジェクターや展示パネルなどの備品を無料で貸し出す。', '確認済み', '架空の貸出案内', '月40件'],
      ['f-current-1', '現状', '予約日は共有表、備品状態は点検票、変更内容は付箋で管理し、担当者は3か所を確認している。', '確認済み', '架空の予約記録30件', '確認平均6分'],
      ['f-current-2', '現状', '架空予約30件中7件で次の行動が未記載で、2件が準備期限を超過していた。', '確認済み', '架空の予約記録30件', '未記載7件・期限超過2件'],
      ['f-ideal-1', '理想', '予約日、備品名、状態、次の行動、担当、期限を一画面で確認し、交代後も2分以内に準備判断できる。', '確認済み', '架空の運用要件', '確認2分以内'],
      ['f-problem-1', '問題', '次の行動が明記されない予約があり、貸出準備の開始が遅れる。', '一部確認', '架空の予約サンプル30件', '未記載7件'],
      ['f-cause-1', '原因', '更新項目と更新タイミングが統一されていない可能性がある。', '仮説', '架空の担当者聞き取り2名', ''],
      ['f-insight-1', '示唆', '期限超過2件はいずれも次の行動が未記載であり、共通項目化が遅延防止につながる可能性がある。', '仮説', '架空の記録比較', '2件中2件'],
      ['f-task-1', '課題', '6項目を一画面に統一し、架空予約30件で確認時間と期限超過を2週間測る。', '仮説', '架空の改善検討案', '30件・2週間'],
    ].map(([id, category, statement, status, source, metric]) => ({
      id,
      category: category as Category,
      statement,
      status: status as EvidenceStatus,
      source,
      metric,
      updatedAt: '2026-08-25',
      generatedBy: id === 'f-insight-1' ? 'rule' as const : 'human' as const,
    })),
  };
  const analysis = buildAnalysis(sample, '2026-08-25T00:00:00.000Z');
  const firstProblem = analysis.problems[0];
  const firstTask = analysis.tasks.find(
    (task) => task.problemId === firstProblem?.id && task.id.endsWith('-pilot'),
  );
  return {
    ...sample,
    ...analysis,
    decision: {
      ...createEmptyDecision(),
      problemId: firstProblem?.id ?? '',
      taskId: firstTask?.id ?? '',
      finalProblem: firstProblem?.title ?? '',
      finalTask: firstTask?.title ?? '',
      expectedOutcome: firstTask?.outcome ?? '',
      nextAction: firstTask?.firstAction ?? '',
    },
  };
};

export const priorityScore = (candidate: ProblemCandidate) =>
  Math.round(
    (((candidate.impact * 0.35 +
      candidate.frequency * 0.25 +
      candidate.evidence * 0.25 +
      candidate.feasibility * 0.15) - 1) / 4) * 100,
  );

export const evidenceGrade = (score: number) => {
  if (score >= 5) return 'A';
  if (score >= 3) return 'B';
  return 'C';
};

export type DecisionReadiness = {
  ready: boolean;
  code: string;
  message: string;
};

const readinessFailure = (code: string, message: string): DecisionReadiness => ({
  ready: false,
  code,
  message,
});

export const evaluateDecisionReadiness = (project: ProjectData): DecisionReadiness => {
  if (!project.purpose.trim() || !project.target.trim() || !project.decisionMaker.trim()) {
    return readinessFailure('context', '正式記録には、目的・対象業務・最終決定者が必要です。');
  }
  const analysisCurrent =
    project.problems.length > 0 &&
    project.tasks.length > 0 &&
    project.analysisFingerprint === projectFingerprint(project);
  const problem = project.problems.find((candidate) => candidate.id === project.decision.problemId);
  const task = project.tasks.find(
    (candidate) =>
      candidate.id === project.decision.taskId &&
      candidate.problemId === project.decision.problemId,
  );
  if (!analysisCurrent || !problem || !task) {
    return readinessFailure('selection', '現在の情報から候補を生成し、問題候補と課題候補を選んでください。');
  }
  if (!problem.scoresReviewed) {
    return readinessFailure('scores', '選択した問題候補の影響度・発生頻度・実行可能性を人間が確認してください。');
  }
  if (!project.decision.finalProblem.trim() || !project.decision.finalTask.trim()) {
    return readinessFailure('wording', '最終問題文と最終課題文を入力してください。');
  }
  if (project.decision.status === '未決定') {
    return readinessFailure('status', '採用・保留・却下のいずれかを選んでください。');
  }
  if (!project.decision.reason.trim()) {
    return readinessFailure('reason', '判断理由を入力してください。');
  }
  if (!(project.decision.decidedBy.trim() || project.decisionMaker.trim())) {
    return readinessFailure('decider', '判断の責任者を入力してください。');
  }

  if (project.decision.status === '採用') {
    if (!project.successMetric.trim()) {
      return readinessFailure('success-metric', '採用を正式記録するには、成功の確認方法が必要です。');
    }
    const reliable = (fact: Fact) => fact.status === '確認済み' || fact.status === '一部確認';
    const hasBusiness = project.facts.some(
      (fact) => fact.category === 'ビジネスモデル' && fact.statement.trim() && reliable(fact),
    );
    const hasCurrent = project.facts.some(
      (fact) => fact.category === '現状' && fact.statement.trim() && reliable(fact),
    );
    const hasIdeal = project.facts.some(
      (fact) => fact.category === '理想' && fact.statement.trim() && reliable(fact),
    );
    if (!hasBusiness || !hasCurrent || !hasIdeal) {
      return readinessFailure('environment', '採用には、確認可能なビジネスモデル・現状・理想が必要です。');
    }
    const evidenceIds = new Set([...problem.evidenceIds, ...task.evidenceIds]);
    const evidenceFacts = project.facts.filter((fact) => evidenceIds.has(fact.id));
    const linkedCurrent = evidenceFacts.some((fact) => fact.category === '現状');
    const linkedIdeal = evidenceFacts.some((fact) => fact.category === '理想');
    if (!linkedCurrent || !linkedIdeal) {
      return readinessFailure('evidence-link', '採用には、選択した問題候補へ関連する「現状」と「理想」を根拠として対応付けてください。');
    }
    const sourceCoverage = evidenceFacts.length
      ? evidenceFacts.filter((fact) => fact.source.trim()).length / evidenceFacts.length
      : 0;
    const confirmedMissingSource = evidenceFacts.some(
      (fact) => fact.status === '確認済み' && !fact.source.trim(),
    );
    if (sourceCoverage < 0.5 || confirmedMissingSource) {
      return readinessFailure('sources', '採用には、選択候補の根拠の過半数に情報源があり、「確認済み」根拠すべてに出典が必要です。');
    }
    if (problem.evidence < 3) {
      return readinessFailure('evidence', '採用には根拠確度B以上が必要です。根拠不足を記録する場合は「保留」または「却下」を選べます。');
    }
  }

  if (!project.decision.nextAction.trim()) {
    return readinessFailure('next-action', '採用・保留・却下後に行う、次の行動または確認事項を入力してください。');
  }
  if (project.decision.status === '保留' && !project.decision.nextReview) {
    return readinessFailure('next-review', '保留を正式記録するには、次の確認事項と見直し日が必要です。');
  }
  return { ready: true, code: 'ready', message: '' };
};
