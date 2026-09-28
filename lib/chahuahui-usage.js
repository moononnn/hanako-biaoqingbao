// 可选外部来源记录：只读茶话会自己的公开表情包使用账本。
// 不读聊天正文、不写回茶话会，也不影响表情包插件主流程。
import fs from 'node:fs';
import path from 'node:path';
import { HANA_HOME } from './shared.js';

export const CHAHUAHUI_USAGE_SCHEMA_VERSION = 1;
// 茶话会是 Hana v2 App，ctx.dataDir 的真实位置是 app-data/chahuahui，不是插件数据目录。
export const CHAHUAHUI_USAGE_FILE = path.join('app-data', 'chahuahui', 'v2', 'sticker-usage.json');
const MAX_EVENTS = 500;

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLength);
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object') return null;
  const stickerId = cleanText(input.stickerId, 120);
  const partnerId = cleanText(input.partnerId, 120);
  const sentAt = cleanText(input.sentAt, 40);
  if (!stickerId || !partnerId || !sentAt || !Number.isFinite(Date.parse(sentAt))) return null;
  return { stickerId, partnerId, sentAt };
}

export function chahuahuiUsagePath(hanaHome = HANA_HOME) {
  return path.join(String(hanaHome || ''), CHAHUAHUI_USAGE_FILE);
}

export function readChahuahuiUsage({ hanaHome = HANA_HOME, fsModule = fs } = {}) {
  try {
    const raw = JSON.parse(fsModule.readFileSync(chahuahuiUsagePath(hanaHome), 'utf8'));
    if (Number(raw?.schemaVersion) !== CHAHUAHUI_USAGE_SCHEMA_VERSION) return [];
    return (Array.isArray(raw.events) ? raw.events : [])
      .map(normalizeEvent)
      .filter(Boolean)
      .slice(-MAX_EVENTS);
  } catch {
    return [];
  }
}

export function summarizeChahuahuiUsage(events, { limit = 40 } = {}) {
  const bySticker = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const current = bySticker.get(event.stickerId);
    if (!current) {
      bySticker.set(event.stickerId, {
        stickerId: event.stickerId,
        partnerId: event.partnerId,
        lastSentAt: event.sentAt,
        lastSentMs: Date.parse(event.sentAt),
        count: 1,
      });
      continue;
    }
    current.count += 1;
    const eventMs = Date.parse(event.sentAt);
    if (eventMs > current.lastSentMs) {
      current.partnerId = event.partnerId;
      current.lastSentAt = event.sentAt;
      current.lastSentMs = eventMs;
    }
  }
  return [...bySticker.values()]
    .sort((a, b) => b.lastSentMs - a.lastSentMs)
    .map(({ lastSentMs, ...row }) => row)
    .slice(0, Math.max(1, Math.min(Number(limit) || 40, 100)));
}
