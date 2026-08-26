import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
} from '../app/decision-engine.ts';
import {
  AiValidationError,
  aiRequestMatchesProject,
  createAiAnalysisRequest,
  normalizeAiAnalysis,
  validateAiAnalysisRequest,
  validateAiModelOutput,
} from '../app/ai-analysis.ts';

test('内部自動バックアップは案件ごとに直近5世代を残す', () => {
  const prefix = 'decision-canvas-backup-v3:project-1:';
  const keys = [
    `${prefix}1000-a`,
    `${prefix}2000-b`,
    `${prefix}3000-c`,
    `${prefix}4000-d`,
    `${prefix}5000-e`,
    'decision-canvas-backup-v3:project-2:1000-z',
  ];
  assert.deepEqual(boundedBackupKeysToRemove(keys, prefix, 5), [`${prefix}1000-a`]);
  assert.deepEqual(boundedBackupKeysToRemove(keys.slice(0, 4), prefix, 5), []);
});

test('自動競合コピーは同じタブだけが更新し、別タブが触れたコピーは新しい案件へ分岐する', () => {
  assert.deepEqual(
    resolveConflictCopyWriteTarget('copy-1', 4, 4, 'writer-a', 'writer-a', 'copy-fresh'),
    { projectId: 'copy-1', revision: 5, branched: false },
  );
  assert.deepEqual(
    resolveConflictCopyWriteTarget('copy-1', 5, 4, 'writer-b', 'writer-a', 'copy-fresh'),
    { projectId: 'copy-fresh', revision: 1, branched: true },
  );
  assert.deepEqual(
    resolveConflictCopyWriteTarget('copy-1', null, 4, null, 'writer-a', 'copy-fresh'),
    { projectId: 'copy-fresh', revision: 1, branched: true },
  );
  assert.deepEqual(
    resolveConflictCopyWriteTarget('copy-1', 5, 4, 'writer-a', 'writer-a', 'copy-fresh'),
    { projectId: 'copy-fresh', revision: 1, branched: true },
  );
});

test('比較参考値は各評価1〜5を0〜100へ一貫して換算する', () => {
  const candidate = {
    id: 'score-test',
    title: '',
    description: '',
    evidenceIds: [],
    provisional: false,
    scoresReviewed: true,
  };
  assert.equal(priorityScore({ ...candidate, impact: 1, frequency: 1, evidence: 1, feasibility: 1 }), 0);
  assert.equal(priorityScore({ ...candidate, impact: 3, frequency: 3, evidence: 3, feasibility: 3 }), 50);
  assert.equal(priorityScore({ ...candidate, impact: 5, frequency: 5, evidence: 5, feasibility: 5 }), 100);
});

const fact = (id, category, statement, status = '確認済み', source = 'テスト記録') => ({
  id,
  category,
  statement,
  status,
  source,
  metric: '',
  updatedAt: '2026-08-26',
  generatedBy: 'human',
});

const supportCase = () => ({
  ...createBlankProject(),
  projectName: '問い合わせ一次回答の遅延改善',
  target: 'ECカスタマーサポートの返品・配送メール',
  purpose: '初回回答を2時間以内にし、引継ぎ内容を3分以内に理解できる状態をつくる。',
  successMetric: '初回回答時間と追加確認件数を2週間測る。',
  decisionMaker: 'サポート責任者',
  constraints: '個人情報を外部へ送らない。',
  facts: [
    fact('business', 'ビジネスモデル', 'EC顧客から返品・配送の問い合わせをメールで受け付ける。'),
    fact('current', '現状', '繁忙時は一次回答まで平均6時間かかる。'),
    fact('ideal', '理想', '一次回答を2時間以内に行う。'),
    fact('problem', '問題', '担当交代時に問い合わせの優先度と対応状況を把握できない。', '一部確認'),
    fact('cause', '原因', '対応状況を記録する共通項目がない。'),
    fact('open', '現状', '追加確認件数の基準値は未集計。', '未確認', ''),
  ],
});

test('空案件は候補も判断も持たない', () => {
  const project = createBlankProject();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  assert.equal(project.schemaVersion, 3);
  assert.deepEqual(analysis.problems, []);
  assert.deepEqual(analysis.tasks, []);
  assert.deepEqual(project.decision, createEmptyDecision());
});

test('同じ入力は同じ候補・安定ID・fingerprintを返す', () => {
  const project = supportCase();
  const first = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const second = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  assert.deepEqual(first, second);
  assert.ok(first.analysisFingerprint);
});

test('別業務へサンプル固有語や古い候補が混入しない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const text = JSON.stringify(analysis);
  assert.match(text, /担当交代時に問い合わせの優先度と対応状況を把握できない/);
  assert.match(analysis.problems[0].description, /根拠を選択/);
  assert.equal(analysis.problems[0].provisional, true);
  assert.doesNotMatch(text, /図書館イベント備品|架空予約30件|貸出準備/);
  assert.ok(analysis.problems.length > 0);
  assert.ok(analysis.tasks.length >= 2);
});

test('候補が参照するfact IDとtaskのproblem IDはすべて現案件内に存在する', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const factIds = new Set(project.facts.map((item) => item.id));
  const problemIds = new Set(analysis.problems.map((item) => item.id));
  for (const problem of analysis.problems) {
    assert.ok(problem.evidenceIds.every((id) => factIds.has(id)));
  }
  for (const task of analysis.tasks) {
    assert.ok(problemIds.has(task.problemId));
    assert.ok(task.evidenceIds.every((id) => factIds.has(id)));
  }
});

test('判断材料の変更時は候補と判断を全置換で無効化する', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const analyzed = {
    ...project,
    ...analysis,
    decision: {
      ...createEmptyDecision(),
      problemId: analysis.problems[0].id,
      taskId: analysis.tasks[0].id,
      finalProblem: '人間が編集した問題文',
      finalTask: '人間が編集した課題文',
    },
  };
  const invalidated = invalidateAnalysis({
    ...analyzed,
    facts: analyzed.facts.map((item) => item.id === 'current'
      ? { ...item, statement: '一次回答まで平均8時間かかる。' }
      : item),
  });
  assert.deepEqual(invalidated.problems, []);
  assert.deepEqual(invalidated.tasks, []);
  assert.deepEqual(invalidated.decision, createEmptyDecision());
  assert.equal(invalidated.analysisFingerprint, '');
  assert.equal(invalidated.draftHistory[0].finalProblem, '人間が編集した問題文');
  assert.deepEqual(invalidated.decisionHistory, []);
});

test('旧v1保存データは入力だけ移行し、旧候補・旧判断を捨てる', () => {
  const project = supportCase();
  const migrated = migrateProject({
    projectName: project.projectName,
    purpose: project.purpose,
    target: project.target,
    facts: project.facts,
    problems: [{ id: 'old-problem', title: '旧形式の問題' }],
    tasks: [{ id: 'old-task', title: '旧形式の課題' }],
    decision: { problemId: 'old-problem', taskId: 'old-task', status: '採用' },
  });
  assert.equal(migrated.projectName, project.projectName);
  assert.equal(migrated.facts.length, project.facts.length);
  assert.deepEqual(migrated.problems, []);
  assert.deepEqual(migrated.tasks, []);
  assert.deepEqual(migrated.decision, createEmptyDecision());
});

test('v2でもdangling decision referenceは復元しない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const migrated = migrateProject({
    ...project,
    ...analysis,
    schemaVersion: 2,
    decision: {
      ...createEmptyDecision(),
      problemId: 'missing-problem',
      taskId: 'missing-task',
      status: '採用',
    },
  });
  assert.deepEqual(migrated.decision, createEmptyDecision());
});

test('事実変更でfingerprintが変わり、再分析結果は全置換される', () => {
  const project = supportCase();
  const before = projectFingerprint(project);
  const changed = {
    ...project,
    facts: project.facts.map((item) => item.id === 'problem'
      ? { ...item, statement: '配送問い合わせの優先度だけが共有されない。' }
      : item),
  };
  const after = projectFingerprint(changed);
  assert.notEqual(before, after);
  const analysis = buildAnalysis(changed, '2026-08-26T00:00:00.000Z');
  assert.equal(analysis.problems.length, 1);
  assert.match(analysis.problems[0].title, /配送問い合わせの優先度/);
  assert.doesNotMatch(JSON.stringify(analysis), /担当交代時に問い合わせ/);
});

test('サンプルは明示的に作った場合だけ候補を持ち、内容と根拠が一致する', () => {
  const sample = createSampleProject();
  assert.ok(sample.problems.length > 0);
  assert.ok(sample.tasks.length > 0);
  assert.equal(sample.analysisFingerprint, projectFingerprint(sample));
  assert.ok(sample.tasks.every((task) => sample.problems.some((problem) => problem.id === task.problemId)));
});

test('factsの並び順だけを変えてもfingerprintと分析結果は変わらない', () => {
  const project = supportCase();
  const reversed = { ...project, facts: [...project.facts].reverse() };
  const first = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const second = buildAnalysis(reversed, '2026-08-26T00:00:00.000Z');
  assert.equal(projectFingerprint(project), projectFingerprint(reversed));
  assert.deepEqual(first, second);
});

test('正しいinput fingerprintでも改変された候補や課題は復元しない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const tampered = migrateProject({
    ...project,
    ...analysis,
    schemaVersion: 2,
    problems: analysis.problems.map((item, index) => index === 0
      ? { ...item, title: '改変された候補' }
      : item),
  });
  assert.deepEqual(tampered.problems, []);
  assert.deepEqual(tampered.tasks, []);
  assert.deepEqual(tampered.decision, createEmptyDecision());
});

test('採用状態でも候補参照がなければ現行判断へ復元しない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const migrated = migrateProject({
    ...project,
    ...analysis,
    schemaVersion: 2,
    decision: {
      ...createEmptyDecision(),
      status: '採用',
      finalProblem: '過去の問題文',
      finalTask: '過去の課題文',
      reason: '過去の判断理由',
      decidedBy: '責任者',
      decidedAt: '2026-08-26',
    },
  });
  assert.deepEqual(migrated.decision, createEmptyDecision());
  assert.equal(migrated.draftHistory[0].finalProblem, '過去の問題文');
  assert.equal(migrated.draftHistory[0].needsReview, true);
  assert.deepEqual(migrated.decisionHistory, []);
});

test('複数問題があっても課題候補は特定の原因を因果と断定しない', () => {
  const project = supportCase();
  project.facts.push(fact('problem-2', '問題', '返品承認の判断基準が担当者ごとに異なる。', '一部確認'));
  project.facts.push(fact('cause-2', '原因', '返品理由の分類が統一されていない。', '仮説'));
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  assert.equal(analysis.problems.length, 2);
  assert.ok(analysis.tasks.every((task) => !task.title.includes('対応状況を記録する共通項目がない')));
  assert.ok(analysis.tasks.every((task) => !task.title.includes('返品理由の分類が統一されていない')));
  assert.match(JSON.stringify(analysis.tasks), /原因仮説を検証する/);
});

test('正常なv2再読込では現行判断を履歴へ重複させない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const problem = analysis.problems[0];
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  const stored = {
    ...project,
    ...analysis,
    schemaVersion: 2,
    problems: analysis.problems.map((item) => ({ ...item, scoresReviewed: true })),
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      status: '採用',
      finalProblem: '人間の最終問題文',
      finalTask: '人間の最終課題文',
      reason: '人間の判断理由',
      decidedBy: '責任者',
      decidedAt: '2026-08-26',
    },
  };
  const migrated = migrateProject(stored);
  assert.equal(migrated.decision.status, '採用');
  assert.equal(migrated.decision.finalProblem, '人間の最終問題文');
  assert.deepEqual(migrated.decisionHistory, []);
});

test('複数回の判断材料変更でも旧下書きを失わず、正式履歴と混同しない', () => {
  const first = {
    ...supportCase(),
    decision: {
      ...createEmptyDecision(),
      finalProblem: '1回目の問題文',
      finalTask: '1回目の課題文',
      reason: '1回目の理由',
    },
  };
  const once = invalidateAnalysis(first);
  const twice = invalidateAnalysis({
    ...once,
    decision: {
      ...createEmptyDecision(),
      finalProblem: '2回目の問題文',
      finalTask: '2回目の課題文',
      reason: '2回目の理由',
    },
  });
  assert.deepEqual(twice.draftHistory.map((item) => item.finalProblem), [
    '2回目の問題文',
    '1回目の問題文',
  ]);
  assert.deepEqual(twice.decisionHistory, []);
});

test('根拠確度Aは情報源付きの確認済み根拠だけに限定する', () => {
  const complete = supportCase();
  complete.facts = complete.facts.filter((item) => ['business', 'current', 'ideal'].includes(item.id));
  const completeAnalysis = buildAnalysis(complete, '2026-08-26T00:00:00.000Z');
  assert.equal(completeAnalysis.problems[0].evidence, 5);
  assert.equal(evidenceGrade(completeAnalysis.problems[0].evidence), 'A');

  const partial = supportCase();
  const partialAnalysis = buildAnalysis(partial, '2026-08-26T00:00:00.000Z');
  assert.equal(partialAnalysis.problems[0].evidence, 3);
  assert.equal(evidenceGrade(partialAnalysis.problems[0].evidence), 'B');

  const missingSource = {
    ...complete,
    facts: complete.facts.map((item) => item.id === 'current' ? { ...item, source: '' } : item),
  };
  const missingSourceAnalysis = buildAnalysis(missingSource, '2026-08-26T00:00:00.000Z');
  assert.equal(missingSourceAnalysis.problems[0].evidence, 3);
  assert.equal(evidenceGrade(missingSourceAnalysis.problems[0].evidence), 'B');

  const open = {
    ...complete,
    facts: complete.facts.map((item) => item.id === 'current' ? { ...item, status: '未確認' } : item),
  };
  const openAnalysis = buildAnalysis(open, '2026-08-26T00:00:00.000Z');
  assert.equal(openAnalysis.problems[0].evidence, 2);
  assert.equal(evidenceGrade(openAnalysis.problems[0].evidence), 'C');
});

test('複数問題では現状・理想を自動で誤対応せず、人間の対応付けを案件保存後も保持する', () => {
  const project = supportCase();
  project.facts.push(fact('current-2', '現状', '返品承認は平均2日かかる。'));
  project.facts.push(fact('ideal-2', '理想', '返品承認を当日中に終える。'));
  project.facts.push(fact('problem-2', '問題', '返品承認の判断基準が担当者ごとに異なる。', '一部確認'));
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  assert.equal(analysis.problems.length, 2);
  assert.ok(analysis.problems.every((problem) => problem.evidenceIds.length === 1));
  const first = analysis.problems.find((problem) => problem.evidenceIds[0] === 'problem');
  const second = analysis.problems.find((problem) => problem.evidenceIds[0] === 'problem-2');
  let linked = updateProblemEvidence({ ...project, ...analysis }, first.id, [
    first.evidenceIds[0],
    'current',
    'ideal',
  ]);
  linked = updateProblemEvidence(linked, second.id, [
    second.evidenceIds[0],
    'current-2',
    'ideal-2',
  ]);
  assert.deepEqual(linked.problems.find((problem) => problem.id === first.id).evidenceIds, ['problem', 'current', 'ideal']);
  assert.deepEqual(linked.problems.find((problem) => problem.id === second.id).evidenceIds, ['problem-2', 'current-2', 'ideal-2']);
  const migrated = migrateProject(linked);
  assert.deepEqual(migrated.problems.find((problem) => problem.id === second.id).evidenceIds, ['problem-2', 'current-2', 'ideal-2']);
});

test('問題が複数なら現状と理想が各1件でも全候補への自動流用をしない', () => {
  const project = supportCase();
  project.facts = project.facts.filter((item) => item.id !== 'open');
  project.facts.push(fact('problem-2', '問題', '返品承認の判断基準が担当者ごとに異なる。', '一部確認'));
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  assert.equal(analysis.problems.length, 2);
  assert.ok(analysis.problems.every((problem) => problem.evidenceIds.length === 1));
  assert.ok(analysis.problems.every((problem) => !problem.evidenceIds.includes('current')));
  assert.ok(analysis.problems.every((problem) => !problem.evidenceIds.includes('ideal')));

  const problem = { ...analysis.problems[0], scoresReviewed: true };
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  const candidate = {
    ...project,
    ...analysis,
    problems: analysis.problems.map((item) => item.id === problem.id ? problem : item),
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      status: '採用',
      finalProblem: '確認した問題文',
      finalTask: '実施する課題文',
      nextAction: '翌日から試行する',
      reason: '小さく試せるため',
      decidedBy: '責任者',
    },
  };
  assert.equal(evaluateDecisionReadiness(candidate).code, 'evidence-link');
});

test('旧分析版の現行候補は再利用せず、正式履歴だけは保持する', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const linked = updateProblemEvidence({ ...project, ...analysis }, analysis.problems[0].id, [
    ...analysis.problems[0].evidenceIds,
    'current',
    'ideal',
  ]);
  const problem = { ...linked.problems[0], scoresReviewed: true };
  const task = linked.tasks.find((item) => item.problemId === problem.id);
  const confirmed = recordConfirmedDecision({
    ...linked,
    problems: linked.problems.map((item) => item.id === problem.id ? problem : item),
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      status: '採用',
      finalProblem: '正式問題文',
      finalTask: '正式課題文',
      nextAction: '試行する',
      reason: '根拠を確認したため',
      decidedBy: '責任者',
      decidedAt: '2026-08-26',
    },
  }, 'v5-snapshot', '2026-08-26T01:00:00.000Z');
  const migrated = migrateProject({
    ...confirmed,
    analysisFingerprint: 'rule-engine-4-era-fingerprint',
  });
  assert.equal(migrated.problems.length, 0);
  assert.equal(migrated.tasks.length, 0);
  assert.equal(migrated.decisionHistory.length, 1);
  assert.equal(migrated.decisionHistory[0].id, 'v5-snapshot');
});

test('採用は選択問題に現状と理想を対応付けるまで正式記録できない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const initialProblem = { ...analysis.problems[0], scoresReviewed: true };
  const initialTask = analysis.tasks.find((task) => task.id.endsWith('-pilot'));
  const decision = {
    ...createEmptyDecision(),
    problemId: initialProblem.id,
    taskId: initialTask.id,
    status: '採用',
    finalProblem: '確認した問題文',
    finalTask: '実施する課題文',
    nextAction: '翌日から試行する',
    reason: '小さく試せるため',
    decidedBy: '責任者',
  };
  const unlinked = {
    ...project,
    ...analysis,
    problems: [initialProblem],
    decision,
  };
  assert.equal(evaluateDecisionReadiness(unlinked).code, 'evidence-link');
  const linked = updateProblemEvidence(unlinked, initialProblem.id, [
    ...initialProblem.evidenceIds,
    'current',
    'ideal',
  ]);
  const reviewed = {
    ...linked,
    problems: linked.problems.map((problem) => ({ ...problem, scoresReviewed: true })),
  };
  assert.equal(evaluateDecisionReadiness(reviewed).ready, true);
});

test('正式確定は問題・課題・根拠・評価を不変スナップショットとして保存する', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const problem = { ...analysis.problems[0], impact: 4, scoresReviewed: true };
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  const decided = {
    ...project,
    ...analysis,
    problems: [problem],
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      status: '採用',
      finalProblem: '確定した問題文',
      finalTask: '確定した課題文',
      expectedOutcome: '期待する状態',
      nextAction: '翌日から試行する',
      reason: '根拠を確認したため',
      decidedBy: '責任者',
      decidedAt: '2026-08-26',
      needsReview: false,
    },
  };
  const recorded = recordConfirmedDecision(decided, 'snapshot-1', '2026-08-26T01:00:00.000Z');
  const edited = {
    ...recorded,
    problems: recorded.problems.map((item) => ({ ...item, impact: 1 })),
    decision: { ...recorded.decision, finalProblem: '後から編集した文', needsReview: true },
    facts: recorded.facts.map((item) => ({ ...item, statement: `${item.statement}（編集後）` })),
  };
  assert.equal(edited.decisionHistory[0].decision.finalProblem, '確定した問題文');
  assert.equal(edited.decisionHistory[0].problem.impact, 4);
  assert.ok(edited.decisionHistory[0].evidenceFacts.every((item) => !item.statement.endsWith('（編集後）')));
  assert.equal(edited.decisionHistory[0].snapshotVersion, 3);
  assert.equal(edited.decisionHistory[0].projectContext.projectName, project.projectName);
  assert.equal(edited.decisionHistory[0].facts.length, project.facts.length);
  assert.equal(edited.decisionHistory[0].problems.length, 1);
  assert.equal(edited.decisionHistory[0].analysisVersion, 'rule-engine-5');
  const duplicated = recordConfirmedDecision(recorded, 'snapshot-2', '2026-08-26T02:00:00.000Z');
  assert.equal(duplicated.decisionHistory.length, 2);
  assert.equal(duplicated.decisionHistory[0].id, 'snapshot-2');
  assert.equal(duplicated.decisionHistory[0].recordedAt, '2026-08-26T02:00:00.000Z');
  const contextChanged = recordConfirmedDecision({
    ...recorded,
    projectName: '同じ判断を別文脈で再確定',
  }, 'snapshot-3', '2026-08-26T03:00:00.000Z');
  assert.equal(contextChanged.decisionHistory.length, 2);
  assert.equal(contextChanged.decisionHistory[0].projectContext.projectName, '同じ判断を別文脈で再確定');
});

test('v2再読込で正式スナップショットを保持し、旧形式の履歴は下書きへ分離する', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const problem = { ...analysis.problems[0], scoresReviewed: true };
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  const decision = {
    ...createEmptyDecision(),
    problemId: problem.id,
    taskId: task.id,
    status: '採用',
    finalProblem: '正式問題文',
    finalTask: '正式課題文',
    nextAction: '試行する',
    reason: '正式理由',
    decidedBy: '責任者',
    decidedAt: '2026-08-26',
  };
  const recorded = recordConfirmedDecision({
    ...project,
    ...analysis,
    problems: [problem],
    decision,
  }, 'snapshot-keep', '2026-08-26T01:00:00.000Z');
  const migrated = migrateProject({
    ...recorded,
    decisionHistory: [
      ...recorded.decisionHistory,
      { ...decision, finalProblem: '旧形式の判断文', needsReview: false },
    ],
  });
  assert.equal(migrated.decisionHistory.length, 1);
  assert.equal(migrated.decisionHistory[0].id, 'snapshot-keep');
  assert.equal(migrated.decisionHistory[0].decision.finalProblem, '正式問題文');
  assert.equal(migrated.draftHistory[0].finalProblem, '旧形式の判断文');
});

test('未知schemaでも読み取れる現在判断を下書きへ退避して失わない', () => {
  const project = supportCase();
  const migrated = migrateProject({
    ...project,
    schemaVersion: 99,
    decision: {
      ...createEmptyDecision(),
      status: '保留',
      finalProblem: '将来版の問題文',
      finalTask: '将来版の課題文',
      reason: '将来版の理由',
    },
  });
  assert.deepEqual(migrated.decision, createEmptyDecision());
  assert.equal(migrated.draftHistory[0].finalProblem, '将来版の問題文');
});

test('正式判断履歴を20件で無通知に切り捨てない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const problem = { ...analysis.problems[0], scoresReviewed: true };
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  let recorded = {
    ...project,
    ...analysis,
    problems: [problem],
    decision: createEmptyDecision(),
  };
  for (let index = 0; index < 25; index += 1) {
    recorded = recordConfirmedDecision({
      ...recorded,
      decision: {
        ...createEmptyDecision(),
        problemId: problem.id,
        taskId: task.id,
        status: '保留',
        finalProblem: `問題文${index}`,
        finalTask: `課題文${index}`,
        nextAction: `確認事項${index}`,
        reason: `理由${index}`,
        decidedBy: '責任者',
        decidedAt: `2026-08-${String(index + 1).padStart(2, '0')}`,
      },
    }, `snapshot-${index}`, `2026-08-26T${String(index).padStart(2, '0')}:00:00.000Z`);
  }
  assert.equal(recorded.decisionHistory.length, 25);
});

test('根拠Cは採用を止めるが、見直し条件付きの保留と却下は正式記録できる', () => {
  const project = supportCase();
  project.facts = project.facts.map((item) => item.id === 'problem'
    ? { ...item, status: '未確認' }
    : item);
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const linked = updateProblemEvidence({ ...project, ...analysis }, analysis.problems[0].id, [
    ...analysis.problems[0].evidenceIds,
    'current',
    'ideal',
  ]);
  const problem = { ...linked.problems[0], scoresReviewed: true };
  const task = linked.tasks.find((item) => item.problemId === problem.id);
  const base = {
    ...project,
    ...linked,
    problems: [problem],
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      finalProblem: '人間が確定する問題文',
      finalTask: '人間が検討する課題文',
      nextAction: '不足情報を担当者が確認する',
      reason: '根拠不足を含めて判断したため',
      decidedBy: '責任者',
    },
  };
  assert.equal(problem.evidence, 2);
  assert.equal(evaluateDecisionReadiness({
    ...base,
    decision: { ...base.decision, status: '採用' },
  }).code, 'evidence');
  assert.equal(evaluateDecisionReadiness({
    ...base,
    decision: { ...base.decision, status: '保留' },
  }).code, 'next-review');
  assert.equal(evaluateDecisionReadiness({
    ...base,
    decision: { ...base.decision, status: '保留', nextReview: '2026-09-09' },
  }).ready, true);
  assert.equal(evaluateDecisionReadiness({
    ...base,
    decision: { ...base.decision, status: '却下' },
  }).ready, true);
});

test('候補選択で自動入力された未編集文を人間の旧下書きとして残さない', () => {
  const project = supportCase();
  const analysis = buildAnalysis(project, '2026-08-26T00:00:00.000Z');
  const problem = analysis.problems[0];
  const task = analysis.tasks.find((item) => item.problemId === problem.id);
  const problemOnly = archiveCurrentDecision({
    ...project,
    ...analysis,
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      finalProblem: problem.title,
    },
  });
  assert.deepEqual(problemOnly.draftHistory, []);
  const taskSelected = archiveCurrentDecision({
    ...project,
    ...analysis,
    decision: {
      ...createEmptyDecision(),
      problemId: problem.id,
      taskId: task.id,
      finalProblem: problem.title,
      finalTask: task.title,
      expectedOutcome: task.outcome,
      nextAction: task.firstAction,
    },
  });
  assert.deepEqual(taskSelected.draftHistory, []);
});

const aiDraft = () => ({
  problems: [{
    sourceFactId: 'problem',
    title: '担当交代時に対応状況を把握できない',
    description: '現状と理想の差を、入力済みの根拠だけから候補化した。',
    evidenceIds: ['problem', 'current', 'ideal'],
    tasks: [{
      title: '引継ぎ項目を限定して試行する',
      outcome: '次の担当者が3分以内に状況を理解できる状態を確認する。',
      effort: '小 — 1チームで2週間',
      risk: '低 — 既存運用へ戻せる',
      firstAction: '対象・期間・記録項目・責任者を決める。',
      evidenceIds: ['problem', 'current', 'ideal'],
    }],
  }],
});

test('AIへ送る入力は案件名・決定者・判断履歴を含めず必要最小限にする', () => {
  const project = supportCase();
  const request = createAiAnalysisRequest(project);
  assert.equal(request.target, project.target);
  assert.equal(request.facts.length, project.facts.length);
  assert.equal('projectName' in request, false);
  assert.equal('decisionMaker' in request, false);
  assert.equal('decision' in request, false);
  assert.equal('decisionHistory' in request, false);
  assert.equal('source' in request.facts[0], false);
  assert.equal(typeof request.facts[0].hasSource, 'boolean');
});

test('AI送信前検証はAPIと同じ入力不備をクライアント側でも拒否する', () => {
  const project = supportCase();
  assert.deepEqual(
    validateAiAnalysisRequest(createAiAnalysisRequest(project)),
    createAiAnalysisRequest(project),
  );
  assert.throws(
    () => validateAiAnalysisRequest(createAiAnalysisRequest({ ...project, target: '' })),
    AiValidationError,
  );
  assert.throws(
    () => validateAiAnalysisRequest(createAiAnalysisRequest({
      ...project,
      facts: [{ ...project.facts[0], statement: '' }, ...project.facts.slice(1)],
    })),
    AiValidationError,
  );
});

test('AI待機中に評価や人間の判断が変わった場合は同じ入力指紋でも古い結果を拒否する', () => {
  const project = supportCase();
  const analyzed = {
    ...project,
    ...buildAnalysis(project, '2026-08-26T02:00:00.000Z'),
  };
  const request = createAiAnalysisRequest(analyzed);
  const requestProjectJson = JSON.stringify(analyzed);
  assert.equal(
    aiRequestMatchesProject(analyzed, request.inputFingerprint, requestProjectJson),
    true,
  );
  const rescored = {
    ...analyzed,
    problems: analyzed.problems.map((problem, index) =>
      index === 0 ? { ...problem, impact: 5, scoresReviewed: true } : problem),
  };
  assert.equal(projectFingerprint(rescored), request.inputFingerprint);
  assert.equal(
    aiRequestMatchesProject(rescored, request.inputFingerprint, requestProjectJson),
    false,
  );
  const editedDecision = {
    ...analyzed,
    decision: { ...analyzed.decision, reason: '人間が追記した判断理由' },
  };
  assert.equal(projectFingerprint(editedDecision), request.inputFingerprint);
  assert.equal(
    aiRequestMatchesProject(editedDecision, request.inputFingerprint, requestProjectJson),
    false,
  );
});

test('AI出力は未知の根拠IDを1件でも含めば全体を拒否する', () => {
  const project = supportCase();
  const invalid = aiDraft();
  invalid.problems[0].tasks[0].evidenceIds.push('unknown-fact');
  assert.throws(
    () => validateAiModelOutput(invalid, project.facts),
    AiValidationError,
  );
});

test('AI候補は安定ID・自動根拠確度・人間未確認の評価として正規化する', () => {
  const project = supportCase();
  const meta = {
    model: 'gpt-5.4-mini-2026-03-17',
    responseId: 'resp_test_1',
    generatedAt: '2026-08-26T02:00:00.000Z',
    usage: { inputTokens: 100, outputTokens: 80, totalTokens: 180 },
  };
  const first = normalizeAiAnalysis(project, aiDraft(), meta);
  const second = normalizeAiAnalysis(project, aiDraft(), meta);
  assert.deepEqual(first, second);
  assert.equal(first.analysisSource, 'openai');
  assert.equal(first.analysisModel, meta.model);
  assert.equal(first.analysisResponseId, meta.responseId);
  assert.equal(first.problems[0].scoresReviewed, false);
  assert.equal(first.problems[0].impact, 3);
  assert.equal(first.problems[0].evidence, 3);
  assert.match(first.problems[0].id, /^ai-problem-/);
  assert.match(first.tasks[0].id, /^ai-task-/);
});

test('AI候補は再読込でルール候補へ化けず、根拠編集でもAI課題文を保持する', () => {
  const project = supportCase();
  const analysis = normalizeAiAnalysis(project, aiDraft(), {
    model: 'gpt-5.4-mini-2026-03-17',
    responseId: 'resp_test_reload',
    generatedAt: '2026-08-26T02:00:00.000Z',
    usage: null,
  });
  const analyzed = { ...project, ...analysis };
  const migrated = migrateProject(JSON.parse(JSON.stringify(analyzed)));
  assert.equal(migrated.schemaVersion, 3);
  assert.equal(migrated.analysisSource, 'openai');
  assert.equal(migrated.problems[0].title, aiDraft().problems[0].title);
  assert.equal(migrated.tasks[0].title, aiDraft().problems[0].tasks[0].title);

  const updated = updateProblemEvidence(
    migrated,
    migrated.problems[0].id,
    ['problem', 'current', 'ideal', 'cause'],
  );
  assert.equal(updated.analysisSource, 'openai');
  assert.equal(updated.tasks[0].id, migrated.tasks[0].id);
  assert.equal(updated.tasks[0].title, migrated.tasks[0].title);
  assert.deepEqual(updated.tasks[0].evidenceIds, ['problem', 'cause', 'current', 'ideal']);
});
