// Jev 旁路实验：只观察，不参与现有自动配图决策。
// v0.34.54 - 观测点从 /api/text-analysis 挪到 observer 真正的判断现场，
//   记录口径与真实决策对齐：情绪细词、场景类型、最终决定、会话锚点，
//   并把六类情绪选择换成可比分（该不该发 / 情绪强度）。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { JEV_SHADOW_LOG_FILE, readJevConfig, evaluateJev } from './jev.js';
import { atomicWriteJson } from './shared.js';

const MAX_LOG_ENTRIES = 2000;
const POSITIVE_EXTRA_CALLS = 25;
let writeChain = Promise.resolve();

function readLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(JEV_SHADOW_LOG_FILE, 'utf8'));
    return { version: 1, entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function todayPrefix() {
  return new Date().toISOString().slice(0, 10);
}

function stateHash(state) {
  return createHash('sha256').update(String(state || ''), 'utf8').digest('hex').slice(0, 16);
}

// v0.34.54 - 实际决策摘要：只留能跟 decision-log / 偏好反馈对账的字段。
//   decision：injected=真的把贴图提示注入了；rejected=校准没通过；no_emotion=模型说没情绪
export function safeActual(actual = {}) {
  return {
    decision: String(actual.decision || '').slice(0, 20),
    has_emotion: actual.has_emotion === true,
    emotion: String(actual.emotion || '').slice(0, 30),
    scene_type: String(actual.scene_type || '').slice(0, 12),
    intensity: ['light', 'medium', 'strong'].includes(actual.intensity) ? actual.intensity : '',
    emotion_latency_ms: Number.isFinite(actual.emotion_latency_ms) ? Math.round(actual.emotion_latency_ms) : null,
  };
}

function appendEntry(entry) {
  writeChain = writeChain.then(() => {
    const log = readLog();
    log.entries.push(entry);
    if (log.entries.length > MAX_LOG_ENTRIES) log.entries = log.entries.slice(-MAX_LOG_ENTRIES);
    atomicWriteJson(JEV_SHADOW_LOG_FILE, log);
  }).catch(() => {});
  return writeChain;
}

export function readJevShadowLog(limit = 50) {
  const log = readLog();
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const entries = log.entries.slice(-safeLimit).reverse();
  const today = todayPrefix();
  return {
    version: log.version,
    entries,
    total: log.entries.length,
    todayCalls: log.entries.filter(entry => String(entry.ts || '').startsWith(today)).length,
  };
}

// v0.34.54 - positive=true 是真发了图的正样本，配额给它留出余量，
//   否则正样本会被负样本挤掉，实验又变成清一色「建议不发」。
export async function runJevShadow({ state, actual, agentId = 'unknown', sessionId = '', positive = false } = {}) {
  const cfg = readJevConfig();
  if (!cfg.enabled || !cfg.shadowEnabled || !cfg.apiKey) return { ok: false, skipped: true, reason: 'disabled-or-unconfigured' };
  const log = readJevShadowLog(500);
  const quota = cfg.shadowMaxCalls + (positive ? POSITIVE_EXTRA_CALLS : 0);
  if (log.todayCalls >= quota) return { ok: false, skipped: true, reason: 'daily-limit' };

  const started = Date.now();
  const result = await evaluateJev({
    config: cfg,
    state: String(state || '').slice(0, 12000),
    questions: {
      should_send: {
        type: 'noul',
        instructions: '这一轮助手回复是否适合自然地配一张表情包？严肃工作、纯信息执行和复杂技术内容通常不适合。',
      },
      intensity: {
        type: 'score',
        instructions: '这一轮适合用表情包表达的情绪强度如何？0=完全不需要表情包，1=情绪强烈到非配图不可。',
      },
    },
    timeoutMs: 12000,
  });

  const entry = {
    type: 'jev_shadow',
    ts: new Date().toISOString(),
    context_ts: started,
    agent: String(agentId || 'unknown').slice(0, 100),
    session_id: String(sessionId || '').slice(0, 120),
    state_hash: stateHash(state),
    input_chars: String(state || '').length,
    positive: positive === true,
    actual: safeActual(actual),
    latency_ms: Date.now() - started,
  };
  if (result.ok) {
    const answers = result.data.answers || {};
    entry.jev = {
      should_send: answers.should_send?.noul,
      intensity: answers.intensity?.score,
    };
    entry.usage = result.data.usage || null;
  } else {
    entry.error = String(result.error || 'Jev 请求失败').slice(0, 240);
  }
  await appendEntry(entry);
  return { ok: result.ok, entry };
}

// 负样本抽样率：正样本必采，负样本抽着采，两边都有对照组才判得出差异。
export function shouldSampleNegative(randomValue = Math.random(), rate = 0.25) {
  return randomValue < rate;
}
