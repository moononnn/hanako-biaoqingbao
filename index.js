// 表情包插件 v0.5.0 — Plugin Entry (lifecycle)
// 负责 plugin 激活时的初始化工作
//
// 关键：只导出 onload/onunload, 不要 default export,
// 否则 lifecycle 系统会调用 default(ctx), 但 ctx 没传, 报错
//
// v0.5 改动：增加 lifecycle,让 plugin 能被"激活"
// 之前只有 extensions + routes + tools, plugin 一直 inactive

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resumeBatchTasks } from './routes/_batch-tasks.js';
import { ensureDataDir } from './lib/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || join(homedir(), '.hanako');
const AGENTS_DIR = join(HANA_HOME, 'agents');

// ── 启动时扫描助手列表 ──
function scanAgents() {
  const agents = {};
  if (!existsSync(AGENTS_DIR)) return { agents, error: 'agents 目录不存在' };
  try {
    const dirs = readdirSync(AGENTS_DIR, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const cardPath = join(AGENTS_DIR, d.name, 'card.json');
      if (!existsSync(cardPath)) continue;
      try {
        const card = JSON.parse(readFileSync(cardPath, 'utf-8'));
        const systemPrompt =
          card.prompts?.system ||
          card.system_prompt ||
          card.persona ||
          card.data?.system_prompt ||
          '';
        agents[d.name] = {
          agentId: d.name,
          agentName: card.name || d.name,
          systemPrompt,
          lastScanned: new Date().toISOString()
        };
      } catch (e) {
        // 单个失败不影响其他
      }
    }
  } catch (e) {
    return { agents, error: '读取 agents 目录失败: ' + e.message };
  }
  return { agents, error: null };
}

function appendLog(logPath, line) {
  try {
    const dir = join(logPath, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(logPath, `${ts} ${line}\n`, { flag: 'a', encoding: 'utf-8' });
  } catch (e) {
    // 写日志失败不影响主流程
  }
}

export async function onload(ctx = {}) {
  ctx.log?.info?.('[biaoqingbao] onload 触发, plugin 进入激活状态');

  // v0.17.4 - 确保 data 目录存在（首次安装时）
  ensureDataDir();

  const dataDir = ctx.dataDir;
  if (!dataDir) {
    ctx.log?.warn?.('[biaoqingbao] ctx.dataDir 不存在, 跳过启动扫描');
    return;
  }
  const debugLogPath = join(dataDir, 'observer-debug.log');

  // 启动扫描助手列表
  const { agents: agentCache, error: scanError } = scanAgents();
  const agentIds = Object.keys(agentCache);

  ctx.log?.info?.('[biaoqingbao] 启动扫描完成', {
    agentCount: agentIds.length,
    agents: agentIds,
    error: scanError
  });
  appendLog(
    debugLogPath,
    `[onload] 启动扫描: ${agentIds.length} 个助手: ${agentIds.join(', ')}${
      scanError ? ` 错误: ${scanError}` : ''
    }`
  );

  // 把 agentCache 存到 ctx 让其他模块能访问
  if (typeof ctx === 'object') {
    ctx.__biaoqingbao_state = { agentCache, debugLogPath };
  }

  // v0.12.0 — 恢复上次未完成的批量识图任务
  try {
    const resumed = resumeBatchTasks(ctx);
    if (resumed > 0) {
      ctx.log?.info?.(`[biaoqingbao] 恢复 ${resumed} 个批量识图任务`);
    }
  } catch (e) {
    ctx.log?.warn?.('[biaoqingbao] 恢复批量任务失败:', e.message);
  }

  ctx.log?.info?.('[biaoqingbao] onload 完成');
}

export async function onunload(ctx = {}) {
  ctx.log?.info?.('[biaoqingbao] onunload 触发');
}

// 注意：observer.js 现在使用 Pi SDK Extension API（pi.on() 事件订阅）
// 由 HanaAgent plugin system 自动加载并传给 Pi SDK
// onload 里只做 lifecycle 级别的初始化（扫描 agents 等）