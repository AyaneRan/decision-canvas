'use client';

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ANALYSIS_VERSION,
  LEGACY_STORAGE_KEY,
  LAST_PROJECT_KEY,
  PROJECT_BACKUP_PREFIX,
  PROJECT_INDEX_KEY,
  PROJECT_STORAGE_PREFIX,
  PRIORITY_SCORING_RULE,
  SESSION_PROJECT_KEY,
  STORAGE_KEY,
  archiveCurrentDecision,
  boundedBackupKeysToRemove,
  buildAnalysis,
  createBlankProject,
  createEmptyDecision,
  createSampleProject,
  evidenceGrade,
  evaluateDecisionReadiness,
  invalidateAnalysis,
  migrateProject,
  priorityScore,
  projectFingerprint,
  recordConfirmedDecision,
  resolveConflictCopyWriteTarget,
  updateProblemEvidence,
  type Category,
  type DecisionRecord,
  type DecisionSnapshot,
  type DecisionStatus,
  type EvidenceStatus,
  type Fact,
  type ProblemCandidate,
  type ProjectData,
} from './decision-engine';
import {
  aiRequestMatchesProject,
  createAiAnalysisRequest,
  normalizeAiAnalysis,
  validateAiAnalysisRequest,
  type AiAnalysisApiResponse,
} from './ai-analysis';

type StepId = 'purpose' | 'facts' | 'problems' | 'decision' | 'report';
type StoredProjectEnvelope = {
  storageVersion: 1;
  revision: number;
  savedAt: string;
  writerId: string;
  project: unknown;
};
type ProjectSummary = {
  projectId: string;
  projectName: string;
  updatedAt: string;
};

const AUTO_BACKUP_LIMIT = 5;

const STEPS: Array<{
  id: StepId;
  number: string;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
}> = [
  {
    id: 'purpose',
    number: '01',
    label: '目的',
    eyebrow: 'STAGE 0 — PURPOSE',
    title: '判断の目的を固定する',
    description: '何を改善し、誰が決め、成功をどう確かめるかを先に定めます。',
  },
  {
    id: 'facts',
    number: '02',
    label: '環境理解',
    eyebrow: 'STAGE 1 — CONTEXT',
    title: '環境を事実で捉える',
    description: '確認済み・未確認・仮説を分け、7分類で判断材料を整理します。',
  },
  {
    id: 'problems',
    number: '03',
    label: '問題発見',
    eyebrow: 'STAGE 2 — PROBLEM',
    title: '問題候補を同じ基準で比べる',
    description: '現状と理想の差から候補を作ります。順位は参考で、決定ではありません。',
  },
  {
    id: 'decision',
    number: '04',
    label: '課題設定',
    eyebrow: 'STAGE 3 — DECISION',
    title: '人間が問題文と課題文を決める',
    description: '候補を下書きとして使い、最終文・理由・責任者を人間が記録します。',
  },
  {
    id: 'report',
    number: '05',
    label: 'レポート',
    eyebrow: 'OUTPUT — DECISION BRIEF',
    title: '判断材料と決定を分けて共有する',
    description: '事実・仮説・自動整理・人間の決定を区別した記録を出力します。',
  },
];

const CATEGORIES: Category[] = [
  'ビジネスモデル',
  '現状',
  '理想',
  '問題',
  '原因',
  '示唆',
  '課題',
];

const CATEGORY_META: Record<
  Category,
  { kind: string; className: string; explanation: string }
> = {
  ビジネスモデル: { kind: '事実', className: 'category-business', explanation: '価値提供と業務の前提' },
  現状: { kind: '事実', className: 'category-current', explanation: '現在確認できている状態' },
  理想: { kind: '目標', className: 'category-ideal', explanation: '実現したい状態' },
  問題: { kind: '解釈', className: 'category-problem', explanation: '現状と理想の差' },
  原因: { kind: '仮説', className: 'category-cause', explanation: '問題が続く理由' },
  示唆: { kind: '仮説', className: 'category-insight', explanation: '事実から読み取れる意味' },
  課題: { kind: '人間の決定', className: 'category-task', explanation: '優先して変える対象' },
};

const newId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

const analysisFields = new Set<keyof ProjectData>([
  'target',
  'purpose',
  'successMetric',
  'constraints',
]);

const projectStorageKey = (projectId: string) => `${PROJECT_STORAGE_PREFIX}${projectId}`;

const safeSessionSet = (key: string, value: string) => {
  try {
    window.sessionStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};

const safeSessionGet = (key: string) => {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
};

const persistBoundedBackup = (
  storage: Storage,
  keyPrefix: string,
  value: string,
  limit = AUTO_BACKUP_LIMIT,
) => {
  const existingKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key) existingKeys.push(key);
  }
  boundedBackupKeysToRemove(existingKeys, keyPrefix, limit)
    .forEach((key) => storage.removeItem(key));
  storage.setItem(
    `${keyPrefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    value,
  );
};

const parseProjectIndex = (value: string | null): ProjectSummary[] => {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  return parsed.flatMap<ProjectSummary>((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.projectId !== 'string' || !record.projectId || seen.has(record.projectId)) return [];
    seen.add(record.projectId);
    return [{
      projectId: record.projectId,
      projectName: typeof record.projectName === 'string' ? record.projectName : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
    }];
  });
};

const parseEnvelope = (value: string): StoredProjectEnvelope => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid envelope');
  const record = parsed as Record<string, unknown>;
  if (record.storageVersion !== 1 || typeof record.revision !== 'number' || !('project' in record)) {
    throw new Error('invalid envelope');
  }
  return {
    storageVersion: 1,
    revision: Math.max(0, Math.floor(record.revision)),
    savedAt: typeof record.savedAt === 'string' ? record.savedAt : '',
    writerId: typeof record.writerId === 'string' ? record.writerId : '',
    project: record.project,
  };
};

const mergeProjectSummaries = (...groups: ProjectSummary[][]) => {
  const summaries = new Map<string, ProjectSummary>();
  groups.flat().forEach((summary) => {
    const existing = summaries.get(summary.projectId);
    if (!existing || summary.updatedAt > existing.updatedAt) summaries.set(summary.projectId, summary);
  });
  return [...summaries.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
};

const scanStoredProjects = (storage: Storage): ProjectSummary[] => {
  const summaries: ProjectSummary[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(PROJECT_STORAGE_PREFIX)) continue;
      const projectId = key.slice(PROJECT_STORAGE_PREFIX.length);
      const raw = storage.getItem(key);
      if (!projectId || !raw) continue;
      try {
        const envelope = parseEnvelope(raw);
        if (!envelope.project || typeof envelope.project !== 'object') throw new Error('invalid project');
        const project = envelope.project as Record<string, unknown>;
        if (project.projectId !== projectId) throw new Error('project id mismatch');
        summaries.push({
          projectId,
          projectName: typeof project.projectName === 'string' ? project.projectName : '',
          updatedAt: envelope.savedAt,
        });
      } catch {
        summaries.push({
          projectId,
          projectName: '読み込みエラー（原本保持）',
          updatedAt: '',
        });
      }
    }
  } catch {
    return [];
  }
  return summaries;
};

const persistAutomaticConflictCopy = (
  storage: Storage,
  project: ProjectData,
  writerId: string,
  existingCopyId = '',
  expectedRevision: number | null = null,
) => {
  const freshProjectId = createBlankProject().projectId;
  let projectId = freshProjectId;
  let revision = 1;
  let branchedFromExistingCopy = false;
  if (existingCopyId) {
    const existingRaw = storage.getItem(projectStorageKey(existingCopyId));
    if (existingRaw) {
      try {
        const existing = parseEnvelope(existingRaw);
        const target = resolveConflictCopyWriteTarget(
          existingCopyId,
          existing.revision,
          expectedRevision,
          existing.writerId,
          writerId,
          freshProjectId,
        );
        projectId = target.projectId;
        revision = target.revision;
        branchedFromExistingCopy = target.branched;
      } catch {
        // A damaged copy is preserved under its original key. Continue in a
        // fresh copy instead of replacing data that cannot be inspected.
      }
    }
  }
  const savedAt = new Date().toISOString();
  const baseName = (project.projectName || '名称未設定の案件')
    .replace(/（自動競合コピー(?: [^)]+)?）$/, '');
  const copySuffix = branchedFromExistingCopy
    ? `（自動競合コピー ${projectId.slice(-6)}）`
    : '（自動競合コピー）';
  const copy: ProjectData = {
    ...project,
    projectId,
    projectName: `${baseName}${copySuffix}`,
    decision: project.decision.status === '未決定'
      ? project.decision
      : { ...project.decision, needsReview: true },
  };
  const envelope: StoredProjectEnvelope = {
    storageVersion: 1,
    revision,
    savedAt,
    writerId,
    project: copy,
  };
  storage.setItem(projectStorageKey(projectId), JSON.stringify(envelope));
  const nextIndex = mergeProjectSummaries(
    [{ projectId, projectName: copy.projectName, updatedAt: savedAt }],
    scanStoredProjects(storage),
  );
  try {
    storage.setItem(PROJECT_INDEX_KEY, JSON.stringify(nextIndex));
  } catch {
    // 案件本体キーは保存済みで、一覧は次回走査時に復元される。
  }
  return { copy, nextIndex, revision };
};

const formatSavedTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
};

const formatRecordedAt = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
};

const sameDecision = (left: DecisionRecord, right: DecisionRecord) =>
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

const hasHumanDecisionDraft = (project: ProjectData) => {
  const problem = project.problems.find((candidate) => candidate.id === project.decision.problemId);
  const task = project.tasks.find((candidate) => candidate.id === project.decision.taskId);
  const generatedSelectionScaffold =
    project.decision.status === '未決定' &&
    !project.decision.reason.trim() &&
    !project.decision.decidedAt &&
    Boolean(problem) &&
    project.decision.finalProblem === problem?.title &&
    (task
      ? project.decision.finalTask === task.title &&
        project.decision.expectedOutcome === task.outcome &&
        project.decision.nextAction === task.firstAction
      : !project.decision.taskId &&
        !project.decision.finalTask &&
        !project.decision.expectedOutcome &&
        !project.decision.nextAction);
  return !generatedSelectionScaffold && Boolean(
    project.decision.finalProblem ||
    project.decision.finalTask ||
    project.decision.reason,
  );
};

const snapshotMatchesProject = (snapshot: DecisionSnapshot, project: ProjectData) =>
  snapshot.snapshotVersion >= 2 &&
  snapshot.projectContext.projectName === project.projectName &&
  snapshot.projectContext.target === project.target &&
  snapshot.projectContext.purpose === project.purpose &&
  snapshot.projectContext.successMetric === project.successMetric &&
  snapshot.projectContext.decisionMaker === project.decisionMaker &&
  snapshot.projectContext.constraints === project.constraints &&
  snapshot.analysisVersion === project.analysisVersion &&
  snapshot.analysisSource === (project.analysisSource || 'rule') &&
  snapshot.analysisModel === project.analysisModel &&
  snapshot.analysisResponseId === project.analysisResponseId &&
  JSON.stringify(snapshot.analysisUsage) === JSON.stringify(project.analysisUsage) &&
  snapshot.analysisFallbackReason === project.analysisFallbackReason &&
  snapshot.analysisFingerprint === project.analysisFingerprint &&
  snapshot.analysisGeneratedAt === project.analysisGeneratedAt &&
  snapshot.scoringRule === PRIORITY_SCORING_RULE &&
  JSON.stringify(snapshot.facts) === JSON.stringify(project.facts) &&
  JSON.stringify(snapshot.problems) === JSON.stringify(project.problems) &&
  JSON.stringify(snapshot.tasks) === JSON.stringify(project.tasks);

const assertSupportedSchema = (value: unknown) => {
  if (!value || typeof value !== 'object') return;
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  if (
    typeof schemaVersion === 'number' &&
    schemaVersion !== 1 &&
    schemaVersion !== 2 &&
    schemaVersion !== 3
  ) {
    throw new Error('unsupported schema');
  }
};

const markdownCell = (value: string) => value.replace(/\|/g, '／').replace(/\r?\n/g, ' ');

function DecisionWorkbench() {
  const [data, setData] = useState<ProjectData>(() => createBlankProject());
  const [activeStep, setActiveStep] = useState<StepId>('purpose');
  const [factFilter, setFactFilter] = useState<'すべて' | Category>('すべて');
  const [hydrated, setHydrated] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [persistedJson, setPersistedJson] = useState('');
  const [projectIndex, setProjectIndex] = useState<ProjectSummary[]>([]);
  const [storageConflict, setStorageConflict] = useState(false);
  const [conflictCopyId, setConflictCopyId] = useState('');
  const [conflictCopyError, setConflictCopyError] = useState(false);
  const [sessionWarning, setSessionWarning] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [recoveryRaw, setRecoveryRaw] = useState('');
  const [toast, setToast] = useState('');
  const [lastDeleted, setLastDeleted] = useState<Fact | null>(null);
  const [showFormula, setShowFormula] = useState(false);
  const [aiRunState, setAiRunState] = useState<{
    state: 'idle' | 'loading' | 'success' | 'fallback' | 'error';
    message: string;
  }>({ state: 'idle', message: '' });
  const [reviewConfirmationJson, setReviewConfirmationJson] = useState('');
  const currentReviewJson = JSON.stringify(data);
  const reviewConfirmed = Boolean(reviewConfirmationJson) &&
    reviewConfirmationJson === currentReviewJson;
  const setReviewConfirmed = (confirmed: boolean) => {
    setReviewConfirmationJson(confirmed ? currentReviewJson : '');
  };
  const [factDraft, setFactDraft] = useState<{
    category: Category;
    statement: string;
    status: EvidenceStatus;
    source: string;
    metric: string;
  }>({
    category: '現状',
    statement: '',
    status: '未確認',
    source: '',
    metric: '',
  });
  const addFactRef = useRef<HTMLTextAreaElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const revisionRef = useRef(0);
  const lastPersistedJsonRef = useRef('');
  const writerIdRef = useRef(newId('writer'));
  const automaticConflictCopyRef = useRef<{
    sourceProjectId: string;
    copyProjectId: string;
    revision: number;
  } | null>(null);
  const conflictRescueQueueRef = useRef<Promise<string>>(Promise.resolve(''));
  const aiRequestRef = useRef(0);
  const aiAbortRef = useRef<AbortController | null>(null);
  const [verifiedAiResponseIds, setVerifiedAiResponseIds] = useState<Set<string>>(() => new Set());
  const dataRef = useRef(data);

  const isVerifiedAiSource = (source: string, responseId: string) =>
    source === 'openai' &&
    Boolean(responseId) &&
    verifiedAiResponseIds.has(responseId);
  const analysisSourceLabel = (source: string, responseId: string) => {
    if (source !== 'openai') return '端末内ルール';
    return isVerifiedAiSource(source, responseId)
      ? 'OpenAI API'
      : '保存データ上のOpenAI記録（由来未検証）';
  };

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const rescueConflictInput = useCallback((project: ProjectData) => {
    const existing = automaticConflictCopyRef.current;
    const existingCopyId = existing?.sourceProjectId === project.projectId
      ? existing.copyProjectId
      : '';
    try {
      const { copy, nextIndex, revision } = persistAutomaticConflictCopy(
        window.localStorage,
        project,
        writerIdRef.current,
        existingCopyId,
        existing?.sourceProjectId === project.projectId ? existing.revision : null,
      );
      automaticConflictCopyRef.current = {
        sourceProjectId: project.projectId,
        copyProjectId: copy.projectId,
        revision,
      };
      setConflictCopyId(copy.projectId);
      setConflictCopyError(false);
      setProjectIndex(nextIndex);
      return copy.projectId;
    } catch {
      setConflictCopyError(true);
      setToast('競合を検知しました。画面入力は保持していますが、自動退避できませんでした。手動でバックアップしてください。');
      return '';
    }
  }, []);

  const rescueConflictInputLocked = useCallback((project: ProjectData) => {
    const queued = conflictRescueQueueRef.current.then(async () => {
      const existing = automaticConflictCopyRef.current;
      const existingCopyId = existing?.sourceProjectId === project.projectId
        ? existing.copyProjectId
        : '';
      if (navigator.locks && existingCopyId) {
        return navigator.locks.request(
          `decision-canvas-save:${existingCopyId}`,
          () => rescueConflictInput(project),
        );
      }
      return rescueConflictInput(project);
    });
    conflictRescueQueueRef.current = queued.catch(() => '');
    return queued;
  }, [rescueConflictInput]);

  useEffect(() => {
    let active = true;
    window.queueMicrotask(() => {
      if (!active) return;
      let summaries: ProjectSummary[] = [];
      let loadedProject = createBlankProject();
      let hydrationMessage = '';
      let recoveryCandidate = '';
      try {
        try {
          summaries = parseProjectIndex(window.localStorage.getItem(PROJECT_INDEX_KEY));
        } catch {
          hydrationMessage = '案件一覧を読み込めませんでした。保存済み案件本体は変更していません。';
        }
        summaries = mergeProjectSummaries(summaries, scanStoredProjects(window.localStorage));

        const activeProjectId =
          safeSessionGet(SESSION_PROJECT_KEY) ||
          window.localStorage.getItem(LAST_PROJECT_KEY);
        const projectEnvelope = activeProjectId
          ? window.localStorage.getItem(projectStorageKey(activeProjectId))
          : null;
        recoveryCandidate = projectEnvelope ?? '';

        if (projectEnvelope) {
          const envelope = parseEnvelope(projectEnvelope);
          assertSupportedSchema(envelope.project);
          loadedProject = migrateProject(envelope.project);
          if (loadedProject.projectId !== activeProjectId) throw new Error('project id mismatch');
          revisionRef.current = envelope.revision;
          lastPersistedJsonRef.current = JSON.stringify(envelope.project);
          setPersistedJson(JSON.stringify(envelope.project));
          setSavedAt(formatSavedTime(envelope.savedAt));
          if (JSON.stringify(envelope.project) !== JSON.stringify(loadedProject)) {
            hydrationMessage = '保存データを安全な形式へ復旧しました。元データは次回保存時にバックアップします。';
          }
        } else {
          const stored = window.localStorage.getItem(STORAGE_KEY);
          const legacy = stored ? null : window.localStorage.getItem(LEGACY_STORAGE_KEY);
          recoveryCandidate = stored ?? legacy ?? '';
          if (stored) {
            const parsed: unknown = JSON.parse(stored);
            assertSupportedSchema(parsed);
            loadedProject = migrateProject(parsed);
            hydrationMessage = '以前の入力を案件別保存へ移行します。元データは削除しません。';
          } else if (legacy) {
            const parsed: unknown = JSON.parse(legacy);
            assertSupportedSchema(parsed);
            loadedProject = migrateProject(parsed);
            hydrationMessage = '以前の入力を引き継ぎました。古い候補は安全のため再生成が必要です。';
          }
        }
      } catch {
        loadedProject = createBlankProject();
        revisionRef.current = 0;
        lastPersistedJsonRef.current = '';
        setPersistedJson('');
        setRecoveryRaw(recoveryCandidate);
        hydrationMessage = '保存データを読み込めなかったため、新しい案件を開きました。破損した元データは上書きしていません。';
      } finally {
        setData(loadedProject);
        setProjectIndex(summaries);
        if (!safeSessionSet(SESSION_PROJECT_KEY, loadedProject.projectId)) {
          setSessionWarning(true);
        }
        if (hydrationMessage) setToast(hydrationMessage);
        setHydrated(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || storageConflict) return;
    const projectJson = JSON.stringify(data);
    if (projectJson === lastPersistedJsonRef.current) return;
    const performSave = () => {
      try {
        const key = projectStorageKey(data.projectId);
        const existingRaw = window.localStorage.getItem(key);
        const existing = existingRaw ? parseEnvelope(existingRaw) : null;
        if (
          existing &&
          existing.writerId !== writerIdRef.current &&
          (
            existing.revision > revisionRef.current ||
            (
              existing.revision === revisionRef.current &&
              JSON.stringify(existing.project) !== lastPersistedJsonRef.current
            )
          )
        ) {
          const copyId = rescueConflictInput(data);
          setStorageConflict(true);
          setSavedAt('');
          setToast(copyId
            ? '別タブとの競合を検知し、現在の入力を別案件へ自動退避しました。'
            : '別のタブで同じ案件が更新されました。自動保存を停止しています。');
          return;
        }
        if (existing && existing.revision > revisionRef.current) {
          revisionRef.current = existing.revision;
          lastPersistedJsonRef.current = JSON.stringify(existing.project);
          setPersistedJson(JSON.stringify(existing.project));
          if (JSON.stringify(existing.project) === projectJson) {
            setSavedAt(formatSavedTime(existing.savedAt));
            return;
          }
        }

        if (existingRaw && existing && JSON.stringify(existing.project) !== projectJson) {
          try {
            persistBoundedBackup(
              window.localStorage,
              `${PROJECT_BACKUP_PREFIX}${data.projectId}:`,
              existingRaw,
            );
          } catch {
            setToast('案件は保存を続けますが、旧版の内部バックアップを作れませんでした。JSONバックアップで退避してください。');
          }
        }

        const savedAtIso = new Date().toISOString();
        const nextRevision = Math.max(revisionRef.current, existing?.revision ?? 0) + 1;
        const envelope: StoredProjectEnvelope = {
          storageVersion: 1,
          revision: nextRevision,
          savedAt: savedAtIso,
          writerId: writerIdRef.current,
          project: data,
        };
        window.localStorage.setItem(key, JSON.stringify(envelope));
        revisionRef.current = nextRevision;
        lastPersistedJsonRef.current = projectJson;
        setPersistedJson(projectJson);
        setSaveError(false);
        setSavedAt(formatSavedTime(savedAtIso));
        const nextSummary: ProjectSummary = {
          projectId: data.projectId,
          projectName: data.projectName,
          updatedAt: savedAtIso,
        };
        try {
          window.localStorage.setItem(LAST_PROJECT_KEY, data.projectId);
          if (!safeSessionSet(SESSION_PROJECT_KEY, data.projectId)) {
            setSessionWarning(true);
          }
          const rawIndex = window.localStorage.getItem(PROJECT_INDEX_KEY);
          let currentIndex: ProjectSummary[] = [];
          try {
            currentIndex = parseProjectIndex(rawIndex);
          } catch {
            if (rawIndex) {
              try {
                persistBoundedBackup(
                  window.localStorage,
                  `${PROJECT_BACKUP_PREFIX}project-index:`,
                  rawIndex,
                );
              } catch {
                setToast('案件本体は保存しました。破損した案件一覧の退避だけ失敗しましたが、本体から一覧を復元できます。');
              }
            }
          }
          const nextIndex = mergeProjectSummaries(
            [nextSummary],
            currentIndex,
            scanStoredProjects(window.localStorage),
          );
          window.localStorage.setItem(PROJECT_INDEX_KEY, JSON.stringify(nextIndex));
          setProjectIndex(nextIndex);
        } catch {
          setProjectIndex(mergeProjectSummaries([nextSummary], scanStoredProjects(window.localStorage)));
          setToast('案件本体は保存しましたが、案件一覧の更新に失敗しました。再読み込み時に本体から復元します。');
        }
      } catch {
        setSavedAt('');
        setSaveError(true);
        setToast('保存できませんでした。入力内容は画面に残っています。レポートをコピーしてください。');
      }
    };
    const timer = window.setTimeout(() => {
      if (navigator.locks) {
        void navigator.locks
          .request(`decision-canvas-save:${data.projectId}`, () => performSave())
          .catch(() => {
            setSavedAt('');
            setSaveError(true);
            setToast('保存処理を開始できませんでした。入力内容は画面に残っています。');
          });
      } else {
        performSave();
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [data, hydrated, rescueConflictInput, storageConflict]);

  useEffect(() => {
    if (!hydrated) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key === PROJECT_INDEX_KEY) {
        try {
          setProjectIndex(mergeProjectSummaries(
            parseProjectIndex(event.newValue),
            scanStoredProjects(window.localStorage),
          ));
        } catch {
          setToast('別タブで案件一覧が更新されましたが、一覧を読み込めませんでした。');
        }
        return;
      }
      if (event.key?.startsWith(PROJECT_STORAGE_PREFIX)) {
        setProjectIndex(scanStoredProjects(window.localStorage));
      }
      if (event.key !== projectStorageKey(data.projectId) || !event.newValue) return;
      try {
        const incoming = parseEnvelope(event.newValue);
        const incomingJson = JSON.stringify(incoming.project);
        if (
          incoming.writerId !== writerIdRef.current &&
          incoming.revision >= revisionRef.current
        ) {
          if (incomingJson === lastPersistedJsonRef.current) {
            revisionRef.current = incoming.revision;
            setSavedAt(formatSavedTime(incoming.savedAt));
            return;
          }
          if (
            incoming.revision === revisionRef.current &&
            Boolean(lastPersistedJsonRef.current)
          ) {
            const copyId = rescueConflictInput(data);
            setStorageConflict(true);
            setSavedAt('');
            setToast(copyId
              ? '同一版への同時保存を検知し、現在の入力を別案件へ自動退避しました。'
              : '同一版への同時保存を検知しました。入力保護のため自動保存を停止しました。');
            return;
          }
          if (JSON.stringify(data) === lastPersistedJsonRef.current) {
            assertSupportedSchema(incoming.project);
            const incomingProject = migrateProject(incoming.project);
            if (incomingProject.projectId !== data.projectId) throw new Error('project id mismatch');
            aiRequestRef.current += 1;
            aiAbortRef.current?.abort();
            aiAbortRef.current = null;
            setAiRunState({ state: 'idle', message: '' });
            setVerifiedAiResponseIds(new Set());
            revisionRef.current = incoming.revision;
            lastPersistedJsonRef.current = incomingJson;
            setPersistedJson(incomingJson);
            setReviewConfirmationJson('');
            setData(incomingProject);
            setSavedAt(formatSavedTime(incoming.savedAt));
            setToast('別タブで保存された更新をこの画面にも反映しました。');
            return;
          }
          const copyId = rescueConflictInput(data);
          setStorageConflict(true);
          setSavedAt('');
          setToast(copyId
            ? '別タブとの競合を検知し、現在の入力を別案件へ自動退避しました。'
            : '別のタブで同じ案件が更新されました。入力保護のため自動保存を停止しました。');
        }
      } catch {
        setRecoveryRaw(event.newValue);
        setStorageConflict(true);
        setSavedAt('');
        setToast('同じ案件の保存データが破損しています。現在の画面入力は上書きせず保持します。');
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [data, hydrated, rescueConflictInput]);

  useEffect(() => {
    if (!hydrated || !storageConflict || !conflictCopyId) return;
    const timer = window.setTimeout(() => {
      void rescueConflictInputLocked(data);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [conflictCopyId, data, hydrated, rescueConflictInputLocked, storageConflict]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeIndex = STEPS.findIndex((step) => step.id === activeStep);
  const activeMeta = STEPS[activeIndex];
  const factsByCategory = useMemo(
    () => CATEGORIES.reduce<Record<Category, number>>((counts, category) => {
      counts[category] = data.facts.filter((fact) => fact.category === category).length;
      return counts;
    }, {} as Record<Category, number>),
    [data.facts],
  );
  const currentFacts = data.facts.filter(
    (fact) => fact.category === '現状' && fact.statement.trim(),
  );
  const reliableCurrentFacts = currentFacts.filter(
    (fact) => fact.status === '確認済み' || fact.status === '一部確認',
  );
  const idealFacts = data.facts.filter(
    (fact) => fact.category === '理想' && fact.statement.trim(),
  );
  const reliableIdealFacts = idealFacts.filter(
    (fact) => fact.status === '確認済み' || fact.status === '一部確認',
  );
  const reliableBusinessFacts = data.facts.filter(
    (fact) =>
      fact.category === 'ビジネスモデル' &&
      fact.statement.trim() &&
      (fact.status === '確認済み' || fact.status === '一部確認'),
  );
  const missingForAnalysis = [
    !data.target.trim() ? '対象業務' : '',
    !data.purpose.trim() ? '目的' : '',
    !reliableCurrentFacts.length ? '確認済みまたは一部確認の現状' : '',
    !idealFacts.length ? '理想' : '',
  ].filter(Boolean);
  const canAnalyze = missingForAnalysis.length === 0;
  const analysisCurrent =
    data.problems.length > 0 &&
    data.tasks.length > 0 &&
    data.analysisFingerprint === projectFingerprint(data);
  const selectedProblem = data.problems.find(
    (problem) => problem.id === data.decision.problemId,
  );
  const selectedTask = data.tasks.find((task) => task.id === data.decision.taskId);
  const availableTasks = selectedProblem
    ? data.tasks.filter((task) => task.problemId === selectedProblem.id)
    : [];
  const selectedEvidenceFacts = selectedProblem
    ? data.facts.filter((fact) => selectedProblem.evidenceIds.includes(fact.id))
    : [];
  const selectedTaskEvidenceFacts = selectedTask
    ? data.facts.filter((fact) => selectedTask.evidenceIds.includes(fact.id))
    : [];
  const decisionEvidenceIds = new Set([
    ...(selectedProblem?.evidenceIds ?? []),
    ...(selectedTask?.evidenceIds ?? []),
  ]);
  const decisionEvidenceFacts = data.facts.filter((fact) => decisionEvidenceIds.has(fact.id));
  const rankedProblems = useMemo(
    () => [...data.problems].sort((left, right) =>
      Number(right.scoresReviewed) - Number(left.scoresReviewed) ||
      (left.scoresReviewed && right.scoresReviewed
        ? priorityScore(right) - priorityScore(left)
        : left.title.localeCompare(right.title, 'ja')),
    ),
    [data.problems],
  );
  const filteredFacts = factFilter === 'すべて'
    ? data.facts
    : data.facts.filter((fact) => fact.category === factFilter);
  const openFacts = data.facts.filter(
    (fact) => fact.status === '未確認' || fact.status === '仮説',
  );
  const verifiedFacts = data.facts.filter((fact) => fact.status === '確認済み');
  const partialFacts = data.facts.filter((fact) => fact.status === '一部確認');
  const latestDecisionHistory = data.decisionHistory[0];
  const currentDecisionSnapshot = data.decisionHistory.find((snapshot) =>
    sameDecision(snapshot.decision, data.decision) && snapshotMatchesProject(snapshot, data),
  );
  const decisionReadiness = evaluateDecisionReadiness(data);
  const reportReady = Boolean(
    decisionReadiness.ready &&
    !data.decision.needsReview &&
    data.decision.decidedAt &&
    currentDecisionSnapshot,
  );
  const stepCompleted: Record<StepId, boolean> = {
    purpose: Boolean(data.purpose.trim() && data.target.trim() && data.decisionMaker.trim()),
    facts: Boolean(reliableCurrentFacts.length && reliableIdealFacts.length && reliableBusinessFacts.length),
    problems: Boolean(analysisCurrent && selectedProblem?.scoresReviewed),
    decision: reportReady,
    report: reportReady,
  };

  const checks = (() => {
    const reliableCurrent = data.facts.some(
      (fact) => fact.category === '現状' && fact.statement.trim() &&
        (fact.status === '確認済み' || fact.status === '一部確認'),
    );
    const sourceBasis = decisionEvidenceFacts.length ? decisionEvidenceFacts : data.facts;
    const sources = sourceBasis.filter((fact) => fact.source.trim()).length;
    const confirmedBasis = sourceBasis.filter((fact) => fact.status === '確認済み');
    return [
      { label: '目的が明確', passed: Boolean(data.purpose.trim()) },
      { label: '対象業務が明確', passed: Boolean(data.target.trim()) },
      { label: 'ビジネスモデルあり', passed: factsByCategory.ビジネスモデル > 0 },
      { label: '確認可能な現状あり', passed: reliableCurrent },
      { label: '理想状態あり', passed: idealFacts.length > 0 },
      { label: decisionEvidenceFacts.length ? '選択候補の根拠に情報源あり' : '登録情報の過半数に情報源あり', passed: sourceBasis.length > 0 && sources / sourceBasis.length >= 0.5 },
      { label: '確認済み根拠に出典あり', passed: confirmedBasis.length > 0 && confirmedBasis.every((fact) => Boolean(fact.source.trim())) },
      { label: '最終決定者が明確', passed: Boolean(data.decisionMaker.trim()) },
      { label: '現在の情報で候補を生成済み', passed: analysisCurrent },
    ];
  })();
  const passedChecks = checks.filter((check) => check.passed).length;

  const analysisNotes = useMemo(() => {
    const notes: Array<{ tone: 'warning' | 'info'; title: string; body: string }> = [];
    const missingSource = data.facts.filter(
      (fact) => fact.status === '確認済み' && !fact.source.trim(),
    );
    if (missingForAnalysis.length) {
      notes.push({
        tone: 'warning',
        title: '候補生成に必要な情報が不足',
        body: `不足：${missingForAnalysis.join('・')}`,
      });
    } else if (!analysisCurrent) {
      notes.push({
        tone: 'warning',
        title: '候補の生成が必要',
        body: '現在の判断材料から問題・課題候補を作ってください。古い候補は使用しません。',
      });
    }
    if (openFacts.length) {
      notes.push({
        tone: 'warning',
        title: `未確認・仮説が${openFacts.length}件`,
        body: '候補には使われますが、確認済みの事実とは分けて表示します。',
      });
    }
    if (missingSource.length) {
      notes.push({
        tone: 'warning',
        title: '出典のない確認済み情報',
        body: `${missingSource.length}件あります。情報源を追加するか確認状態を見直してください。`,
      });
    }
    if (data.facts.some((fact) => fact.metric.trim())) {
      notes.push({
        tone: 'warning',
        title: '数値の整合性は人間が確認',
        body: '単位・期間・対象範囲が一致するかは自動判定していません。確定前に元資料と照合してください。',
      });
    }
    if (data.decision.needsReview) {
      notes.push({
        tone: 'warning',
        title: '確定内容の再確認が必要',
        body: '候補の評価または判断内容が変更されています。もう一度確定してください。',
      });
    }
    if (latestDecisionHistory) {
      notes.push({
        tone: 'info',
        title: `正式な判断履歴を${data.decisionHistory.length}件保持`,
        body: '確定時点の問題文・課題文・根拠・評価を、現在の編集内容とは別に保存しています。',
      });
    }
    if (data.draftHistory.length) {
      notes.push({
        tone: 'info',
        title: `再確認用の下書きを${data.draftHistory.length}件保持`,
        body: '判断材料の変更前に編集中だった内容です。正式な判断履歴とは区別しています。',
      });
    }
    if (!notes.length) {
      notes.push({
        tone: 'info',
        title: '現在の入力と候補は一致',
        body: '根拠を確認し、人間が最終問題文と課題文を整えてください。',
      });
    }
    return notes;
  }, [analysisCurrent, data.decision.needsReview, data.decisionHistory.length, data.draftHistory.length, data.facts, latestDecisionHistory, missingForAnalysis, openFacts.length]);

  const cancelPendingAi = () => {
    aiRequestRef.current += 1;
    aiAbortRef.current?.abort();
    aiAbortRef.current = null;
    setAiRunState((current) =>
      current.state === 'loading' ? { state: 'idle', message: '' } : current,
    );
  };

  const applyRuleFallback = (
    inputFingerprint: string,
    requestProjectJson: string,
    fallbackReason: string,
    message: string,
  ) => {
    if (!aiRequestMatchesProject(dataRef.current, inputFingerprint, requestProjectJson)) {
      setAiRunState({
        state: 'error',
        message: '生成中に入力または人間の編集内容が変更されたため、古い結果は適用しませんでした。',
      });
      return;
    }
    const generatedAt = new Date().toISOString();
    setData((current) => {
      if (!aiRequestMatchesProject(current, inputFingerprint, requestProjectJson)) return current;
      const archived = archiveCurrentDecision(current);
      return {
        ...archived,
        ...buildAnalysis(archived, generatedAt, fallbackReason),
      };
    });
    setReviewConfirmed(false);
    setAiRunState({ state: 'fallback', message });
    setToast('AI接続を使えなかったため、端末内のルールで候補を作成しました。');
  };

  const runAiAnalysis = async () => {
    if (!canAnalyze) {
      setToast(`候補生成に必要な情報が不足しています：${missingForAnalysis.join('・')}`);
      return;
    }
    const current = dataRef.current;
    const hasDecisionText = hasHumanDecisionDraft(current);
    if (
      hasDecisionText &&
      !window.confirm('AIで候補を作り直します。確定済みの判断は履歴へ残し、編集中の下書きはリセットしますか？')
    ) return;

    let requestBody;
    try {
      requestBody = validateAiAnalysisRequest(createAiAnalysisRequest(current));
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : 'AIへ送る前に入力内容を確認してください。';
      setAiRunState({ state: 'error', message });
      setToast(message);
      return;
    }
    const requestProjectJson = JSON.stringify(current);
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;
    const requestId = aiRequestRef.current + 1;
    aiRequestRef.current = requestId;
    setAiRunState({ state: 'loading', message: 'AIが候補を生成中です。' });

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const payloadValue: unknown = await response.json();
      if (requestId !== aiRequestRef.current) return;
      if (!aiRequestMatchesProject(
        dataRef.current,
        requestBody.inputFingerprint,
        requestProjectJson,
      )) {
        setAiRunState({
          state: 'error',
          message: '生成中に入力または人間の編集内容が変更されたため、古いAI結果は適用しませんでした。',
        });
        return;
      }
      if (!payloadValue || typeof payloadValue !== 'object' || !('ok' in payloadValue)) {
        throw new Error('invalid api response');
      }
      const payload = payloadValue as AiAnalysisApiResponse;
      if (!response.ok || !payload.ok) {
        const failureCode = !payload.ok ? payload.code : 'UPSTREAM_ERROR';
        const failureMessage = !payload.ok
          ? payload.message
          : 'OpenAI APIへ接続できませんでした。';
        if (failureCode === 'INVALID_REQUEST' || failureCode === 'REQUEST_TOO_LARGE') {
          setAiRunState({ state: 'error', message: failureMessage });
          setToast(failureMessage);
          return;
        }
        applyRuleFallback(
          requestBody.inputFingerprint,
          requestProjectJson,
          failureCode,
          failureMessage,
        );
        return;
      }
      if (
        payload.inputFingerprint !== requestBody.inputFingerprint ||
        !payload.model ||
        !payload.responseId ||
        !payload.generatedAt
      ) {
        throw new Error('invalid api metadata');
      }
      const analysis = normalizeAiAnalysis(dataRef.current, payload.output, payload);
      setVerifiedAiResponseIds((current) => {
        const next = new Set(current);
        next.add(payload.responseId);
        return next;
      });
      setData((latest) => {
        if (!aiRequestMatchesProject(
          latest,
          requestBody.inputFingerprint,
          requestProjectJson,
        )) return latest;
        const archived = archiveCurrentDecision(latest);
        return { ...archived, ...analysis };
      });
      setReviewConfirmed(false);
      setAiRunState({ state: 'success', message: 'AIの候補を安全に検証して反映しました。' });
      setToast('AIが作成した問題・課題候補を反映しました。人間が根拠と評価を確認してください。');
    } catch (error) {
      if (requestId !== aiRequestRef.current) return;
      if (error instanceof Error && error.name === 'AbortError') {
        setAiRunState({ state: 'idle', message: '' });
        return;
      }
      applyRuleFallback(
        requestBody.inputFingerprint,
        requestProjectJson,
        'NETWORK_OR_VALIDATION_ERROR',
        'AIの応答を安全に適用できなかったため、端末内のルールを使用しました。',
      );
    } finally {
      if (requestId === aiRequestRef.current) aiAbortRef.current = null;
    }
  };

  const updateProjectField = (
    field: 'projectName' | 'target' | 'purpose' | 'successMetric' | 'decisionMaker' | 'constraints',
    value: string,
  ) => {
    cancelPendingAi();
    setData((current) => {
      const changed = { ...current, [field]: value };
      if (analysisFields.has(field)) return invalidateAnalysis(changed);
      if (
        (field === 'decisionMaker' || field === 'projectName') &&
        current.decision.status !== '未決定'
      ) {
        return {
          ...changed,
          decision: { ...current.decision, needsReview: true },
        };
      }
      return changed;
    });
    if (analysisFields.has(field) || field === 'decisionMaker' || field === 'projectName') setReviewConfirmed(false);
  };

  const addFact = (event: FormEvent) => {
    event.preventDefault();
    if (!factDraft.statement.trim()) {
      setToast('内容を入力してください。');
      addFactRef.current?.focus();
      return;
    }
    cancelPendingAi();
    const fact: Fact = {
      id: newId('fact'),
      ...factDraft,
      statement: factDraft.statement.trim(),
      source: factDraft.source.trim(),
      metric: factDraft.metric.trim(),
      updatedAt: today(),
      generatedBy: 'human',
    };
    setData((current) => invalidateAnalysis({ ...current, facts: [fact, ...current.facts] }));
    setFactDraft((current) => ({ ...current, statement: '', source: '', metric: '' }));
    setFactFilter('すべて');
    setReviewConfirmed(false);
    setToast('判断材料を1件追加しました。候補を作成済みの場合は再生成してください。');
    window.setTimeout(() => addFactRef.current?.focus(), 0);
  };

  const updateFact = (id: string, patch: Partial<Fact>) => {
    cancelPendingAi();
    setData((current) => invalidateAnalysis({
      ...current,
      facts: current.facts.map((fact) =>
        fact.id === id ? { ...fact, ...patch, updatedAt: today() } : fact,
      ),
    }));
    setReviewConfirmed(false);
  };

  const deleteFact = (id: string) => {
    const target = data.facts.find((fact) => fact.id === id);
    if (!target) return;
    cancelPendingAi();
    setLastDeleted(target);
    setData((current) => invalidateAnalysis({
      ...current,
      facts: current.facts.filter((fact) => fact.id !== id),
    }));
    setReviewConfirmed(false);
    setToast('1件削除しました。候補と未確定の判断をリセットしました。');
  };

  const undoDelete = () => {
    if (!lastDeleted) return;
    cancelPendingAi();
    setData((current) => invalidateAnalysis({
      ...current,
      facts: [lastDeleted, ...current.facts],
    }));
    setLastDeleted(null);
    setToast('削除を取り消しました。候補は再生成してください。');
  };

  const updateProblemScore = (
    id: string,
    key: 'impact' | 'frequency' | 'feasibility',
    value: number,
  ) => {
    cancelPendingAi();
    setData((current) => ({
      ...current,
      problems: current.problems.map((problem) =>
        problem.id === id ? { ...problem, [key]: value } : problem,
      ),
      decision: {
        ...current.decision,
        needsReview: current.decision.status !== '未決定' || current.decision.needsReview,
      },
    }));
    setReviewConfirmed(false);
  };

  const setProblemScoresReviewed = (id: string, scoresReviewed: boolean) => {
    cancelPendingAi();
    setData((current) => ({
      ...current,
      problems: current.problems.map((problem) =>
        problem.id === id ? { ...problem, scoresReviewed } : problem,
      ),
      decision: {
        ...current.decision,
        needsReview: current.decision.status !== '未決定' || current.decision.needsReview,
      },
    }));
    setReviewConfirmed(false);
  };

  const toggleProblemEvidence = (problemId: string, factId: string, checked: boolean) => {
    cancelPendingAi();
    setData((current) => {
      const problem = current.problems.find((candidate) => candidate.id === problemId);
      if (!problem) return current;
      const evidenceIds = checked
        ? [...problem.evidenceIds, factId]
        : problem.evidenceIds.filter((id) => id !== factId);
      return updateProblemEvidence(current, problemId, evidenceIds);
    });
    setReviewConfirmed(false);
  };

  const runRuleAnalysis = () => {
    if (!canAnalyze) {
      setToast(`候補生成に必要な情報が不足しています：${missingForAnalysis.join('・')}`);
      return;
    }
    const hasDecisionText = hasHumanDecisionDraft(data);
    if (hasDecisionText && !window.confirm('候補を作り直します。確定済みの判断は履歴へ残し、編集中の下書きはリセットしますか？')) return;
    cancelPendingAi();
    const generatedAt = new Date().toISOString();
    setData((current) => {
      const archived = archiveCurrentDecision(current);
      return {
        ...archived,
        ...buildAnalysis(archived, generatedAt),
      };
    });
    setReviewConfirmed(false);
    setAiRunState({ state: 'idle', message: '' });
    setToast('現在の判断材料だけを使い、問題候補と課題候補を作り直しました。');
  };

  const selectProblem = (problem: ProblemCandidate) => {
    if (data.decision.problemId === problem.id) return;
    const hasDecisionText = Boolean(
      data.decision.finalProblem || data.decision.finalTask || data.decision.reason,
    );
    if (hasDecisionText && !window.confirm('別の問題候補へ変更します。確定済みの判断は履歴へ残し、編集中の下書きは置き換えますか？')) return;
    cancelPendingAi();
    setData((current) => {
      const archived = archiveCurrentDecision(current);
      return {
        ...archived,
        decision: {
          ...createEmptyDecision(),
          problemId: problem.id,
          finalProblem: problem.title,
          decidedBy: current.decision.decidedBy,
        },
      };
    });
    setReviewConfirmed(false);
  };

  const selectTask = (taskId: string) => {
    const task = data.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    if (data.decision.taskId === task.id) return;
    const hasTaskDecisionText = Boolean(
      data.decision.finalTask || data.decision.reason || data.decision.status !== '未決定',
    );
    if (hasTaskDecisionText && !window.confirm('別の課題候補へ変更します。確定済みの判断は履歴へ残し、課題文と判断理由を置き換えますか？')) return;
    cancelPendingAi();
    setData((current) => {
      const archived = archiveCurrentDecision(current);
      return {
        ...archived,
        decision: {
          ...createEmptyDecision(),
          problemId: task.problemId,
          taskId: task.id,
          finalProblem: current.decision.finalProblem || selectedProblem?.title || '',
          finalTask: task.title,
          expectedOutcome: task.outcome,
          nextAction: task.firstAction,
          decidedBy: current.decision.decidedBy,
        },
      };
    });
    setReviewConfirmed(false);
  };

  const updateDecision = (patch: Partial<DecisionRecord>) => {
    cancelPendingAi();
    setData((current) => ({
      ...current,
      decision: { ...current.decision, ...patch, needsReview: true },
    }));
    setReviewConfirmed(false);
  };

  const confirmDecision = () => {
    const readiness = evaluateDecisionReadiness(data);
    if (!readiness.ready) {
      setToast(readiness.message);
      return;
    }
    if (!reviewConfirmed) {
      setToast('候補・根拠・未確認情報を確認したことをチェックしてください。');
      return;
    }
    cancelPendingAi();
    const snapshotId = newId('decision');
    const recordedAt = new Date().toISOString();
    setData((current) => {
      const finalized: ProjectData = {
        ...current,
        decision: {
          ...current.decision,
          decidedBy: current.decision.decidedBy || current.decisionMaker,
          decidedAt: current.decision.decidedAt || today(),
          needsReview: false,
        },
      };
      return recordConfirmedDecision(finalized, snapshotId, recordedAt);
    });
    setToast('人間の判断として記録しました。');
    setActiveStep('report');
  };

  const reportMarkdown = (() => {
    const problemScore = selectedProblem
      ? `${priorityScore(selectedProblem)}点（根拠確度 ${evidenceGrade(selectedProblem.evidence)}）`
      : '未選択';
    const decisionHeading = data.decision.status === '採用'
      ? '人間が決めた問題と課題'
      : '人間が検討した問題と課題案';
    const actionHeading = data.decision.status === '採用' ? '次の行動' : '今後の対応';
    const problemComparisonRows = rankedProblems.map((problem) => {
      const reviewed = problem.scoresReviewed;
      return `| ${problem.id === selectedProblem?.id ? '選択' : '比較'} | ${reviewed ? '人間確認済み' : '未確認'} | ${markdownCell(problem.title)} | ${reviewed ? problem.impact : '—'} | ${reviewed ? problem.frequency : '—'} | ${problem.evidence}（${evidenceGrade(problem.evidence)}・自動算出） | ${reviewed ? problem.feasibility : '—'} | ${reviewed ? priorityScore(problem) : '—'} |`;
    }).join('\n');
    const taskComparisonRows = availableTasks.map((task) =>
      `### ${task.id === selectedTask?.id ? '選択' : '比較'}：${task.title}\n- 期待効果：${task.outcome}\n- 工数：${task.effort}\n- リスク：${task.risk}\n- 最初の行動：${task.firstAction}\n- 参照根拠：${task.evidenceIds.length}件`,
    ).join('\n');
    return `# ${data.projectName || '意思決定レポート'}

- 記録ID：${currentDecisionSnapshot?.id || '未確定'}
- 確定時刻（JST）：${currentDecisionSnapshot ? formatRecordedAt(currentDecisionSnapshot.recordedAt) : '未確定'}
- 生成方式：${currentDecisionSnapshot ? analysisSourceLabel(currentDecisionSnapshot.analysisSource, currentDecisionSnapshot.analysisResponseId) : '未確定'}
- 分析エンジン：${currentDecisionSnapshot?.analysisVersion || data.analysisVersion || ANALYSIS_VERSION}
- モデル：${currentDecisionSnapshot?.analysisModel || '該当なし'}
- Response ID：${currentDecisionSnapshot?.analysisResponseId || '該当なし'}
- 分析生成時刻：${data.analysisGeneratedAt || '未記録'}

## 目的
${data.purpose || '未入力'}

- 対象業務：${data.target || '未入力'}
- 成功の確認方法：${data.successMetric || '未入力'}
- 最終決定者：${data.decisionMaker || '未入力'}
- 制約：${data.constraints || '未入力'}

## 確認済み情報
${verifiedFacts.length ? verifiedFacts.map((fact) => `- [${fact.category}] ${fact.statement}${fact.source ? `（情報源：${fact.source}）` : ''}`).join('\n') : '- なし'}

## 一部確認情報
${partialFacts.length ? partialFacts.map((fact) => `- [${fact.category} / 一部確認] ${fact.statement}${fact.source ? `（情報源：${fact.source}）` : ''}`).join('\n') : '- なし'}

## 未確認情報・仮説
${openFacts.length ? openFacts.map((fact) => `- [${fact.category} / ${fact.status}] ${fact.statement}（情報源：${fact.source || '未入力'}、更新：${fact.updatedAt || '未記録'}${fact.metric ? `、数値・期間：${fact.metric}` : ''}）`).join('\n') : '- なし'}

## 比較した問題候補
| 扱い | 評価状態 | 問題候補 | 影響度 | 発生頻度 | 根拠 | 実行可能性 | 参考値 |
|---|---|---|---:|---:|---:|---:|---:|
${problemComparisonRows || '| 未選択 | 未確認 | 候補なし | - | - | - | - | - |'}

- 選択候補の参考値：${problemScore}
- 算式：${PRIORITY_SCORING_RULE}

## 選んだ問題に対応する課題候補
${taskComparisonRows || '- 候補なし'}

## 選択候補が参照した根拠
${decisionEvidenceFacts.length ? decisionEvidenceFacts.map((fact) => `- [${fact.category} / ${fact.status}] ${fact.statement}（情報源：${fact.source || '未入力'}、更新：${fact.updatedAt || '未記録'}${fact.metric ? `、数値・期間：${fact.metric}` : ''}）`).join('\n') : '- なし'}

## ${decisionHeading}
- 判断：${data.decision.status}
- 最終問題文：${data.decision.finalProblem || '未入力'}
- 最終課題文：${data.decision.finalTask || '未入力'}
- 期待する状態：${data.decision.expectedOutcome || '未入力'}
- 判断理由：${data.decision.reason || '未入力'}
- 決定者：${data.decision.decidedBy || '未入力'}
- 決定日：${data.decision.decidedAt || '未入力'}
- 見直し日：${data.decision.nextReview || '未入力'}

## ${actionHeading}
${data.decision.nextAction || '未入力'}

---
このレポートは判断材料を整理したものです。最終判断と責任は決定者にあります。
`;
  })();

  const copyReport = async () => {
    if (!reportReady) {
      setToast('人間の判断を確定するまで、正式レポートはコピーできません。');
      return;
    }
    try {
      await navigator.clipboard.writeText(reportMarkdown);
      setToast('Markdownレポートをコピーしました。');
    } catch {
      setToast('コピーできませんでした。テキストを選択してコピーしてください。');
    }
  };

  const downloadReport = () => {
    if (!reportReady) {
      setToast('人間の判断を確定するまで、正式レポートは保存できません。');
      return;
    }
    const blob = new Blob([reportMarkdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const safeName = (data.projectName || 'decision-report').replace(/[<>:"/\\|?*]/g, '_');
    anchor.href = url;
    anchor.download = `${safeName}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setToast('Markdownファイルを保存しました。');
  };

  const downloadJson = (content: string, fileName: string) => {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadProjectBackup = () => {
    const safeName = (data.projectName || 'decision-canvas-project').replace(/[<>:"/\\|?*]/g, '_');
    downloadJson(JSON.stringify({
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      project: data,
    }, null, 2), `${safeName}-backup.json`);
    setToast('案件の入力・候補・正式履歴をJSONで保存しました。');
  };

  const downloadRecoveryRaw = () => {
    if (!recoveryRaw) return;
    downloadJson(recoveryRaw, `decision-canvas-recovery-${Date.now()}.json`);
    setToast('読み込めなかった原本を変更せず保存しました。');
  };

  const importProjectBackup = async (event: ChangeEvent<HTMLInputElement>) => {
    cancelPendingAi();
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!canSwitchProject) {
      setToast('現在の案件の保存が完了してからバックアップを読み込んでください。');
      return;
    }
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const candidate = parsed && typeof parsed === 'object' && 'project' in parsed
        ? (parsed as Record<string, unknown>).project
        : parsed;
      if (!candidate || typeof candidate !== 'object') throw new Error('invalid backup');
      assertSupportedSchema(candidate);
      const restored = migrateProject(candidate);
      const project: ProjectData = {
        ...restored,
        projectId: createBlankProject().projectId,
        projectName: `${restored.projectName || '名称未設定の案件'}（復元）`,
        decision: restored.decision.status === '未決定'
          ? restored.decision
          : { ...restored.decision, needsReview: true },
      };
      activateProject(project, 0, '');
      setToast('バックアップを別案件として復元しました。元の案件は変更していません。');
    } catch {
      setToast('バックアップを読み込めませんでした。ファイルは変更していません。');
    }
  };

  const hasProjectContent = Boolean(
    data.projectName ||
    data.target ||
    data.purpose ||
    data.successMetric ||
    data.decisionMaker ||
    data.constraints ||
    data.facts.length ||
    data.problems.length ||
    data.tasks.length ||
    data.decision.problemId ||
    data.decision.taskId ||
    data.decision.status !== '未決定' ||
    data.decision.finalProblem ||
    data.decision.finalTask ||
    data.decision.reason ||
    data.decisionHistory.length ||
    data.draftHistory.length,
  );
  const hasUnsavedChanges = hydrated && JSON.stringify(data) !== persistedJson;
  const canSwitchProject = hydrated && !storageConflict && !saveError && !hasUnsavedChanges;

  const activateProject = (
    project: ProjectData,
    revision: number,
    persistedJson: string,
    persistedAt = '',
  ) => {
    cancelPendingAi();
    setAiRunState({ state: 'idle', message: '' });
    setVerifiedAiResponseIds(new Set());
    revisionRef.current = revision;
    lastPersistedJsonRef.current = persistedJson;
    setPersistedJson(persistedJson);
    setData(project);
    setActiveStep('purpose');
    setFactFilter('すべて');
    setLastDeleted(null);
    setReviewConfirmed(false);
    setStorageConflict(false);
    setConflictCopyId('');
    setConflictCopyError(false);
    automaticConflictCopyRef.current = null;
    setSaveError(false);
    setRecoveryRaw('');
    setSavedAt(formatSavedTime(persistedAt));
    if (!safeSessionSet(SESSION_PROJECT_KEY, project.projectId)) {
      setSessionWarning(true);
    }
  };

  const startNewProject = () => {
    cancelPendingAi();
    if (hasProjectContent && !canSwitchProject) {
      setToast('現在の案件が未保存または競合中です。保存完了を待つか、競合コピーとして救出してください。');
      return;
    }
    const project = createBlankProject();
    activateProject(project, 0, '');
    setToast('新しい空の案件を開始しました。前の案件は案件一覧に保存されています。');
  };
  const loadSample = () => {
    cancelPendingAi();
    if (hasProjectContent && !canSwitchProject) {
      setToast('現在の案件が未保存または競合中です。保存完了を待つか、競合コピーとして救出してください。');
      return;
    }
    const project = createSampleProject();
    activateProject(project, 0, '');
    setToast('操作確認用サンプルを別案件として開きました。');
  };

  const openStoredProject = (projectId: string) => {
    cancelPendingAi();
    if (projectId === data.projectId) return;
    if (!canSwitchProject) {
      setToast('現在の案件の保存が完了してから切り替えてください。');
      return;
    }
    let raw = '';
    try {
      raw = window.localStorage.getItem(projectStorageKey(projectId)) ?? '';
      if (!raw) throw new Error('missing project');
      const envelope = parseEnvelope(raw);
      assertSupportedSchema(envelope.project);
      const project = migrateProject(envelope.project);
      if (project.projectId !== projectId) throw new Error('project id mismatch');
      activateProject(project, envelope.revision, JSON.stringify(envelope.project), envelope.savedAt);
      window.localStorage.setItem(LAST_PROJECT_KEY, project.projectId);
      setToast(`「${project.projectName || '名称未設定の案件'}」を開きました。`);
    } catch {
      if (raw) setRecoveryRaw(raw);
      setToast('選択した案件を読み込めませんでした。元の保存データは変更していません。');
    }
  };

  const saveConflictAsCopy = () => {
    cancelPendingAi();
    const copyId = createBlankProject().projectId;
    const copy: ProjectData = {
      ...data,
      projectId: copyId,
      projectName: `${data.projectName || '名称未設定の案件'}（競合コピー）`,
      decision: data.decision.status === '未決定'
        ? data.decision
        : { ...data.decision, needsReview: true },
    };
    activateProject(copy, 0, '');
    setToast('現在の画面入力を別案件として救出しました。自動保存を再開します。');
  };

  const openAutomaticConflictCopy = async () => {
    cancelPendingAi();
    if (!conflictCopyId) return;
    const latestCopyId = await rescueConflictInputLocked(data);
    if (!latestCopyId) return;
    let raw = '';
    try {
      raw = window.localStorage.getItem(projectStorageKey(latestCopyId)) ?? '';
      if (!raw) throw new Error('missing conflict copy');
      const envelope = parseEnvelope(raw);
      assertSupportedSchema(envelope.project);
      const project = migrateProject(envelope.project);
      if (project.projectId !== latestCopyId) throw new Error('project id mismatch');
      activateProject(project, envelope.revision, JSON.stringify(envelope.project), envelope.savedAt);
      setToast('自動退避した競合コピーを開きました。元案件と別に編集できます。');
    } catch {
      if (raw) setRecoveryRaw(raw);
      setToast('自動退避した競合コピーを読み込めませんでした。現在の画面入力は保持しています。');
    }
  };

  const loadLatestStoredVersion = () => {
    cancelPendingAi();
    if (!window.confirm('現在の未保存入力を破棄し、別タブで保存された最新版を読み込みますか？')) return;
    let raw = '';
    try {
      raw = window.localStorage.getItem(projectStorageKey(data.projectId)) ?? '';
      if (!raw) throw new Error('missing project');
      const envelope = parseEnvelope(raw);
      assertSupportedSchema(envelope.project);
      const project = migrateProject(envelope.project);
      if (project.projectId !== data.projectId) throw new Error('project id mismatch');
      activateProject(project, envelope.revision, JSON.stringify(envelope.project), envelope.savedAt);
      setToast('保存済みの最新版を読み込みました。');
    } catch {
      if (raw) setRecoveryRaw(raw);
      setToast('保存済みの最新版を読み込めませんでした。現在の画面入力は保持しています。');
    }
  };
  const projectOptions = [
    {
      projectId: data.projectId,
      projectName: data.projectName,
      updatedAt: savedAt,
    },
    ...projectIndex.filter((item) => item.projectId !== data.projectId),
  ];

  const renderDecisionHistory = () => {
    if (!latestDecisionHistory && !data.draftHistory.length) return null;
    return (
      <div className="history-stack">
        {latestDecisionHistory && (
          <details className="archived-decision">
            <summary>正式に確定した判断履歴（{data.decisionHistory.length}件）</summary>
            <div className="decision-history-list">
              {data.decisionHistory.map((entry) => (
                <article key={entry.id}>
                  <span>{entry.decision.decidedAt || '日付未記録'} / {entry.decision.status}</span>
                  <h3>{entry.decision.finalProblem}</h3>
                  <p>{entry.decision.finalTask}</p>
                  <blockquote>{entry.decision.reason}</blockquote>
                  <small>確定時の判断材料 {entry.facts.length}件 / 比較候補 {entry.problems.length}件 / 根拠確度 {evidenceGrade(entry.problem.evidence)} / 生成 {analysisSourceLabel(entry.analysisSource, entry.analysisResponseId)}{entry.analysisSource === 'openai' && entry.analysisModel ? `・${entry.analysisModel}` : ''} / 記録 {formatRecordedAt(entry.recordedAt)}{entry.snapshotVersion === 1 ? ' / 旧形式（部分保存）' : ''}</small>
                </article>
              ))}
              <small>確定時点の内容を固定保存しています。現在の正式レポートには、現在選択中の確定判断だけを使用します。</small>
            </div>
          </details>
        )}
        {data.draftHistory.length > 0 && (
          <details className="archived-decision draft-history">
            <summary>再確認用の旧下書き（{data.draftHistory.length}件）</summary>
            <div className="decision-history-list">
              {data.draftHistory.map((entry, index) => (
                <article key={`${entry.decidedAt}-${entry.finalProblem}-${index}`}>
                  <span>正式未確定 / {entry.status}</span>
                  <h3>{entry.finalProblem || '問題文未入力'}</h3>
                  <p>{entry.finalTask || '課題文未入力'}</p>
                  <blockquote>{entry.reason || '判断理由未入力'}</blockquote>
                </article>
              ))}
              <small>この欄は再入力の参考であり、正式な判断記録ではありません。</small>
            </div>
          </details>
        )}
      </div>
    );
  };

  const renderPurpose = () => (
    <div className="content-stack">
      <section className="purpose-callout">
        <div className="callout-mark" aria-hidden="true">◎</div>
        <div>
          <p className="callout-label">固定する中心</p>
          <p className="purpose-quote">{data.purpose || 'まず、何のための判断かを入力してください。'}</p>
        </div>
      </section>
      <section className="form-card" aria-labelledby="purpose-form-title">
        <div className="section-heading">
          <div><p className="section-kicker">DECISION BRIEF</p><h2 id="purpose-form-title">案件の前提</h2></div>
          <span className="section-note">自動保存</span>
        </div>
        <div className="form-grid two-columns">
          <label className="field field-wide"><span>案件名</span><input value={data.projectName} placeholder="例：問い合わせ一次回答の遅延改善" onChange={(event) => updateProjectField('projectName', event.target.value)} /></label>
          <label className="field field-wide"><span>対象業務 <b>必須</b></span><textarea rows={2} value={data.target} placeholder="誰の、どの業務を扱うか" onChange={(event) => updateProjectField('target', event.target.value)} /></label>
          <label className="field field-wide"><span>目的 <b>必須</b></span><textarea rows={3} value={data.purpose} placeholder="何を改善し、どの状態をつくるか" onChange={(event) => updateProjectField('purpose', event.target.value)} /></label>
          <label className="field"><span>成功の確認方法 <b>採用時必須</b></span><textarea rows={3} value={data.successMetric} placeholder="指標・期間・目標値" onChange={(event) => updateProjectField('successMetric', event.target.value)} /></label>
          <label className="field"><span>最終決定者 <b>必須</b></span><input value={data.decisionMaker} placeholder="役職または担当者" onChange={(event) => updateProjectField('decisionMaker', event.target.value)} /></label>
          <label className="field field-wide"><span>制約</span><textarea rows={2} value={data.constraints} placeholder="時間、予算、情報管理、既存環境など" onChange={(event) => updateProjectField('constraints', event.target.value)} /></label>
        </div>
      </section>
    </div>
  );

  const renderFacts = () => (
    <div className="content-stack">
      <section className="classification-strip" aria-label="7分類の意味">
        {CATEGORIES.map((category) => (
          <div key={category}><span className={`category-badge ${CATEGORY_META[category].className}`}>{category}</span><small>{CATEGORY_META[category].explanation}</small></div>
        ))}
      </section>
      <form className="fact-entry" onSubmit={addFact}>
        <div className="section-heading"><div><p className="section-kicker">ADD EVIDENCE</p><h2>判断材料を1件追加</h2></div><span className="section-note">事実と仮説を分ける</span></div>
        <div className="fact-entry-grid">
          <label className="field"><span>分類</span><select value={factDraft.category} onChange={(event) => setFactDraft((current) => ({ ...current, category: event.target.value as Category }))}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="field fact-statement"><span>内容</span><textarea ref={addFactRef} rows={2} placeholder="現在、何が起きているかを具体的に記述" value={factDraft.statement} onChange={(event) => setFactDraft((current) => ({ ...current, statement: event.target.value }))} /></label>
          <label className="field"><span>確認状態</span><select value={factDraft.status} onChange={(event) => setFactDraft((current) => ({ ...current, status: event.target.value as EvidenceStatus }))}><option>確認済み</option><option>一部確認</option><option>未確認</option><option>仮説</option></select></label>
          <label className="field"><span>情報源</span><input placeholder="観察、記録、担当者など" value={factDraft.source} onChange={(event) => setFactDraft((current) => ({ ...current, source: event.target.value }))} /></label>
          <label className="field fact-metric"><span>数値・期間（任意）</span><input placeholder="例：月18件 / 1件あたり7分" value={factDraft.metric} onChange={(event) => setFactDraft((current) => ({ ...current, metric: event.target.value }))} /></label>
          <button className="primary-button add-fact-button" type="submit">＋ 追加する</button>
        </div>
      </form>
      <section className="facts-section">
        <div className="section-heading fact-list-heading">
          <div><p className="section-kicker">EVIDENCE REGISTER</p><h2>登録情報 <span>{data.facts.length}件</span></h2></div>
          <div className="filter-row" aria-label="分類で絞り込む">
            <button className={factFilter === 'すべて' ? 'filter-chip active' : 'filter-chip'} onClick={() => setFactFilter('すべて')} type="button">すべて <span>{data.facts.length}</span></button>
            {CATEGORIES.map((category) => <button key={category} type="button" className={factFilter === category ? 'filter-chip active' : 'filter-chip'} onClick={() => setFactFilter(category)}>{category} <span>{factsByCategory[category]}</span></button>)}
          </div>
        </div>
        {!filteredFacts.length ? (
          <div className="empty-state"><span aria-hidden="true">＋</span><h3>判断材料はまだありません</h3><p>まず「現状」を1件追加し、確認状態と情報源を記録してください。</p></div>
        ) : (
          <div className="fact-list">
            {filteredFacts.map((fact) => {
              const meta = CATEGORY_META[fact.category];
              return (
                <article className="fact-card" key={fact.id}>
                  <div className="fact-card-topline"><div className="fact-labels"><span className={`category-badge ${meta.className}`}>{fact.category}</span><span className="kind-badge">{meta.kind}</span>{fact.generatedBy === 'rule' && <span className="rule-badge">自動整理</span>}</div><button className="icon-button danger" type="button" aria-label={`${fact.statement}を削除`} onClick={() => deleteFact(fact.id)}>削除</button></div>
                  <textarea className="fact-content-input" rows={2} value={fact.statement} onChange={(event) => updateFact(fact.id, { statement: event.target.value })} aria-label={`${fact.category}の内容`} />
                  <div className="fact-card-meta">
                    <label><span>分類</span><select value={fact.category} onChange={(event) => updateFact(fact.id, { category: event.target.value as Category })}>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
                    <label><span>確認状態</span><select value={fact.status} onChange={(event) => updateFact(fact.id, { status: event.target.value as EvidenceStatus })}><option>確認済み</option><option>一部確認</option><option>未確認</option><option>仮説</option></select></label>
                    <label><span>情報源</span><input value={fact.source} placeholder="未入力" onChange={(event) => updateFact(fact.id, { source: event.target.value })} /></label>
                    <label><span>数値・期間</span><input value={fact.metric} placeholder="未入力" onChange={(event) => updateFact(fact.id, { metric: event.target.value })} /></label>
                    <span className="updated-date">更新 {fact.updatedAt || '未記録'}</span>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );

  const renderProblems = () => (
    <div className="content-stack">
      <section className="analysis-toolbar ai-analysis-toolbar" aria-busy={aiRunState.state === 'loading'}>
        <div><span className="mode-chip">OPENAI API</span><h2>AIで問題・課題候補を作る</h2><p id="ai-send-disclosure">押した時だけ、目的・対象業務・成功条件・制約・入力済みの判断材料をOpenAIへ送信します。案件名・決定者・正式履歴は送りません。個人情報・機密情報を含めないでください。</p><small>送信対象：判断材料 {data.facts.length}件 / 候補は下書きで、最終判断は人間が行います。</small></div>
        <div className="analysis-action-stack"><button className="primary-button" type="button" onClick={() => void runAiAnalysis()} disabled={!canAnalyze || aiRunState.state === 'loading'} aria-describedby="ai-send-disclosure">{aiRunState.state === 'loading' ? 'AIが生成中…' : 'AIで候補を生成'}</button><button className="secondary-button compact-button" type="button" onClick={runRuleAnalysis} disabled={!canAnalyze || aiRunState.state === 'loading'}>端末内のルールで生成</button></div>
      </section>
      {aiRunState.state === 'loading' && <div className="analysis-run-status loading" role="status" aria-live="polite"><strong>AIが候補を生成中です</strong><span>入力内容は自動送信されず、この操作で指定した範囲だけを送っています。</span></div>}
      {aiRunState.state === 'error' && <div className="analysis-run-status error" role="alert"><strong>AI結果を反映しませんでした</strong><span>{aiRunState.message}</span></div>}
      {analysisCurrent && data.analysisSource === 'openai' && isVerifiedAiSource(data.analysisSource, data.analysisResponseId) && <div className="analysis-run-status success" role="status" aria-live="polite"><strong>AI生成 · {data.analysisModel}</strong><span>{formatRecordedAt(data.analysisGeneratedAt)} JST / Response ID {data.analysisResponseId}{data.analysisUsage ? ` / ${data.analysisUsage.totalTokens.toLocaleString('ja-JP')} tokens` : ''}</span></div>}
      {analysisCurrent && data.analysisSource === 'openai' && !isVerifiedAiSource(data.analysisSource, data.analysisResponseId) && <div className="analysis-run-status fallback" role="status" aria-live="polite"><strong>保存データ上のAI記録（由来未検証）</strong><span>この画面で受信した記録ではないため、モデル名とResponse IDの真正性は保証しません。</span></div>}
      {analysisCurrent && data.analysisSource === 'rule' && data.analysisFallbackReason && <div className="analysis-run-status fallback" role="alert"><strong>AI接続を使えなかったため、ルール版を使用</strong><span>{aiRunState.message || `理由コード：${data.analysisFallbackReason}`}</span></div>}
      {analysisCurrent && data.analysisSource === 'rule' && !data.analysisFallbackReason && <div className="analysis-run-status rule" role="status"><strong>端末内のルールで生成</strong><span>{formatRecordedAt(data.analysisGeneratedAt)} JST / 外部送信なし</span></div>}
      {!canAnalyze && <div className="analysis-required" role="status"><strong>候補を作るための判断材料が不足しています。</strong><span>不足：{missingForAnalysis.join('・')}</span></div>}
      <section className="formula-card">
        <button className="formula-toggle" type="button" aria-expanded={showFormula} onClick={() => setShowFormula((current) => !current)}><span><strong>参考値の計算方法</strong> — 重みと内訳を公開</span><span aria-hidden="true">{showFormula ? '−' : '＋'}</span></button>
        {showFormula && <div className="formula-detail"><code>影響度 35% ＋ 発生頻度 25% ＋ 根拠 25% ＋ 実行可能性 15%</code><p>各項目は1〜5。最低値を0、最高値を100として換算します。数値は比較補助であり、判断そのものではありません。</p></div>}
      </section>
      {!analysisCurrent ? (
        <div className="empty-state analysis-empty"><span aria-hidden="true">↻</span><h3>現在の情報に対応する候補はありません</h3><p>{canAnalyze ? '「問題・課題候補を生成」を押すと、古い候補を混ぜずに作り直します。' : '不足している入力を追加してください。'}</p></div>
      ) : (
        <div className="problem-list">
          {rankedProblems.map((problem, index) => {
            const score = priorityScore(problem);
            const selected = data.decision.problemId === problem.id;
            const evidence = data.facts.filter((fact) => problem.evidenceIds.includes(fact.id));
            const reviewedRank = rankedProblems
              .slice(0, index + 1)
              .filter((candidate) => candidate.scoresReviewed).length;
            return (
              <article key={problem.id} className={`problem-card${selected ? ' selected' : ''}`}>
                <div className="problem-rank"><span className="rank-number">{problem.scoresReviewed ? String(reviewedRank).padStart(2, '0') : '—'}</span><span className="rank-label">{problem.scoresReviewed ? '確認済み順位' : '評価未確認'}</span></div>
                <div className="problem-main">
                  <div className="problem-heading-row"><div><div className="candidate-labels"><span className="candidate-label">{data.analysisSource === 'openai' ? (isVerifiedAiSource(data.analysisSource, data.analysisResponseId) ? 'AI生成の下書き' : '保存済みAI下書き（由来未検証）') : 'ルール生成の下書き'}</span>{problem.provisional && <span className="verify-label">要検証</span>}</div><h3>{problem.title}</h3><p>{problem.description}</p></div><div className={`score-box${problem.scoresReviewed ? '' : ' unreviewed'}`} aria-label={problem.scoresReviewed ? `確認済み参考値 ${score}点` : '人間による評価未確認'}><strong>{problem.scoresReviewed ? score : '—'}</strong><span>{problem.scoresReviewed ? '/ 100' : ''}</span><small>{problem.scoresReviewed ? '確認済み参考値' : '評価未確認'}</small></div></div>
                  <div className="score-grid">
                    {([['impact', '影響度', problem.impact], ['frequency', '発生頻度', problem.frequency], ['feasibility', '実行可能性', problem.feasibility]] as const).map(([key, label, value]) => <label className="score-control" key={key}><span><b>{label}</b><strong>{value}</strong></span><input type="range" min="1" max="5" step="1" value={value} onChange={(event) => updateProblemScore(problem.id, key, Number(event.target.value))} /><span className="range-labels"><i>1</i><i>5</i></span></label>)}
                    <div className="score-readonly"><span><b>根拠確度</b><strong>{problem.evidence}</strong></span><p>確認状態から自動算出。手動変更できません。</p></div>
                  </div>
                  <label className="score-review-check"><input type="checkbox" checked={problem.scoresReviewed} onChange={(event) => setProblemScoresReviewed(problem.id, event.target.checked)} /><span>影響度・発生頻度・実行可能性の初期値を人間が確認しました</span></label>
                  <details className="source-evidence-list"><summary>この候補へ対応付ける根拠を選択（{evidence.length}件）</summary><p>候補の起点は固定です。関連する現状・理想・原因などを、人間が確認して追加してください。</p><div className="evidence-picker">{data.facts.map((fact) => { const source = fact.id === problem.evidenceIds[0]; const checked = problem.evidenceIds.includes(fact.id); return <label key={fact.id}><input type="checkbox" checked={checked} disabled={source} onChange={(event) => toggleProblemEvidence(problem.id, fact.id, event.target.checked)} /><span><b>{fact.category} / {fact.status}{source ? ' / 候補の起点' : ''}</b><em>{fact.statement}</em><small>情報源：{fact.source || '未入力'}{fact.metric ? ` / 数値・期間：${fact.metric}` : ''}</small></span></label>; })}</div></details>
                  <div className="problem-footer"><div className="evidence-summary"><span className={`evidence-grade grade-${evidenceGrade(problem.evidence).toLowerCase()}`}>{evidenceGrade(problem.evidence)}</span><span>根拠確度<small>{problem.evidenceIds.length}件を参照</small></span></div><button className={selected ? 'selection-button selected' : 'selection-button'} type="button" disabled={!problem.scoresReviewed} onClick={() => selectProblem(problem)}>{selected ? '✓ 下書きに選択中' : problem.scoresReviewed ? 'この候補を下書きにする' : '評価を確認して選ぶ'}</button></div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <p className="human-note"><span aria-hidden="true">人</span>比較順位と異なる候補も選べます。確定は次の画面で、人間が問題文と課題文を確認して行います。</p>
    </div>
  );

  const renderDecision = () => (
    <div className="content-stack">
      {renderDecisionHistory()}
      {!analysisCurrent && <div className="stale-warning" role="alert"><strong>現在の情報に対応する候補がありません</strong><span>問題発見へ戻り、候補を生成してください。</span></div>}
      <section className="selected-problem-summary"><div><p className="section-kicker">SELECTED DRAFT</p><h2>{selectedProblem?.title || '問題候補が選択されていません'}</h2><p>{selectedProblem?.description || '前のステップで「この候補を下書きにする」を選んでください。'}</p></div>{selectedProblem && <div className="selected-score"><span>比較参考値</span><strong>{priorityScore(selectedProblem)}</strong><small>根拠 {evidenceGrade(selectedProblem.evidence)}</small></div>}</section>
      <section>
        <div className="section-heading"><div><p className="section-kicker">TASK OPTIONS</p><h2>選んだ問題に対応する課題候補</h2></div><span className="section-note">下書きを1件選択</span></div>
        {!selectedProblem ? <div className="empty-state"><span aria-hidden="true">←</span><h3>先に問題候補を選んでください</h3><p>問題を選ぶと、その根拠から作った課題候補だけを表示します。</p></div> : <div className="task-grid">{availableTasks.map((task) => { const selected = data.decision.taskId === task.id; return <button type="button" key={task.id} className={`task-card${selected ? ' selected' : ''}`} onClick={() => selectTask(task.id)}><span className="task-select-mark" aria-hidden="true">{selected ? '●' : '○'}</span><span className="task-card-content"><strong>{task.title}</strong><span>{task.outcome}</span><span className="task-meta-row"><i>{task.effort}</i><i>{task.risk}</i></span><small>最初の行動：{task.firstAction}</small></span></button>; })}</div>}
      </section>
      <section className="decision-form-card">
        <div className="section-heading"><div><p className="section-kicker">HUMAN DECISION</p><h2>最終問題文と課題文を人間が整える</h2></div><span className="human-only-badge">人間のみが確定</span></div>
        <div className="definition-note"><p><b>問題</b>：現在と理想の差として起きていること</p><p><b>課題</b>：その問題を解くために取り組むこと</p></div>
        <div className="form-grid two-columns final-wording-grid">
          <label className="field field-wide"><span>最終問題文 <b>必須</b></span><textarea rows={3} value={data.decision.finalProblem} placeholder="何が、誰に、どのような不都合を生じさせているか" onChange={(event) => updateDecision({ finalProblem: event.target.value })} /></label>
          <label className="field field-wide"><span>最終課題文 <b>必須</b></span><textarea rows={3} value={data.decision.finalTask} placeholder="誰が、何を、どの状態へ変えるか" onChange={(event) => updateDecision({ finalTask: event.target.value })} /></label>
          <label className="field"><span>期待する状態</span><textarea rows={3} value={data.decision.expectedOutcome} onChange={(event) => updateDecision({ expectedOutcome: event.target.value })} /></label>
          <label className="field"><span>次の行動・確認事項 <b>必須</b></span><textarea rows={3} value={data.decision.nextAction} onChange={(event) => updateDecision({ nextAction: event.target.value })} /></label>
        </div>
        <fieldset className="decision-status-group"><legend>この課題案の扱い</legend>{(['採用', '保留', '却下'] as DecisionStatus[]).map((status) => <label key={status} className={data.decision.status === status ? 'active' : ''}><input type="radio" name="decision-status" value={status} checked={data.decision.status === status} onChange={() => updateDecision({ status })} />{status}</label>)}</fieldset>
        <div className="form-grid two-columns">
          <label className="field field-wide"><span>判断理由 <b>必須</b></span><textarea rows={3} value={data.decision.reason} onChange={(event) => updateDecision({ reason: event.target.value })} /></label>
          <label className="field"><span>決定者</span><input value={data.decision.decidedBy} placeholder={data.decisionMaker || '役職または担当者'} onChange={(event) => updateDecision({ decidedBy: event.target.value })} /></label>
          <label className="field"><span>決定日</span><input type="date" value={data.decision.decidedAt} onChange={(event) => updateDecision({ decidedAt: event.target.value })} /></label>
          <label className="field"><span>見直し日 <b>保留時必須</b></span><input type="date" value={data.decision.nextReview} onChange={(event) => updateDecision({ nextReview: event.target.value })} /></label>
        </div>
        <details className="decision-evidence-review" open>
          <summary>確定前に確認する根拠と未確認情報</summary>
          <h3>問題候補が参照した根拠</h3>
          <ul>{selectedEvidenceFacts.map((fact) => <li key={fact.id}><b>{fact.category} / {fact.status}</b><span>{fact.statement}</span><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</li>)}</ul>
          <h3>課題候補が参照した根拠</h3>
          <ul>{selectedTaskEvidenceFacts.map((fact) => <li key={fact.id}><b>{fact.category} / {fact.status}</b><span>{fact.statement}</span><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</li>)}</ul>
          <h3>案件内に残る未確認情報・仮説</h3>
          {openFacts.length ? <ul>{openFacts.map((fact) => <li key={fact.id}><b>{fact.category} / {fact.status}</b><span>{fact.statement}</span><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</li>)}</ul> : <p>未確認情報・仮説はありません。</p>}
        </details>
        <label className="review-check"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} /><span>問題・課題候補の根拠、数値の単位・期間・対象範囲、および案件内に未確認情報が{openFacts.length}件残っていることを確認しました。</span></label>
        <button className="confirm-button" type="button" onClick={confirmDecision}><span aria-hidden="true">✓</span>人間の判断として確定し、レポートへ</button>
      </section>
    </div>
  );

  const renderReport = () => {
    if (!reportReady) {
      return (
        <div className="content-stack">
          <div className="stale-warning" role="alert"><strong>正式レポートはまだ作成できません</strong><span>{data.decision.needsReview ? '判断内容を再確認し、もう一度確定してください。' : '問題候補・課題候補を選び、人間の判断として確定してください。'}</span></div>
          <div className="empty-state report-locked"><span aria-hidden="true">人</span><h3>確定後にコピー・保存できます</h3><p>未決定・編集中・再確認中の内容を、正式な意思決定記録として持ち出すことはできません。</p><button className="primary-button" type="button" onClick={() => setActiveStep('decision')}>課題設定へ戻る</button></div>
          {renderDecisionHistory()}
        </div>
      );
    }

    const taskHeading = data.decision.status === '採用' ? '人間が決めた課題' : '人間が検討した課題案';
    const actionHeading = data.decision.status === '採用' ? '判断理由と次の行動' : '判断理由と今後の対応';
    return (
      <div className="content-stack">
        <section className="report-actions"><div><span className="report-status-dot" /><span>人間が確定した正式記録</span></div><div><button className="secondary-button" type="button" onClick={copyReport}>コピー</button><button className="primary-button" type="button" onClick={downloadReport}>Markdown保存</button></div></section>
        <article className="report-paper">
          <header className="report-cover"><div><p>DECISION BRIEF / {data.decision.decidedAt}</p><h2>{data.projectName || '意思決定レポート'}</h2><span>{data.target}</span></div><div className="report-decision-stamp"><span>人間の判断</span><strong>{data.decision.status}</strong></div></header>
          <div className="report-record-meta"><span>記録ID {currentDecisionSnapshot?.id}</span><span>確定 {currentDecisionSnapshot ? formatRecordedAt(currentDecisionSnapshot.recordedAt) : ''} JST</span><span>生成 {currentDecisionSnapshot ? analysisSourceLabel(currentDecisionSnapshot.analysisSource, currentDecisionSnapshot.analysisResponseId) : '未確定'}{currentDecisionSnapshot?.analysisSource === 'openai' && currentDecisionSnapshot.analysisModel ? ` / ${currentDecisionSnapshot.analysisModel}` : ''}</span><span>分析 {currentDecisionSnapshot?.analysisVersion}</span>{currentDecisionSnapshot?.analysisResponseId && <span>Response {currentDecisionSnapshot.analysisResponseId}</span>}</div>
          <section className="report-purpose"><span>目的</span><p>{data.purpose}</p></section>
          <div className="report-context-grid"><div><span>成功の確認方法</span><p>{data.successMetric || '未入力'}</p></div><div><span>制約</span><p>{data.constraints || 'なし'}</p></div><div><span>最終決定者</span><p>{data.decisionMaker}</p></div></div>
          <div className="report-stats"><div><strong>{verifiedFacts.length}</strong><span>確認済み</span></div><div><strong>{partialFacts.length + openFacts.length}</strong><span>一部確認・未確認・仮説</span></div><div><strong>{data.problems.filter((problem) => problem.scoresReviewed).length}/{data.problems.length}</strong><span>人間が評価確認した候補</span></div><div><strong>{selectedProblem ? priorityScore(selectedProblem) : '—'}</strong><span>選択候補の確認済み参考値</span></div></div>
          <section className="report-section"><div className="report-section-title"><span>01</span><h3>確認状態別の判断材料</h3></div><div className="report-fact-list">{verifiedFacts.map((fact) => <div key={fact.id}><span className={`category-badge ${CATEGORY_META[fact.category].className}`}>{fact.category} / 確認済み</span><p>{fact.statement}</p><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</div>)}{partialFacts.map((fact) => <div key={fact.id}><span className={`category-badge ${CATEGORY_META[fact.category].className}`}>{fact.category} / 一部確認</span><p>{fact.statement}</p><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</div>)}</div></section>
          <section className="report-section"><div className="report-section-title"><span>02</span><h3>問題候補と、選択した問題に対応する課題候補</h3></div><div className="report-comparison-wrap"><table className="report-comparison-table"><thead><tr><th>扱い</th><th>評価状態</th><th>問題候補</th><th>影響</th><th>頻度</th><th>根拠（自動）</th><th>実行</th><th>参考値</th></tr></thead><tbody>{rankedProblems.map((problem) => <tr key={problem.id} className={problem.id === selectedProblem?.id ? 'selected' : ''}><td>{problem.id === selectedProblem?.id ? '選択' : '比較'}</td><td>{problem.scoresReviewed ? '人間確認済み' : '未確認'}</td><td>{problem.title}</td><td>{problem.scoresReviewed ? problem.impact : '—'}</td><td>{problem.scoresReviewed ? problem.frequency : '—'}</td><td>{problem.evidence} / {evidenceGrade(problem.evidence)}</td><td>{problem.scoresReviewed ? problem.feasibility : '—'}</td><td>{problem.scoresReviewed ? priorityScore(problem) : '—'}</td></tr>)}</tbody></table></div><h4 className="report-subheading">選択した問題に対応する課題候補</h4><div className="report-task-options">{availableTasks.map((task) => <article key={task.id} className={task.id === selectedTask?.id ? 'selected' : ''}><b>{task.id === selectedTask?.id ? '選択' : '比較'}</b><div><strong>{task.title}</strong><p>{task.outcome}</p><small>工数：{task.effort} / リスク：{task.risk}</small><small>最初の行動：{task.firstAction}</small><small>参照根拠：{task.evidenceIds.length}件</small></div></article>)}</div><h4 className="report-subheading">選択候補が参照した根拠</h4><div className="report-evidence-list">{decisionEvidenceFacts.map((fact) => <div key={fact.id}><b>{fact.category} / {fact.status}</b><span>{fact.statement}</span><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</div>)}</div></section>
          <section className="report-section split">
            <div><div className="report-section-title"><span>03</span><h3>人間が決めた問題</h3></div><div className="report-key-card problem"><span>最終問題文</span><h4>{data.decision.finalProblem}</h4><p className="report-reference">自動整理の候補：{selectedProblem?.title}</p>{selectedProblem && <div><b>{priorityScore(selectedProblem)}点</b> 比較参考値 / 根拠 {evidenceGrade(selectedProblem.evidence)}</div>}</div></div>
            <div><div className="report-section-title"><span>04</span><h3>{taskHeading}</h3></div><div className="report-key-card task"><span>最終課題文</span><h4>{data.decision.finalTask}</h4><p>{data.decision.expectedOutcome || '期待する状態は未入力です。'}</p><div><b>{data.decision.status}</b> / {data.decision.decidedBy}</div></div></div>
          </section>
          <section className="report-section"><div className="report-section-title"><span>05</span><h3>{actionHeading}</h3></div><blockquote>{data.decision.reason}</blockquote><div className="report-decision-details"><span>決定日：{data.decision.decidedAt || '未記録'}</span><span>見直し日：{data.decision.nextReview || (data.decision.status === '保留' ? '未入力' : '設定なし')}</span></div><div className="next-action"><span>{data.decision.status === '採用' ? 'NEXT ACTION' : 'FOLLOW-UP'}</span><strong>{data.decision.nextAction || '今後の対応は未入力です。'}</strong></div></section>
          <section className="report-section open-items"><div className="report-section-title"><span>06</span><h3>未確認情報・仮説</h3></div>{openFacts.length ? <ul>{openFacts.map((fact) => <li key={fact.id}><b>{fact.category} / {fact.status}</b><div><span>{fact.statement}</span><small>情報源：{fact.source || '未入力'} / 更新：{fact.updatedAt || '未記録'}</small>{fact.metric && <small>数値・単位・期間：{fact.metric}</small>}</div></li>)}</ul> : <p>未確認情報はありません。</p>}</section>
          <footer className="report-footer"><p>このレポートは判断材料を整理したものです。最終判断と責任は決定者にあります。</p><span>Decision Canvas / Local prototype</span></footer>
        </article>
      </div>
    );
  };

  const renderActiveStep = () => {
    if (activeStep === 'purpose') return renderPurpose();
    if (activeStep === 'facts') return renderFacts();
    if (activeStep === 'problems') return renderProblems();
    if (activeStep === 'decision') return renderDecision();
    return renderReport();
  };

  const goNext = () => {
    const next = STEPS[activeIndex + 1];
    if (next) setActiveStep(next.id);
  };
  const goPrevious = () => {
    const previous = STEPS[activeIndex - 1];
    if (previous) setActiveStep(previous.id);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block"><div className="brand-mark" aria-hidden="true"><span /><span /><span /></div><div><strong>Decision Canvas</strong><span>AI業務改善設計</span></div></div>
        <div className="project-title-block"><span>ACTIVE CASE</span><strong>{data.projectName || '新しい案件'}</strong><select aria-label="案件を切り替える" value={data.projectId} disabled={!canSwitchProject} onChange={(event) => openStoredProject(event.target.value)}>{projectOptions.map((project) => <option key={project.projectId} value={project.projectId}>{project.projectName || '名称未設定の案件'}</option>)}</select></div>
        <div className="topbar-actions"><div className={`save-status${storageConflict || saveError ? ' error' : ''}`} aria-live="polite"><span className="save-dot" /><span>{storageConflict ? (conflictCopyError ? '保存競合 — 自動退避失敗' : '保存競合 — 別案件へ継続退避') : saveError ? '保存失敗 — 画面入力は保持' : hasUnsavedChanges ? '端末へ保存中…' : savedAt ? `端末に保存済み ${savedAt}` : '端末内で準備中'}</span></div><div className="topbar-action-row"><button className="text-button" type="button" onClick={startNewProject}>新規案件</button><button className="text-button" type="button" onClick={loadSample}>サンプルを見る</button><button className="text-button" type="button" onClick={downloadProjectBackup}>バックアップ保存</button><button className="text-button" type="button" onClick={() => backupInputRef.current?.click()}>バックアップ読込</button><input ref={backupInputRef} hidden type="file" accept="application/json,.json" onChange={importProjectBackup} /></div></div>
      </header>
      <div className="privacy-bar"><div><span aria-hidden="true">⌂</span> 保存先：この端末</div><div><span aria-hidden="true">↗</span> AI生成時のみ：入力内容をOpenAIへ送信</div><div><span aria-hidden="true">人</span> 最終判断：担当者</div><div><span aria-hidden="true">↶</span> 自動バックアップ：案件ごと直近5世代</div></div>
      {storageConflict && <div className="storage-alert" role="alert"><div><strong>別のタブで同じ案件が更新されました</strong><span>{conflictCopyId && !conflictCopyError ? '現在と今後の入力は、元案件を上書きせず別案件へ継続退避します。' : '現在の入力は画面に残っていますが、自動退避できません。手動で別案件へ切り替えてください。'}</span></div>{conflictCopyId && !conflictCopyError ? <button type="button" onClick={openAutomaticConflictCopy}>最新の自動退避コピーを開く</button> : <button type="button" onClick={saveConflictAsCopy}>現在の入力を別案件として保存</button>}<button type="button" onClick={loadLatestStoredVersion}>元案件の保存版を読み込む</button></div>}
      {sessionWarning && <div className="storage-alert recovery" role="status"><div><strong>このタブの案件選択を記憶できません</strong><span>案件本体の端末保存は継続します。再読み込み後は、案件一覧から開き直してください。</span></div><button type="button" onClick={() => setSessionWarning(false)}>表示を閉じる</button></div>}
      {saveError && !storageConflict && <div className="storage-alert error" role="alert"><div><strong>端末へ保存できません</strong><span>入力は画面に残っています。容量やブラウザ設定を確認し、正式レポートはコピーして退避してください。</span></div></div>}
      {recoveryRaw && <div className="storage-alert recovery" role="alert"><div><strong>読み込めない保存原本があります</strong><span>原本は自動削除・上書きしていません。復旧用にそのまま保存できます。</span></div><button type="button" onClick={downloadRecoveryRaw}>原本を保存</button><button type="button" onClick={() => setRecoveryRaw('')}>表示を閉じる</button></div>}
      <div className="workspace-grid">
        <aside className="step-sidebar"><p className="sidebar-label">WORKFLOW</p><nav aria-label="業務改善設計の進行">{STEPS.map((step, index) => { const active = step.id === activeStep; const completed = stepCompleted[step.id]; return <button key={step.id} type="button" className={`step-button${active ? ' active' : ''}${completed ? ' completed' : ''}`} aria-current={active ? 'step' : undefined} onClick={() => setActiveStep(step.id)}><span className="step-number">{completed ? '✓' : step.number}</span><span><b>{step.label}</b><small>{index === 0 ? '目的と成功条件' : index === 1 ? 'ファクトと仮説' : index === 2 ? '比較と根拠' : index === 3 ? '人間の決定' : '共有用出力'}</small></span></button>; })}</nav><div className="sidebar-principle"><span aria-hidden="true">人</span><p><strong>判断は人間が行う</strong>このアプリは材料を整理し、比較可能にします。</p></div></aside>
        <section className="main-workspace">
          <header className="page-heading"><div><p>{activeMeta.eyebrow}</p><h1>{activeMeta.title}</h1><span>{activeMeta.description}</span></div><div className="stage-count"><strong>{activeMeta.number}</strong><span>/ 05</span></div></header>
          {renderActiveStep()}
          <footer className="workspace-footer"><button className="secondary-button" type="button" disabled={activeIndex === 0} onClick={goPrevious}>← 戻る</button><span>変更は端末内へ自動保存されます</span>{activeIndex < STEPS.length - 1 ? <button className="primary-button" type="button" onClick={goNext}>{activeStep === 'purpose' ? '環境情報を集める' : activeStep === 'facts' ? '問題候補を作る' : activeStep === 'problems' ? '問題文と課題文を決める' : 'レポートを見る'}<span aria-hidden="true">→</span></button> : <button className="secondary-button" type="button" onClick={() => setActiveStep('purpose')}>最初から見直す</button>}</footer>
        </section>
        <aside className="insight-rail">
          <section className="rail-card readiness-card"><div className="rail-heading"><div><p>入力と候補生成の進捗</p><strong>{passedChecks} / {checks.length}</strong></div><div className="readiness-ring" style={{ '--progress': `${(passedChecks / checks.length) * 360}deg` } as React.CSSProperties} aria-label={`${checks.length}項目中${passedChecks}項目を確認`}><span>{passedChecks}</span></div></div><div className="readiness-bar" aria-hidden="true"><span style={{ width: `${(passedChecks / checks.length) * 100}%` }} /></div><ul className="check-list">{checks.map((check) => <li key={check.label} className={check.passed ? 'passed' : ''}><span aria-hidden="true">{check.passed ? '✓' : '·'}</span>{check.label}</li>)}</ul></section>
          <section className="rail-card"><div className="rail-title-row"><p>情報の質</p><span>{analysisNotes.length}</span></div><div className="analysis-note-list">{analysisNotes.map((note) => <article key={note.title} className={`analysis-note ${note.tone}`}><span aria-hidden="true">{note.tone === 'warning' ? '!' : 'i'}</span><div><strong>{note.title}</strong><p>{note.body}</p></div></article>)}</div></section>
          <section className="rail-card purpose-rail-card"><p>固定した目的</p><blockquote>{data.purpose || 'まだ入力されていません。'}</blockquote><button type="button" onClick={() => setActiveStep('purpose')}>目的を見直す →</button></section>
          <section className="rail-card responsibility-card"><p>責任の分界</p><div><span>自動</span><b>整理・候補・比較</b></div><div><span>人間</span><b>目的・採否・責任</b></div></section>
        </aside>
      </div>
      {toast && <div className="toast" role="status" aria-live="polite"><span>{toast}</span>{lastDeleted && toast.includes('削除') && <button type="button" onClick={undoDelete}>取り消す</button>}<button type="button" aria-label="通知を閉じる" onClick={() => setToast('')}>×</button></div>}
    </main>
  );
}

export default DecisionWorkbench;
