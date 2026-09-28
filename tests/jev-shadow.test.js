import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { buildJevState } from '../extensions/observer.js';
import { shouldSampleNegative, safeActual } from '../lib/jev-shadow.js';

// v0.34.54 - 旁路观测点从 /api/text-analysis 挪到 observer 的真实决策现场。

test('Jev 旁路不再挂在 text-analysis 返回链上，避免同一轮花两次钱', async () => {
  const source = await fs.readFile(new URL('../routes/api.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /runJevShadow\(/);
  assert.match(source, /return json\(\{ ok: true, data: analysis \}\)/);
});

test('observer 在三个真实决策点采样旁路：注入 / 校准拦下 / 无情绪', async () => {
  const source = await fs.readFile(new URL('../extensions/observer.js', import.meta.url), 'utf8');
  assert.match(source, /decision: 'injected'/);
  assert.match(source, /decision: 'rejected'/);
  assert.match(source, /decision: 'no_emotion'/);
  // 注入这一轮是正样本，必须实采；负样本走抽样
  assert.match(source, /positive: true/);
  assert.match(source, /shouldSampleNegative\(\)/);
});

test('旁路记录能跟真实决策和反馈对账：情绪细词、场景、决定、会话锚点', async () => {
  const source = await fs.readFile(new URL('../lib/jev-shadow.js', import.meta.url), 'utf8');
  assert.match(source, /context_ts/);
  assert.match(source, /session_id/);
  assert.match(source, /scene_type/);
  assert.match(source, /emotion_latency_ms/);
  assert.equal(safeActual({ decision: 'injected', has_emotion: true, emotion: '得意', scene_type: '闲聊', intensity: 'light', emotion_latency_ms: 812.4 }).emotion_latency_ms, 812);
  assert.equal(safeActual({ decision: 'injected', intensity: 'nonsense' }).intensity, '');
});

test('Jev 提问只保留可比分，去掉对不上的六类情绪选择', async () => {
  const source = await fs.readFile(new URL('../lib/jev-shadow.js', import.meta.url), 'utf8');
  assert.match(source, /should_send[\s\S]*type: 'noul'/);
  assert.match(source, /intensity[\s\S]*type: 'score'/);
  assert.doesNotMatch(source, /type: 'choice'/);
});

test('旁路仍只记录摘要，不把完整 state 写进实验日志', async () => {
  const source = await fs.readFile(new URL('../lib/jev-shadow.js', import.meta.url), 'utf8');
  assert.match(source, /state_hash/);
  assert.match(source, /input_chars/);
  assert.doesNotMatch(source, /state:\s*state/);
});

test('每日上限仍然存在，正样本另有额外配额，不会被负样本挤掉', async () => {
  const configSource = await fs.readFile(new URL('../lib/jev.js', import.meta.url), 'utf8');
  const shadowSource = await fs.readFile(new URL('../lib/jev-shadow.js', import.meta.url), 'utf8');
  assert.match(configSource, /shadowEnabled: false/);
  assert.match(configSource, /shadowMaxCalls: 100/);
  assert.match(shadowSource, /log\.todayCalls >= quota/);
  assert.match(shadowSource, /POSITIVE_EXTRA_CALLS/);
});

test('负样本抽样：默认 25%，全部采和全不采都符合预期', () => {
  assert.equal(shouldSampleNegative(0, 0.25), true);
  assert.equal(shouldSampleNegative(0.99, 0.25), false);
  assert.equal(shouldSampleNegative(0.24), true);
  assert.equal(shouldSampleNegative(0.26), false);
});

test('buildJevState 只取最近几轮对话并渲染成文字', () => {
  const state = buildJevState([
    { role: 'system', content: '忽略我' },
    { role: 'user', content: '今天火锅' },
    { role: 'assistant', content: [{ type: 'text', text: '要得，巴适' }] },
  ]);
  assert.equal(state, '用户：今天火锅\n助手：要得，巴适');
  assert.equal(buildJevState(null), '');
  assert.equal(buildJevState([{ role: 'user', content: [] }]), '');
});

test('情绪分析耗时被记进日志，供速度对比', async () => {
  const source = await fs.readFile(new URL('../extensions/observer.js', import.meta.url), 'utf8');
  assert.match(source, /emotionLatencyMs/);
  assert.match(source, /emotion_latency_ms: emotionLatencyMs/);
});
