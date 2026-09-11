/**
 * v0.34.33 - 伙伴隐藏名单（真正的「移除后不再出现」）。
 *
 * 背景：v0.25.2 的 /api/agents/remove 只清理该伙伴在插件里的数据，不留任何名单，
 * 所以「刷新列表」甚至重启后 ta 都会重新出现。设计初衷是「自由度交给用户」，
 * 但对那些挂在 Hana 里却不算伙伴的 agent（测试探针之类），每次都要重新移除很烦。
 *
 * 现在「移除」= 清数据 + 进隐藏名单，列表和刷新都不再带出 ta；
 * 想找回来用 /api/agents/unhide（前端入口是「已隐藏」弹窗）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, atomicWriteJson } from './shared.js';

export const HIDDEN_AGENTS_FILE_NAME = 'hidden-agents.json';

function filePathOf(dataDir) {
  return path.join(dataDir || DATA_DIR, HIDDEN_AGENTS_FILE_NAME);
}

/** 名单永远是一组去重、去空的字符串，坏数据当作空名单。 */
export function normalizeHiddenAgents(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const id = String(item == null ? '' : item).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function readHiddenAgents({ dataDir = DATA_DIR } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePathOf(dataDir), 'utf-8'));
    return normalizeHiddenAgents(raw && raw.hidden);
  } catch {
    // 文件不存在或坏了都当空名单：隐藏是附加功能，不能因为它读不动就拦住整个列表。
    return [];
  }
}

export function writeHiddenAgents(list, { dataDir = DATA_DIR } = {}) {
  const hidden = normalizeHiddenAgents(list);
  atomicWriteJson(filePathOf(dataDir), { version: 1, hidden });
  return hidden;
}

export function hideAgent(agentId, { dataDir = DATA_DIR } = {}) {
  const id = String(agentId == null ? '' : agentId).trim();
  if (!id) return readHiddenAgents({ dataDir });
  const current = readHiddenAgents({ dataDir });
  if (current.includes(id)) return current;
  return writeHiddenAgents([...current, id], { dataDir });
}

export function unhideAgent(agentId, { dataDir = DATA_DIR } = {}) {
  const id = String(agentId == null ? '' : agentId).trim();
  const current = readHiddenAgents({ dataDir });
  if (!id || !current.includes(id)) return current;
  return writeHiddenAgents(current.filter((x) => x !== id), { dataDir });
}

/** 列表过滤：隐藏的伙伴不进任何面向用户的清单。 */
export function isAgentHidden(agentId, hiddenList) {
  const id = String(agentId == null ? '' : agentId).trim();
  if (!id) return false;
  return normalizeHiddenAgents(hiddenList).includes(id);
}

export function filterHiddenAgents(agents, hiddenList) {
  const hidden = new Set(normalizeHiddenAgents(hiddenList));
  return (Array.isArray(agents) ? agents : []).filter((agent) => {
    const id = String(agent && agent.id ? agent.id : '').trim();
    return id && !hidden.has(id);
  });
}
