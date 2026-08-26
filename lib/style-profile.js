// lib/style-profile.js - 学我说话 v2：数据画像（profile）+ 修正回流（feedback）存储
//
// 只负责两个新数据文件的读写与反例/锁定合并，不碰提炼逻辑（style-distill）与任务状态机（style-template）。
//   style-profile.json   - 每次提炼生成的快照画像（baseline + 通道结果），下次提炼覆盖
//   style-feedback.json  - 跨次累积的反例库 + 锁定特征，不随画像重建丢失
//
// v2 设计文档：学我说话-v2-设计.md

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

// ── 路径（支持环境变量覆盖，测试用隔离路径）──
export function getStyleProfileFile() {
  return process.env.BIAOQINGBAO_STYLE_PROFILE || path.join(DATA_DIR, 'style-profile.json');
}
export function getStyleFeedbackFile() {
  return process.env.BIAOQINGBAO_STYLE_FEEDBACK || path.join(DATA_DIR, 'style-feedback.json');
}

// 反例库容量上限（保留最近 N 条，防无限膨胀；锁定特征同理）
export const FEEDBACK_MAX = 40;

// ── style-profile.json ──
function emptyProfile() {
  return { built_at: null, level: '', source_agents: [], baseline: null, channels: {} };
}

export function readStyleProfile() {
  try {
    const raw = JSON.parse(fs.readFileSync(getStyleProfileFile(), 'utf-8'));
    const p = { ...emptyProfile(), ...(raw || {}) };
    if (!Array.isArray(p.source_agents)) p.source_agents = [];
    if (!p.baseline || typeof p.baseline !== 'object') p.baseline = null;
    if (!p.channels || typeof p.channels !== 'object') p.channels = {};
    return p;
  } catch {
    return emptyProfile();
  }
}

export function writeStyleProfile(profile) {
  const p = {
    built_at: profile.built_at || new Date().toISOString(),
    level: profile.level || '',
    source_agents: Array.isArray(profile.source_agents) ? [...new Set(profile.source_agents)] : [],
    baseline: profile.baseline || null,
    channels: profile.channels || {},
  };
  atomicWriteJson(getStyleProfileFile(), p);
  return p;
}

// ── style-feedback.json ──
function emptyFeedback() {
  return { counterexamples: [], locked: [] };
}

export function readStyleFeedback() {
  try {
    const raw = JSON.parse(fs.readFileSync(getStyleFeedbackFile(), 'utf-8'));
    const fb = { ...emptyFeedback(), ...(raw || {}) };
    if (!Array.isArray(fb.counterexamples)) fb.counterexamples = [];
    if (!Array.isArray(fb.locked)) fb.locked = [];
    return fb;
  } catch {
    return emptyFeedback();
  }
}

export function writeStyleFeedback(fb) {
  const out = {
    counterexamples: Array.isArray(fb.counterexamples) ? fb.counterexamples.slice(-FEEDBACK_MAX) : [],
    locked: Array.isArray(fb.locked) ? fb.locked.slice(-FEEDBACK_MAX) : [],
  };
  atomicWriteJson(getStyleFeedbackFile(), out);
  return out;
}

// 把用户修订 diff（{ removed:[句子], added:[句子] }）沉淀进反馈库（去重）
// source：谁触发的（user-edit 编辑器 / conversation-api 对话式修订），默认 user-edit
export function mergeDiffIntoFeedback(deltas, source = 'user-edit') {
  const fd = readStyleFeedback();
  const now = new Date().toISOString();
  let changed = false;
  for (const r of deltas?.removed || []) {
    if (typeof r !== 'string' || !r.trim()) continue;
    if (fd.counterexamples.every((c) => c.feature !== r)) {
      fd.counterexamples.push({ feature: r, reason: '用户删除', source, at: now });
      changed = true;
    }
  }
  for (const a of deltas?.added || []) {
    if (typeof a !== 'string' || !a.trim()) continue;
    if (fd.locked.every((l) => l.content !== a)) {
      fd.locked.push({ content: a, source, at: now });
      changed = true;
    }
  }
  if (changed) writeStyleFeedback(fd);
  return fd;
}
