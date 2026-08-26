import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { POST } from '../app/api/analyze/route.ts';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENAI_API_KEY;
const originalModel = process.env.OPENAI_MODEL;

let clientSequence = 0;

const validRequestBody = () => ({
  inputFingerprint: 'offline-api-test-fingerprint',
  target: '架空の問い合わせ一次対応',
  purpose: '担当者が次の対応を迷わず選べる問題候補を作る',
  successMetric: '初回振り分けを15分以内にする',
  constraints: '個人情報を使わない',
  facts: [
    {
      id: 'current',
      category: '現状',
      statement: '問い合わせは複数の表へ分散して記録されている。',
      status: '確認済み',
      metric: '月120件',
      hasSource: true,
    },
    {
      id: 'ideal',
      category: '理想',
      statement: '受信から15分以内に担当へ振り分けられる。',
      status: '確認済み',
      metric: '15分以内',
      hasSource: true,
    },
    {
      id: 'problem',
      category: '問題',
      statement: '未対応案件の発見が遅れることがある。',
      status: '一部確認',
      metric: '週2件',
      hasSource: true,
    },
  ],
});

const validModelOutput = () => ({
  problems: [{
    sourceFactId: 'problem',
    title: '記録の分散により未対応案件の発見が遅れる',
    description: '現状と理想の差を入力済みの根拠だけから候補化した。',
    evidenceIds: ['problem', 'current', 'ideal'],
    tasks: [{
      title: '受付記録を一つの一覧へ集約して小規模試行する',
      outcome: '問い合わせを15分以内に担当へ振り分けられる状態を確認する。',
      effort: '小 — 1チームで2週間',
      risk: '低 — 既存運用へ戻せる',
      firstAction: '対象・期間・記録項目・責任者を決める。',
      evidenceIds: ['problem', 'current', 'ideal'],
    }],
  }],
});

const requestFor = (body, headers = {}) => {
  clientSequence += 1;
  return new Request('http://localhost:3008/api/analyze', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `192.0.2.${clientSequence}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
};

const completedResponse = (output = validModelOutput()) => ({
  id: 'resp_offline_success',
  status: 'completed',
  model: 'gpt-5.4-mini-2026-03-17',
  output: [{
    type: 'message',
    content: [{
      type: 'output_text',
      text: JSON.stringify(output),
    }],
  }],
  usage: {
    input_tokens: 725,
    output_tokens: 895,
    total_tokens: 1620,
  },
});

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-api-key-not-real';
  process.env.OPENAI_MODEL = 'gpt-5.4-mini-2026-03-17';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
  if (originalModel === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = originalModel;
});

test('APIは現状または理想が欠けた入力をOpenAIへ送らず拒否する', async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('invalid input must not reach the upstream API');
  };
  const body = validRequestBody();
  body.facts = body.facts.filter((fact) => fact.category !== '理想');

  const response = await POST(requestFor(body));
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.equal(fetchCalls, 0);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('APIはResponses APIの構造化出力を検証して利用量とともに返す', async () => {
  let upstreamRequest;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url, init };
    return Response.json(completedResponse(), { status: 200 });
  };

  const response = await POST(requestFor(validRequestBody()));
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.inputFingerprint, 'offline-api-test-fingerprint');
  assert.equal(result.responseId, 'resp_offline_success');
  assert.equal(result.model, 'gpt-5.4-mini-2026-03-17');
  assert.deepEqual(result.usage, {
    inputTokens: 725,
    outputTokens: 895,
    totalTokens: 1620,
  });
  assert.deepEqual(result.output, validModelOutput());
  assert.equal(upstreamRequest.url, 'https://api.openai.com/v1/responses');
  assert.equal(upstreamRequest.init.method, 'POST');
  assert.equal(upstreamRequest.init.headers.Authorization, 'Bearer test-api-key-not-real');

  const upstreamBody = JSON.parse(upstreamRequest.init.body);
  assert.equal(upstreamBody.store, false);
  assert.equal(upstreamBody.model, 'gpt-5.4-mini-2026-03-17');
  assert.equal(upstreamBody.text.format.type, 'json_schema');
  assert.equal(upstreamBody.text.format.strict, true);
  assert.equal(upstreamBody.text.format.schema.additionalProperties, false);
  assert.equal(upstreamBody.tools, undefined);
  assert.doesNotMatch(upstreamBody.input[0].content, /test-api-key-not-real/);
});

test('APIはOpenAIの429を安全な利用上限エラーへ変換する', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'rate limited' } }, { status: 429 });

  const response = await POST(requestFor(validRequestBody()));
  const result = await response.json();

  assert.equal(response.status, 429);
  assert.deepEqual(result, {
    ok: false,
    code: 'RATE_LIMITED',
    message: 'OpenAI APIの利用上限に達しました。少し待ってから再試行してください。',
  });
});

test('APIは不正な構造化出力を採用せず安全な検証エラーへ変換する', async () => {
  const invalidOutput = validModelOutput();
  invalidOutput.problems[0].evidenceIds.push('unknown-fact');
  globalThis.fetch = async () => Response.json(completedResponse(invalidOutput), { status: 200 });

  const response = await POST(requestFor(validRequestBody()));
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_AI_OUTPUT');
});

test('APIはOpenAIのサーバー障害を本文を漏らさず接続エラーへ変換する', async () => {
  globalThis.fetch = async () => Response.json(
    { error: { message: 'sensitive upstream details' } },
    { status: 500 },
  );

  const response = await POST(requestFor(validRequestBody()));
  const result = await response.json();

  assert.equal(response.status, 502);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'UPSTREAM_ERROR');
  assert.doesNotMatch(result.message, /sensitive upstream details/);
});
