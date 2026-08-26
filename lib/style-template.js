// lib/style-template.js - 「学我说话」风格模板管理 + 总结任务状态机
//
// v0.30.0 - 新功能「学我说话」：
//   ① 用户手动点按钮，后台读取指定助手的历史会话，提炼用户说话风格
//   ② 生成可编辑草稿 → 用户确认后存为模板（current）
//   ③ 模板支持增量补全（保留手动修改 + 追加新发现）与历史版本回退（最多 5 版）
//   ④ 模板生效路径：与方言一致——用户选择「学我说话」方言时，
//      buildDialectPersona('userstyle') 返回模板内容，写入助手 ishiki.md
//
// 数据文件（都在插件数据目录，不进发布包）：
//   style-template.json - 模板 + 历史版本
//   style-tasks.json    - 后台总结任务（重启恢复用）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HANA_HOME, atomicWriteJson } from './shared.js';
// v2：提炼逻辑（baseline/分通道/验收/合并/终检）在新库，这里只做编排与存储
import { CHANNELS, computeBaseline, distilChannel, mergeTemplate, checkStyleDraft } from './style-distill.js';
import { readStyleFeedback, writeStyleProfile } from './style-profile.js';

// ── 路径（支持环境变量覆盖，测试用隔离路径）──
export function getStyleTemplateFile() {
  return process.env.BIAOQINGBAO_STYLE_TEMPLATE || path.join(DATA_DIR, 'style-template.json');
}
export function getStyleTasksFile() {
  return process.env.BIAOQINGBAO_STYLE_TASKS || path.join(DATA_DIR, 'style-tasks.json');
}

// ── 档位定义：条数 = 分层采样候选池大小；通道集 = 提炼精细度（v2）──
// 语义从「聊了多少」升级为「多精细地学你」：light 快省，deep 五路全跑 + 分块要点增强
export const STYLE_LEVELS = {
  light: { label: '轻量', count: 500, channels: ['lexicon', 'syntax'], desc: '约 500 条聊天记录，只提炼高频用词/短语和句式，最快' },
  balanced: { label: '均衡', count: 2000, channels: ['lexicon', 'syntax', 'punct', 'emotion'], desc: '约 2000 条聊天记录，默认推荐，覆盖词汇/句法/标点/情绪' },
  deep: { label: '深度', count: 5000, channels: ['lexicon', 'syntax', 'punct', 'emotion', 'formal'], desc: '约 5000 条聊天记录，五路全跑更精准，会慢一些' },
};
export const STYLE_LEVEL_IDS = Object.keys(STYLE_LEVELS);

// 单条消息截断上限（防爆 token）
export const MSG_MAX_CHARS = 200;
// 草稿模板长度上限
// v0.31.1：历史版本只保留最近一版（足够回退；多了没用，UI 也不展示列表）
export const TEMPLATE_MAX_CHARS = 600;
// 历史版本保留数（回退上一版用）
export const HISTORY_MAX = 1;

// v0.30.4 - 喂给模型的语料预算（回归：5000 条 × 200 字 ≈ 百万字符撑爆上游 API，返回 not valid JSON）
// 风格特征在几百条样本就统计收敛，档位差异体现在「候选池覆盖密度」而不是喂给模型的量
export const FEED_MAX_MSGS = 400;      // 二次抽样后最多喂给模型的条数
const FEED_CHAR_BUDGET = 60000;        // 总字符预算（中文约 3-4 万 token，请求安全）
export const FEED_MIN_CHARS = 40;      // 单条截断下限（太短全是碎片）

// ── 模板存储 ──
// { current: '', history: [ { version, content, saved_at, source_agent, level } ], source_agents: [], last_summarized_at }
function emptyTemplate() {
  return { current: '', history: [], source_agents: [], excluded_agents: [], last_summarized_at: null };
}

export function readStyleTemplate() {
  try {
    const raw = JSON.parse(fs.readFileSync(getStyleTemplateFile(), 'utf-8'));
    const t = { ...emptyTemplate(), ...(raw || {}) };
    if (!Array.isArray(t.history)) t.history = [];
    if (!Array.isArray(t.source_agents)) t.source_agents = [];
    // v0.30.7：排除名单（「从哪些助手学」里取消勾选的助手）
    if (!Array.isArray(t.excluded_agents)) t.excluded_agents = [];
    if (typeof t.current !== 'string') t.current = '';
    return t;
  } catch {
    return emptyTemplate();
  }
}

export function writeStyleTemplate(tpl) {
  const t = {
    current: typeof tpl.current === 'string' ? tpl.current : '',
    history: Array.isArray(tpl.history) ? tpl.history.slice(-HISTORY_MAX) : [],
    source_agents: Array.isArray(tpl.source_agents) ? [...new Set(tpl.source_agents)] : [],
    excluded_agents: Array.isArray(tpl.excluded_agents) ? [...new Set(tpl.excluded_agents)] : [],
    last_summarized_at: tpl.last_summarized_at || null,
  };
  atomicWriteJson(getStyleTemplateFile(), t);
  return t;
}

// v0.30.7：保存排除名单（用户从「从哪些助手学」里取消勾选的助手，记住下次还用）
export function saveExcludedAgents(agentIds) {
  const tpl = readStyleTemplate();
  const next = { ...tpl, excluded_agents: Array.isArray(agentIds) ? [...new Set(agentIds.filter(id => /^[A-Za-z0-9_-]+$/.test(id)))] : [] };
  writeStyleTemplate(next);
  return next;
}

// 确认草稿为当前模板：保存前把旧 current 推入历史（自动备份，最多 HISTORY_MAX 版）
// sourceAgent / level 记录这次总结的来源助手和档位（历史版本列表展示用）
export function confirmStyleDraft(draft, opts = {}) {
  const tpl = readStyleTemplate();
  const text = String(draft || '').trim();
  if (!text) return { ok: false, error: '草稿为空，无法保存' };
  if (text.length > TEMPLATE_MAX_CHARS) {
    return { ok: false, error: `模板太长（${text.length} 字，上限 ${TEMPLATE_MAX_CHARS} 字），请精简后再保存` };
  }
  const history = [...tpl.history];
  if (tpl.current) {
    history.push({
      version: history.length + 1,
      content: tpl.current,
      saved_at: new Date().toISOString(),
      source_agent: tpl.source_agent_of_current || '',
      level: tpl.level_of_current || '',
    });
  }
  const next = {
    current: text,
    history,
    source_agents: opts.sourceAgent && !tpl.source_agents.includes(opts.sourceAgent)
      ? [...tpl.source_agents, opts.sourceAgent]
      : tpl.source_agents,
    source_agent_of_current: opts.sourceAgent || tpl.source_agent_of_current || '',
    level_of_current: opts.level || tpl.level_of_current || '',
    last_summarized_at: new Date().toISOString(),
  };
  // v0.31.1：返回落盘后的数据（writeStyleTemplate 会按 HISTORY_MAX 截断，返回值必须与磁盘一致）
  return { ok: true, data: writeStyleTemplate(next) };
}

// 回退到某历史版本：当前模板先备份进历史（防误操作），再把目标版本设为 current
export function revertStyleTemplate(version) {
  const tpl = readStyleTemplate();
  const target = tpl.history.find((h) => h.version === version);
  if (!target) return { ok: false, error: `找不到历史版本 #${version}` };
  const history = tpl.history.filter((h) => h.version !== version);
  if (tpl.current) {
    history.push({
      version: history.length + 1,
      content: tpl.current,
      saved_at: new Date().toISOString(),
      source_agent: tpl.source_agent_of_current || '',
      level: tpl.level_of_current || '',
    });
  }
  const next = {
    current: target.content,
    history,
    source_agents: tpl.source_agents,
    source_agent_of_current: target.source_agent || '',
    level_of_current: target.level || '',
    last_summarized_at: tpl.last_summarized_at,
  };
  // v0.31.1：同上，返回值与落盘一致（history 截断到最近一版）
  return { ok: true, data: writeStyleTemplate(next) };
}

// 清空模板（含历史），用户主动要求时调用
export function clearStyleTemplate() {
  writeStyleTemplate(emptyTemplate());
  return { ok: true };
}

// ── 会话读取 + 分层采样 ──
// 只读指定助手自己的会话文件（agents/<agentId>/sessions/*.jsonl），
// 过滤出 role === 'user' 的消息；过滤明显非自然语言的内容（代码块/长URL/路径等）。
// 返回 { messages: [{ text, ts }], total }，按时间从旧到新。

// 会话中可能把提醒/思考等宿主元信息包在 role=user 的 content 里；这些内容不属于用户说话，
// 先剥掉外壳再做自然语言判断和入样本，避免“当前时间/工具”等系统词污染风格画像。
const HIDDEN_MESSAGE_BLOCKS = [
  /\[hana_reminder\b[^\]]*\][\s\S]*?\[\/hana_reminder\]/gi,
  /\[hana_(?:reference|context)\b[^\]]*\][\s\S]*?\[\/hana_(?:reference|context)\]/gi,
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<mood\b[^>]*>[\s\S]*?<\/mood>/gi,
  /<(?:think|analysis|reasoning|thinking|pulse)\b[^>]*>[\s\S]*?<\/(?:think|analysis|reasoning|thinking|pulse)>/gi,
  /<file\b[^>]*>[\s\S]*?<\/file>/gi,
  /\[attached_image:[^\]]*\]/gi,
  /\[SessionFile\]\s*\{[^{}]*\}/gi,
  /^\s*\[Use skill:[^\]]*\]\s*/gim,
];

function stripHiddenMessageBlocks(text) {
  let visible = String(text || '');
  for (const re of HIDDEN_MESSAGE_BLOCKS) visible = visible.replace(re, ' ');
  return visible.trim();
}

const GENERATED_MESSAGE_PREFIXES = [
  /^你在海边捡到了一只漂流瓶(?:。|\s)/,
  /^这是一片没有服务器的海，瓶子只在本地世界里漂流/,
  /^📦\s*收到来自/,
  /^📬\s*(?:收到|有)/,
  /^\[图片分析失败[：:]/,
];

function isGeneratedMessage(text) {
  return GENERATED_MESSAGE_PREFIXES.some((re) => re.test(text));
}

const NATURAL_FILTERS = [
  // 代码块（``` 包裹或多行缩进代码特征）
  { re: /```[\s\S]*?```/g, label: '代码块' },
  // 单行长内容（超过 300 字且无标点的疑似粘贴）
  { re: /^[^\n。！？!?，,；;]{300,}$/gm, label: '超长无标点' },
  // 路径（Windows/Linux/macOS）
  { re: /[A-Za-z]:\\[^\s'"]+/g, label: 'Windows路径' },
  { re: /(?:\/home\/|\/Users\/|\/opt\/|\/etc\/|\/var\/)[^\s'"]+/g, label: 'Unix路径' },
  // 长 URL
  { re: /https?:\/\/[^\s'"]{40,}/g, label: '长URL' },
  // 命令行 / shell 片段
  { re: /\b(pip|npm|git|ssh|cd|ls|rm|cp|mv|mkdir|powershell|cmd)\s+[^\n]{10,}/g, label: '命令片段' },
];

function looksNatural(text) {
  if (!text) return false;
  if (typeof text !== 'string') return false;
  if (text.length < 2) return false;
  // 过滤：代码/命令/路径占比过高的消息（替换掉命中片段后，剩余有效内容太少）
  let rest = text;
  for (const f of NATURAL_FILTERS) rest = rest.replace(f.re, ' ');
  const restRatio = rest.trim().length / Math.max(text.length, 1);
  return restRatio >= 0.6;
}

export function collectUserMessages(agentId, agentsRoot = HANA_HOME) {
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(agentId)) {
    return { ok: false, error: `非法助手ID: ${JSON.stringify(agentId)}` };
  }
  const sessionsDir = path.join(path.resolve(agentsRoot, 'agents'), agentId, 'sessions');
  let files;
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl') && !f.includes('.files.json'));
  } catch {
    return { ok: true, messages: [], total: 0 };
  }
  // 从新到旧排，方便优先取近期会话（分桶时近期权重自然高）
  files.sort((a, b) => b.localeCompare(a));

  const messages = [];
  for (const f of files) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(sessionsDir, f), 'utf-8').split('\n');
    } catch { continue; }
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry?.type !== 'message') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'user') continue;
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        // 多段内容：取纯文本段
        text = content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join('\n');
      }
      const visibleText = stripHiddenMessageBlocks(text);
      if (!visibleText || isGeneratedMessage(visibleText)) continue;
      if (!looksNatural(visibleText)) continue;
      messages.push({ text: visibleText.slice(0, MSG_MAX_CHARS), ts: entry.timestamp || '' });
      if (messages.length >= 200000) break; // 安全上限
    }
  }
  return { ok: true, messages, total: messages.length };
}

// 分层采样：按天分桶，近期桶权重高；目标 N 条均匀覆盖时间跨度。
// 数据量不足 N 时全量使用。返回采样后的消息数组（按时间从旧到新）。
export function stratifiedSample(messages, targetN) {
  const n = Math.max(1, Math.floor(targetN) || 1);
  if (messages.length <= n) return [...messages].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // 分桶：按天（ts 前 10 位），无 ts 的放最后桶
  const buckets = new Map();
  for (const m of messages) {
    const key = (m.ts || '').slice(0, 10) || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const dayKeys = [...buckets.keys()].sort();
  // 时间越近权重越高：权重 = 1 + 2 * (index / maxIndex)，近期桶最多 3 倍
  const weights = dayKeys.map((k, i) => 1 + 2 * (i / Math.max(dayKeys.length - 1, 1)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const picked = [];
  // 第一轮：每桶按配额取（至少 1 条，保证时间跨度覆盖；桶内均匀取样）
  for (let i = 0; i < dayKeys.length; i++) {
    const dayMsgs = buckets.get(dayKeys[i]);
    const quota = Math.max(1, Math.round((weights[i] / totalWeight) * n));
    const step = Math.max(1, Math.floor(dayMsgs.length / quota));
    let got = 0;
    for (let j = 0; j < dayMsgs.length && got < quota; j += step) {
      picked.push(dayMsgs[j]);
      got++;
    }
  }
  // 第二轮：配额没取满（小桶步长取整导致），从全局剩余补足
  if (picked.length < n) {
    const pickedSet = new Set(picked);
    for (const m of messages) {
      if (picked.length >= n) break;
      if (!pickedSet.has(m)) picked.push(m);
    }
  }
  // 第三轮：仍超了（每桶至少 1 条导致超出目标），截断到 n
  const final = picked.slice(0, n);
  return final.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// 扫描 agents 目录，返回所有助手 id（v0.30.7：默认全量采集用）
function listAgents(agentsRoot = HANA_HOME) {
  try {
    const dir = path.join(path.resolve(agentsRoot, 'agents'));
    const ids = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^[A-Za-z0-9_-]+$/.test(e.name))
      .map((e) => e.name);
    return ids;
  } catch {
    return [];
  }
}

// 组装给模型的语料文本（二次均匀抽样 + 字符预算压缩）
// v0.30.4：档位候选池 → 抽 FEED_MAX_MSGS 条 → 按预算截断，保证请求不会撑爆上游
export function buildCorpusText(messages) {
  // 二次均匀抽样：从候选池里均匀取 FEED_MAX_MSGS 条（覆盖整个时间跨度）
  let feed = messages;
  if (messages.length > FEED_MAX_MSGS) {
    const step = messages.length / FEED_MAX_MSGS;
    const picked = [];
    for (let i = 0; i < FEED_MAX_MSGS; i++) {
      picked.push(messages[Math.min(messages.length - 1, Math.floor(i * step))]);
    }
    feed = picked;
  }
  // 按预算动态算单条截断长度
  const perMsg = Math.max(FEED_MIN_CHARS, Math.min(MSG_MAX_CHARS, Math.floor(FEED_CHAR_BUDGET / Math.max(feed.length, 1))));
  return feed.map((m, i) => `[${i + 1}] ${m.text.slice(0, perMsg)}`).join('\n');
}

// v2：提炼提示词 / 自检 / 验收已整体迁移到 lib/style-distill.js（分通道 + 提示槽 + 程序化验收）
// buildStylePrompt（v1 单通道整体提炼）与 checkStyleDraft（v1 格式自检）已由新链路取代。

// ── 深度档两阶段蒸馏（v0.30.7，v2 保留为语料增强）──
// 阶段一：全部语料分块 → 每块提炼「分块风格要点」（块摘要）
// 阶段二：所有块摘要 + 整体采样 → 综合成最终模板（仓鼠党：全部聊天记录都被模型看过）
const CHUNK_CHAR_BUDGET = 50000; // 每块字符预算（约 2-3 万 token）
const CHUNK_SUMMARY_MAX = 200;   // 每块要点长度上限

export function splitCorpusChunks(messages, charBudget = CHUNK_CHAR_BUDGET) {
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const m of messages) {
    const len = Math.min(m.text.length, MSG_MAX_CHARS) + 4; // +编号开销
    if (current.length > 0 && currentChars + len > charBudget) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(m);
    currentChars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function buildChunkPrompt(chunkText, idx, total) {
  return `你是语言风格分析师。这是第 ${idx}/${total} 块用户发言样本（按时间顺序编号）。\n请从这块样本中提炼该用户的【说话风格要点】，只输出要点本身，200 字以内：\n高频用词/短语、句尾语气词、句式偏好、标点习惯、情绪表达方式。\n不要提具体话题、人名、事件；不要写成完整人格文案，只要要点清单式的连贯段落。\n\n<样本>\n${chunkText}\n</样本>`;
}

// ── 任务状态机 ──
// task: { id, status: running/completed/failed/cancelled, level, agent_id, phase,
//         total_messages, sampled_count, draft, confirmed, error, created_at, updated_at }

export function genTaskId() {
  return 'st_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

export function readStyleTasks() {
  try {
    const raw = JSON.parse(fs.readFileSync(getStyleTasksFile(), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

export function saveStyleTask(task) {
  const tasks = readStyleTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) tasks[idx] = task;
  else tasks.push(task);
  atomicWriteJson(getStyleTasksFile(), tasks.slice(-50)); // 只留最近 50 个任务
  return task;
}

export function getStyleTask(id) {
  return readStyleTasks().find((t) => t.id === id) || null;
}

// 页面按“最新任务优先”恢复展示：失败不能被更早的旧草稿冒充，后台完成的草稿只认最新任务。
export function getStyleTaskViewState(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const latest = list[0] || null;
  const running = latest?.status === 'running' ? latest : null;
  const latestDraft = latest?.status === 'completed'
    && latest.confirmed !== true
    && typeof latest.draft === 'string'
    && latest.draft.trim()
    ? latest
    : null;
  if (running) {
    return { status: 'running', task_id: running.id || '', draft_task_id: '', error: '' };
  }
  if (latest?.status === 'failed') {
    return { status: 'failed', task_id: latest.id || '', draft_task_id: '', error: String(latest.error || '') };
  }
  if (latestDraft) {
    return { status: 'draft', task_id: latestDraft.id || '', draft_task_id: latestDraft.id || '', error: '' };
  }
  return { status: 'idle', task_id: '', draft_task_id: '', error: '' };
}

// Hana 重启时调用：把遗留的 running 任务标记为 failed（任务本身是内存态，重启即中断）
// 避免 running 残留卡住 hasRunningStyleTask，导致新任务永远创建不了
// 返回处理了几个任务
// v0.30.0 补充：recoverStyleTasks 在 index.js onload 里调用（参考坑 49：onload 只做轻活）
export function recoverStyleTasks() {
  const tasks = readStyleTasks();
  let recovered = 0;
  const next = tasks.map((t) => {
    if (t.status === 'running') {
      recovered++;
      return { ...t, status: 'failed', phase: 'reading', error: 'Hana 重启导致任务中断，请重新总结', updated_at: new Date().toISOString() };
    }
    return t;
  });
  if (recovered > 0) atomicWriteJson(getStyleTasksFile(), next);
  return recovered;
}

export function hasRunningStyleTask() {
  return readStyleTasks().some((t) => t.status === 'running');
}

// 创建任务（不启动执行，由路由层 startStyleTask 执行）
export function createStyleTask(agentId, level) {
  if (!STYLE_LEVELS[level]) return { ok: false, error: '无效的档位' };
  if (hasRunningStyleTask()) return { ok: false, error: '已有总结任务在跑，请等它完成' };
  const task = {
    id: genTaskId(),
    status: 'running',
    level,
    agent_id: agentId,
    phase: 'reading',
    total_messages: 0,
    sampled_count: 0,
    draft: '',
    confirmed: false,
    error: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  saveStyleTask(task);
  return { ok: true, task };
}

export function updateStyleTask(id, patch) {
  const task = getStyleTask(id);
  if (!task) return null;
  Object.assign(task, patch, { updated_at: new Date().toISOString() });
  saveStyleTask(task);
  return task;
}

// 执行总结任务（后台调用；callModel 由路由层注入，负责调内容分析模型）
// v2 分通道流水线：
//   ① 语料 = 全部助手（排除名单外），全量扫描天然累计
//   ② 纯程序算统计基线（computeBaseline，唯一事实源）
//   ③ 深度档分块要点增强语料（保留仓鼠党价值：全部语料都被模型看过一遭）
//   ④ 分通道提炼：按档位通道集逐路跑，单路 weak/failed 不阻断整体，通道粒度写进度
//   ⑤ 分层合并润色：程序定骨架、模型写话，终检浓度/绝对化/locked
//   ⑥ 产物：persona 草稿 + 数据画像快照（style-profile.json）
export async function runStyleTask(task, callModel, userName, agentsRoot = HANA_HOME) {
  // 1. 读会话（全部助手 - 排除名单；排除名单为空时扫描全部）
  updateStyleTask(task.id, { phase: 'reading' });
  const tpl = readStyleTemplate();
  const excluded = new Set(tpl.excluded_agents || []);
  const agentIds = listAgents(agentsRoot).filter((id) => !excluded.has(id));
  if (agentIds.length === 0) {
    updateStyleTask(task.id, { status: 'failed', phase: 'reading', error: '没有可用的助手（可能全部被排除了）' });
    return;
  }
  const allMessages = [];
  let total = 0;
  for (const id of agentIds) {
    const collected = collectUserMessages(id, agentsRoot);
    if (!collected.ok) continue; // 单助手失败不阻断整体（如某助手目录被删）
    total += collected.total;
    allMessages.push(...collected.messages);
  }
  if (allMessages.length === 0) {
    updateStyleTask(task.id, { status: 'failed', phase: 'reading', error: '没有找到可用的发言记录（会话文件为空或都被排除）' });
    return;
  }

  // 2. 分层采样到档位候选池
  updateStyleTask(task.id, { phase: 'sampling', total_messages: total });
  const levelConf = STYLE_LEVELS[task.level];
  const sampled = stratifiedSample(allMessages, levelConf.count);
  updateStyleTask(task.id, { phase: 'baseline', sampled_count: sampled.length, note: '正在统计你的说话习惯…' });

  // 3. 统计基线（纯程序，不靠模型感觉）
  const baseline = computeBaseline(sampled);

  // 4. 深度档分块要点增强语料（仓鼠党价值保留：全部语料都被模型看过一遭）
  let corpusText = buildCorpusText(sampled);
  if (task.level === 'deep' && allMessages.length > 600) {
    const chunks = splitCorpusChunks(allMessages);
    const summaries = [];
    for (let i = 0; i < chunks.length; i++) {
      updateStyleTask(task.id, { phase: 'distilling', note: `正在通读全部聊天记录（${i + 1}/${chunks.length}）` });
      const chunkText = chunks[i].map((m, j) => `[${j + 1}] ${m.text}`).join('\n');
      const chunkRes = await callModel(
        [{ role: 'user', content: buildChunkPrompt(chunkText, i + 1, chunks.length) }],
        // 分块只要求 200 字要点，但给思考型/兼容模型留出安全余量；
        // 选定 Hana 模型会额外关闭思考，custom 模型也不至于被小预算截断。
        { maxTokens: 800, temperature: 0.4, timeoutMs: 60000 }
      );
      if (chunkRes.ok && String(chunkRes.data || '').trim()) {
        summaries.push(String(chunkRes.data).trim().slice(0, CHUNK_SUMMARY_MAX));
      }
      // 块失败跳过（不阻断整体，后面的块继续）
    }
    if (summaries.length) {
      const summariesText = '【分块要点（来自你全部聊天记录的分段提炼）】\n' + summaries.map((s, i) => `[块${i + 1}] ${s}`).join('\n');
      corpusText = summariesText + '\n\n【整体采样】\n' + corpusText;
    }
  }

  // 5. 分通道提炼（通道粒度进度；单路 weak 保底，全部 failed 才整体失败）
  const feedback = readStyleFeedback();
  const channels = {};
  let anyOk = false;
  for (const key of levelConf.channels) {
    updateStyleTask(task.id, { phase: 'distilling', channel: key, note: `正在分析你的${CHANNELS[key].label}习惯…` });
    const r = await distilChannel(key, corpusText, baseline, userName, callModel);
    channels[key] = r;
    updateStyleTask(task.id, { channel: key, channel_status: r.status, channel_features: (r.features || []).length });
    if (r.status !== 'failed') anyOk = true;
  }
  if (!anyOk) {
    const lastFailed = channels[levelConf.channels[levelConf.channels.length - 1]];
    const err = (lastFailed && lastFailed.problems && lastFailed.problems[0]) || '所有通道提炼失败';
    updateStyleTask(task.id, { status: 'failed', phase: 'distilling', error: err });
    return;
  }

  // 6. 分层合并润色（终检含浓度/绝对化/locked 复核）
  updateStyleTask(task.id, { phase: 'merging', note: '正在组织人格文案…' });
  const merged = await mergeTemplate(channels, baseline, feedback, userName, callModel);
  if (!merged.ok) {
    updateStyleTask(task.id, { status: 'failed', phase: 'merging', error: merged.error });
    return;
  }

  // 7. 存画像快照 + 草稿就绪
  writeStyleProfile({
    built_at: new Date().toISOString(),
    level: task.level,
    source_agents: tpl.source_agents,
    baseline,
    channels,
  });
  updateStyleTask(task.id, {
    status: 'completed', phase: 'drafting', draft: merged.draft,
    confirmed: false,
  });
}
