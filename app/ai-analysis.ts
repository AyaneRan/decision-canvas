import {
  AI_ANALYSIS_VERSION,
  evidenceScoreForFacts,
  projectFingerprint,
  type AnalysisUsage,
  type Category,
  type EvidenceStatus,
  type Fact,
  type ProblemCandidate,
  type ProjectData,
  type TaskCandidate,
} from './decision-engine.ts';

export const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
export const MAX_AI_REQUEST_BYTES = 64 * 1024;
export const MAX_AI_FACTS = 100;

export type AiInputFact = {
  id: string;
  category: Category;
  statement: string;
  status: EvidenceStatus;
  metric: string;
  hasSource: boolean;
};

export type AiAnalysisRequest = {
  inputFingerprint: string;
  target: string;
  purpose: string;
  successMetric: string;
  constraints: string;
  facts: AiInputFact[];
};

export type AiTaskDraft = {
  title: string;
  outcome: string;
  effort: string;
  risk: string;
  firstAction: string;
  evidenceIds: string[];
};

export type AiProblemDraft = {
  sourceFactId: string;
  title: string;
  description: string;
  evidenceIds: string[];
  tasks: AiTaskDraft[];
};

export type AiModelOutput = {
  problems: AiProblemDraft[];
};

export type AiAnalysisApiSuccess = {
  ok: true;
  inputFingerprint: string;
  output: AiModelOutput;
  model: string;
  responseId: string;
  generatedAt: string;
  usage: AnalysisUsage | null;
};

export type AiAnalysisApiFailure = {
  ok: false;
  code:
    | 'AI_NOT_CONFIGURED'
    | 'INVALID_REQUEST'
    | 'REQUEST_TOO_LARGE'
    | 'RATE_LIMITED'
    | 'UPSTREAM_TIMEOUT'
    | 'UPSTREAM_ERROR'
    | 'INVALID_AI_OUTPUT';
  message: string;
};

export type AiAnalysisApiResponse = AiAnalysisApiSuccess | AiAnalysisApiFailure;

export class AiValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiValidationError';
  }
}

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

const asRecord = (value: unknown, label: string) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiValidationError(`${label}の形式が不正です。`);
  }
  return value as Record<string, unknown>;
};

const assertOnlyKeys = (
  record: Record<string, unknown>,
  keys: string[],
  label: string,
) => {
  const allowed = new Set(keys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new AiValidationError(`${label}に未許可の項目があります。`);
  }
};

const cleanText = (value: unknown, label: string, maxLength: number) => {
  if (typeof value !== 'string') throw new AiValidationError(`${label}は文字列ではありません。`);
  const text = value.trim();
  if (!text) throw new AiValidationError(`${label}が空です。`);
  if (text.length > maxLength) throw new AiValidationError(`${label}が長すぎます。`);
  return text;
};

const uniqueTextIds = (
  value: unknown,
  label: string,
  validIds: Set<string>,
) => {
  if (!Array.isArray(value) || !value.length || value.length > 20) {
    throw new AiValidationError(`${label}の件数が不正です。`);
  }
  const ids = Array.from(new Set(value.map((item) => cleanText(item, label, 160))));
  if (ids.some((id) => !validIds.has(id))) {
    throw new AiValidationError(`${label}に現在の案件にない根拠IDがあります。`);
  }
  return ids;
};

const normalizedTitle = (value: string) =>
  value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ja');

export const createAiAnalysisRequest = (
  project: Pick<
    ProjectData,
    'target' | 'purpose' | 'successMetric' | 'constraints' | 'facts'
  >,
): AiAnalysisRequest => ({
  inputFingerprint: projectFingerprint(project),
  target: project.target.trim(),
  purpose: project.purpose.trim(),
  successMetric: project.successMetric.trim(),
  constraints: project.constraints.trim(),
  facts: project.facts.map((fact) => ({
    id: fact.id,
    category: fact.category,
    statement: fact.statement.trim(),
    status: fact.status,
    metric: fact.metric.trim(),
    hasSource: Boolean(fact.source.trim()),
  })),
});

export const aiRequestMatchesProject = (
  project: ProjectData,
  inputFingerprint: string,
  requestProjectJson: string,
) =>
  projectFingerprint(project) === inputFingerprint &&
  JSON.stringify(project) === requestProjectJson;

export const validateAiAnalysisRequest = (value: unknown): AiAnalysisRequest => {
  const request = asRecord(value, 'リクエスト');
  assertOnlyKeys(
    request,
    ['inputFingerprint', 'target', 'purpose', 'successMetric', 'constraints', 'facts'],
    'リクエスト',
  );
  if (!Array.isArray(request.facts) || !request.facts.length || request.facts.length > MAX_AI_FACTS) {
    throw new AiValidationError('判断材料の件数が不正です。');
  }
  const seenIds = new Set<string>();
  const facts = request.facts.map((value, index) => {
    const fact = asRecord(value, `判断材料${index + 1}`);
    assertOnlyKeys(
      fact,
      ['id', 'category', 'statement', 'status', 'metric', 'hasSource'],
      `判断材料${index + 1}`,
    );
    const id = cleanText(fact.id, '根拠ID', 160);
    if (seenIds.has(id)) throw new AiValidationError('根拠IDが重複しています。');
    seenIds.add(id);
    if (!CATEGORY_VALUES.includes(fact.category as Category)) {
      throw new AiValidationError('判断材料の分類が不正です。');
    }
    if (!STATUS_VALUES.includes(fact.status as EvidenceStatus)) {
      throw new AiValidationError('判断材料の確認状態が不正です。');
    }
    if (typeof fact.hasSource !== 'boolean') {
      throw new AiValidationError('情報源の有無が不正です。');
    }
    const metric = typeof fact.metric === 'string' ? fact.metric.trim() : '';
    if (metric.length > 500) throw new AiValidationError('数値・期間が長すぎます。');
    return {
      id,
      category: fact.category as Category,
      statement: cleanText(fact.statement, '判断材料の内容', 2000),
      status: fact.status as EvidenceStatus,
      metric,
      hasSource: fact.hasSource,
    };
  });
  const target = cleanText(request.target, '対象業務', 1200);
  const purpose = cleanText(request.purpose, '目的', 1200);
  const successMetric = typeof request.successMetric === 'string'
    ? request.successMetric.trim()
    : '';
  const constraints = typeof request.constraints === 'string'
    ? request.constraints.trim()
    : '';
  if (successMetric.length > 1200 || constraints.length > 1200) {
    throw new AiValidationError('成功条件または制約が長すぎます。');
  }
  const hasCurrent = facts.some((fact) => fact.category === '現状');
  const hasIdeal = facts.some((fact) => fact.category === '理想');
  if (!hasCurrent || !hasIdeal) {
    throw new AiValidationError('AI候補生成には現状と理想が必要です。');
  }
  return {
    inputFingerprint: cleanText(request.inputFingerprint, '入力指紋', 160),
    target,
    purpose,
    successMetric,
    constraints,
    facts,
  };
};

export const createAiOutputJsonSchema = (facts: AiInputFact[]) => {
  const factIds = facts.map((fact) => fact.id);
  const sourceFactIds = facts
    .filter((fact) => fact.category === '問題' || fact.category === '現状')
    .map((fact) => fact.id);
  const evidenceIds = {
    type: 'array',
    minItems: 1,
    maxItems: 20,
    items: { type: 'string', enum: factIds },
  } as const;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['problems'],
    properties: {
      problems: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceFactId', 'title', 'description', 'evidenceIds', 'tasks'],
          properties: {
            sourceFactId: { type: 'string', enum: sourceFactIds },
            title: { type: 'string' },
            description: { type: 'string' },
            evidenceIds,
            tasks: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'outcome', 'effort', 'risk', 'firstAction', 'evidenceIds'],
                properties: {
                  title: { type: 'string' },
                  outcome: { type: 'string' },
                  effort: { type: 'string' },
                  risk: { type: 'string' },
                  firstAction: { type: 'string' },
                  evidenceIds,
                },
              },
            },
          },
        },
      },
    },
  } as const;
};

export const validateAiModelOutput = (
  value: unknown,
  facts: Pick<Fact, 'id' | 'category'>[] | AiInputFact[],
): AiModelOutput => {
  const output = asRecord(value, 'AI出力');
  assertOnlyKeys(output, ['problems'], 'AI出力');
  if (!Array.isArray(output.problems) || !output.problems.length || output.problems.length > 5) {
    throw new AiValidationError('AI出力の問題候補数が不正です。');
  }
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const validIds = new Set(factById.keys());
  const seenProblems = new Set<string>();
  const problems = output.problems.flatMap<AiProblemDraft>((value, problemIndex) => {
    const problem = asRecord(value, `問題候補${problemIndex + 1}`);
    assertOnlyKeys(
      problem,
      ['sourceFactId', 'title', 'description', 'evidenceIds', 'tasks'],
      `問題候補${problemIndex + 1}`,
    );
    const sourceFactId = cleanText(problem.sourceFactId, '起点根拠ID', 160);
    const sourceFact = factById.get(sourceFactId);
    if (!sourceFact || (sourceFact.category !== '問題' && sourceFact.category !== '現状')) {
      throw new AiValidationError('問題候補の起点根拠が不正です。');
    }
    const title = cleanText(problem.title, '問題候補のタイトル', 240);
    const titleKey = normalizedTitle(title);
    if (seenProblems.has(titleKey)) return [];
    seenProblems.add(titleKey);
    const rawEvidenceIds = uniqueTextIds(problem.evidenceIds, '問題候補の根拠', validIds);
    const evidenceIds = [sourceFactId, ...rawEvidenceIds.filter((id) => id !== sourceFactId)];
    if (!evidenceIds.some((id) => factById.get(id)?.category === '理想')) {
      throw new AiValidationError('問題候補には理想の根拠が必要です。');
    }
    if (!Array.isArray(problem.tasks) || !problem.tasks.length || problem.tasks.length > 3) {
      throw new AiValidationError('課題候補数が不正です。');
    }
    const seenTasks = new Set<string>();
    const tasks = problem.tasks.flatMap<AiTaskDraft>((value, taskIndex) => {
      const task = asRecord(value, `課題候補${taskIndex + 1}`);
      assertOnlyKeys(
        task,
        ['title', 'outcome', 'effort', 'risk', 'firstAction', 'evidenceIds'],
        `課題候補${taskIndex + 1}`,
      );
      const taskTitle = cleanText(task.title, '課題候補のタイトル', 240);
      const taskKey = normalizedTitle(taskTitle);
      if (seenTasks.has(taskKey)) return [];
      seenTasks.add(taskKey);
      const taskEvidenceIds = uniqueTextIds(task.evidenceIds, '課題候補の根拠', validIds);
      if (!taskEvidenceIds.some((id) => evidenceIds.includes(id))) {
        throw new AiValidationError('課題候補の根拠が親問題と結び付いていません。');
      }
      return [{
        title: taskTitle,
        outcome: cleanText(task.outcome, '課題候補の期待状態', 1200),
        effort: cleanText(task.effort, '課題候補の工数', 240),
        risk: cleanText(task.risk, '課題候補のリスク', 400),
        firstAction: cleanText(task.firstAction, '課題候補の最初の行動', 600),
        evidenceIds: taskEvidenceIds,
      }];
    });
    if (!tasks.length) throw new AiValidationError('有効な課題候補がありません。');
    return [{
      sourceFactId,
      title,
      description: cleanText(problem.description, '問題候補の説明', 1200),
      evidenceIds,
      tasks,
    }];
  });
  if (!problems.length) throw new AiValidationError('有効な問題候補がありません。');
  return { problems };
};

const hashText = (text: string) => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const normalizeAiAnalysis = (
  project: ProjectData,
  output: AiModelOutput,
  meta: Pick<AiAnalysisApiSuccess, 'model' | 'responseId' | 'generatedAt' | 'usage'>,
) => {
  const validated = validateAiModelOutput(output, project.facts);
  const inputFingerprint = projectFingerprint(project);
  const problems: ProblemCandidate[] = validated.problems.map((problem) => {
    const evidence = evidenceScoreForFacts(project.facts, problem.evidenceIds);
    return {
      id: `ai-problem-${hashText(`${inputFingerprint}|${normalizedTitle(problem.title)}|${[...problem.evidenceIds].sort().join('|')}`)}`,
      title: problem.title,
      description: problem.description,
      evidenceIds: [...problem.evidenceIds],
      impact: 3,
      frequency: 3,
      evidence,
      feasibility: 3,
      provisional: evidence < 4 || problem.evidenceIds.some((id) => {
        const fact = project.facts.find((item) => item.id === id);
        return fact?.status === '未確認' || fact?.status === '仮説';
      }),
      scoresReviewed: false,
    };
  });
  const tasks: TaskCandidate[] = validated.problems.flatMap((problem, problemIndex) => {
    const problemId = problems[problemIndex].id;
    return problem.tasks.map((task) => ({
      id: `ai-task-${hashText(`${problemId}|${normalizedTitle(task.title)}|${[...task.evidenceIds].sort().join('|')}`)}`,
      problemId,
      title: task.title,
      outcome: task.outcome,
      effort: task.effort,
      risk: task.risk,
      firstAction: task.firstAction,
      evidenceIds: [...task.evidenceIds],
    }));
  });
  return {
    problems,
    tasks,
    analysisSource: 'openai' as const,
    analysisVersion: AI_ANALYSIS_VERSION,
    analysisModel: meta.model,
    analysisResponseId: meta.responseId,
    analysisUsage: meta.usage,
    analysisFallbackReason: '',
    analysisFingerprint: inputFingerprint,
    analysisGeneratedAt: meta.generatedAt,
  };
};
