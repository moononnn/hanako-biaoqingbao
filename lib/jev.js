// Jev 专用决策 API：独立于 Hana 普通聊天模型。
// Key 在 Windows 下用 DPAPI(CurrentUser) 保存；页面和 API 只返回掩码。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const JEV_CFG_FILE = path.join(DATA_DIR, 'jev-config.json');
export const JEV_SHADOW_LOG_FILE = path.join(DATA_DIR, 'jev-shadow-log.json');
export const JEV_DEFAULT_BASE_URL = 'https://api.typesafe.ai';

const DEFAULT_CONFIG = {
  enabled: false,
  shadowEnabled: false,
  shadowMaxCalls: 100,
  baseUrl: JEV_DEFAULT_BASE_URL,
  model: 'jev-latest',
  apiKey: '',
};

const keyCache = new Map();

function protectKey(plain) {
  if (!plain) return '';
  if (process.platform !== 'win32') return plain;
  try {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$b = [Text.Encoding]::UTF8.GetBytes($env:JEV_KEY_PLAIN)',
      "$e = [Security.Cryptography.ProtectedData]::Protect($b, $null, 'CurrentUser')",
      '[Convert]::ToBase64String($e)',
    ].join(';');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, JEV_KEY_PLAIN: plain },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }).trim();
    if (!out) throw new Error('DPAPI 未返回加密结果');
    keyCache.set(out, plain);
    return `dpapi:${out}`;
  } catch {
    // 无法使用系统加密时保留明文，UI 会显示风险提示；不伪造“已加密”。
    return plain;
  }
}

function unprotectKey(stored) {
  if (!stored) return '';
  if (!String(stored).startsWith('dpapi:')) return String(stored);
  const body = String(stored).slice(6);
  if (keyCache.has(body)) return keyCache.get(body);
  if (process.platform !== 'win32') return '';
  try {
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$b = [Convert]::FromBase64String($env:JEV_KEY_STORED)',
      "$d = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')",
      '[Text.Encoding]::UTF8.GetString($d)',
    ].join(';');
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, JEV_KEY_STORED: body },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }).trim();
    keyCache.set(body, out);
    return out;
  } catch {
    return '';
  }
}

function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const maxCalls = Number(source.shadowMaxCalls);
  return {
    enabled: source.enabled === true,
    shadowEnabled: source.shadowEnabled === true,
    shadowMaxCalls: Number.isFinite(maxCalls) ? Math.max(1, Math.min(1000, Math.round(maxCalls))) : 100,
    baseUrl: String(source.baseUrl || JEV_DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    model: String(source.model || 'jev-latest').trim(),
    apiKey: unprotectKey(source.apiKey || ''),
  };
}

export function readJevConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(JEV_CFG_FILE, 'utf8')));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function readSafeJevConfig() {
  const cfg = readJevConfig();
  let encrypted = false;
  try {
    const raw = JSON.parse(fs.readFileSync(JEV_CFG_FILE, 'utf8'));
    encrypted = String(raw?.apiKey || '').startsWith('dpapi:');
  } catch {}
  return {
    enabled: cfg.enabled,
    shadowEnabled: cfg.shadowEnabled,
    shadowMaxCalls: cfg.shadowMaxCalls,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey ? '********' : '',
    keyStored: Boolean(cfg.apiKey),
    storage: encrypted ? 'Windows 系统加密' : '本机明文兜底',
  };
}

export function writeJevConfig(input = {}) {
  const current = readJevConfig();
  const maxCalls = Number(input.shadowMaxCalls ?? current.shadowMaxCalls ?? 100);
  const next = {
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    shadowEnabled: input.shadowEnabled === undefined ? current.shadowEnabled : Boolean(input.shadowEnabled),
    shadowMaxCalls: Number.isFinite(maxCalls) ? Math.max(1, Math.min(1000, Math.round(maxCalls))) : 100,
    baseUrl: String(input.baseUrl || current.baseUrl || JEV_DEFAULT_BASE_URL).trim().replace(/\/+$/, ''),
    model: String(input.model || current.model || 'jev-latest').trim(),
    apiKey: current.apiKey,
  };
  if (input.clearKey === true) {
    next.apiKey = '';
  } else if (input.apiKey !== undefined && input.apiKey !== '' && input.apiKey !== '********') {
    next.apiKey = String(input.apiKey).trim();
  }
  atomicWriteJson(JEV_CFG_FILE, { ...next, apiKey: protectKey(next.apiKey) });
  return next;
}

export function jevEndpoint(baseUrl) {
  const base = String(baseUrl || JEV_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (/\/v1\/systemone$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

export function buildJevRequest({ state, questions, model = 'jev-latest' } = {}) {
  if (state === undefined || state === null || state === '') throw new Error('Jev 请求缺少 state');
  if (!questions || typeof questions !== 'object' || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error('Jev 请求至少需要一个 questions');
  }
  return { model, state, questions };
}

export async function evaluateJev({ state, questions, config = readJevConfig(), timeoutMs = 20000 } = {}) {
  if (!config.apiKey) return { ok: false, error: '还没有配置 Jev API Key' };
  const body = buildJevRequest({ state, questions, model: config.model || 'jev-latest' });
  const response = await fetch(jevEndpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.error || text.slice(0, 240);
    return { ok: false, error: `HTTP ${response.status}: ${String(detail || '请求失败')}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'Jev 返回了无法解析的结果' };
  return { ok: true, data };
}

export async function testJevConfig(input = {}) {
  const disk = readJevConfig();
  const cfg = {
    ...disk,
    ...input,
    apiKey: input.apiKey && input.apiKey !== '********' ? input.apiKey : disk.apiKey,
  };
  const result = await evaluateJev({
    config: cfg,
    state: '这是一次 Jev API 连通测试。',
    questions: {
      connected: {
        type: 'noul',
        instructions: '这段文字是否明确表示这是一次 API 连通测试？',
      },
    },
  });
  if (!result.ok) return result;
  return {
    ok: true,
    data: {
      model: result.data.model || cfg.model,
      connected: result.data.answers?.connected?.noul,
      usage: result.data.usage || null,
    },
  };
}
