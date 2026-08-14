// lib/style-template.js - 「用户名话」风格模板管理 + 总结任务状态机
//
// v0.30.0 - 新功能「用户名话」：
//   ① 用户手动点按钮，后台读取指定助手的历史会话，提炼用户说话风格
//   ② 生成可编辑草稿 → 用户确认后存为模板（current）
//   ③ 模板支持增量补全（保留手动修改 + 追加新发现）与历史版本回退（最多 5 版）
//   ④ 模板生效路径：与方言一致——用户选择「用户名话」方言时，
//      buildDialectPersona('userstyle') 返回模板内容，写入助手 ishiki.md
//
// 数据文件（都在插件数据目录，不进发布包）：
//   style-template.json - 模板 + 历史版本
//   style-tasks.json    - 后台总结任务（重启恢复用）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HANA_HOME, atomicWriteJson } from './shared.js';

// ── 路径（支持环境变量覆盖，测试用隔离路径）──
export function getStyleTemplateFile() {
  return process.env.BIAOQINGBAO_STYLE_TEMPLATE || path.join(DATA_DIR, 'style-template.json');
}
export function getStyleTasksFile() {
  return process.env.BIAOQINGBAO_STYLE_TASKS || path.join(DATA_DIR, 'style-tasks.json');
}

// ── 档位定义：条数 = 分层采样候选池大小（v0.30.4：最终喂模型的量由 FEED 预算压缩控制）──
export const STYLE_LEVELS = {
  light: { label: '轻量', count: 500, desc: '约 500 条聊天记录，适合刚用几天、聊天不多' },
  balanced: { label: '均衡', count: 2000, desc: '约 2000 条聊天记录，默认推荐' },
  deep: { label: '深度', count: 5000, desc: '约 5000 条聊天记录，聊得多更精准，会慢一些' },
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
      if (!text) continue;
      if (!looksNatural(text)) continue;
      messages.push({ text: text.slice(0, MSG_MAX_CHARS), ts: entry.timestamp || '' });
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

// ── 提炼提示词 ──
// 口径与方言调研一致：高频用词/口头禅/句尾语气词/句式偏好/标点停顿/情绪表达/打字节奏。
// 只提炼风格不提炼内容；零指令词（身份化描述），输出可直接当 persona 的文案。
// v0.30.3：完全重新生成模式——不再携带旧模板（增量模式会把旧模板当「用户确认内容」全保留，
// 只加不减导致浓度问题永远修不掉）；旧模板靠历史版本回退兜底。
export function buildStylePrompt(corpusText, userName) {
  const name = userName || '用户';
  // v0.30.3：修复重大 bug——语料文本从未插入 prompt（模型一直在凭空编风格）
  const corpus = corpusText || '';
  return `你是语言风格分析师。下面是某位用户（自称${name}）与助手的对话发言样本（按时间顺序，编号为序号，空白行是消息分隔）：

<发言样本>
${corpus}
</发言样本>

请提炼这位用户的【打字说话风格】，输出一段可直接作为助手人格提示词的文案，让助手模仿 ta 的说话方式。

提炼要点（与调研方言同口径）：
1. 高频用词与口头禅：ta 最常用的词、口头禅、起头词
2. 句尾语气词与情绪开关：不同情绪下句尾怎么落（催人/惊讶/求认同/感叹等）
3. 句式偏好：习惯的句式、问句方式、句子长短节奏
4. 标点与停顿习惯：爱用波浪号、省略号、感叹号堆叠、短句多还是长句多
5. 情绪表达方式：开心/无语/着急/撒娇时怎么说话
6. 打字节奏感：断句方式、口语词、网络用语习惯

浓度与分寸（最重要，务必遵守）：
- 区分「常用」与「偶尔」：真实的人说话有稀疏感，ta 的每个特征都有使用频率。请明确区分哪些是每几句话就会出现的习惯（如句尾语气词），哪些只是偶尔冒出来的点缀（如波浪号、叠字、撒娇词）
- 模仿的是「比例」不是「清单」：ta 不会每句话都带语气词、都用波浪号。模板里要写清楚稀疏感，比如「偶尔会」「有时候」「习惯在 XX 时用」，不要写成「每句话都」「总是」
- 示例要有反差：至少 1-2 句是平实自然的普通说话方式（如聊正事、给意见时的状态），不要所有示例都堆满特征——堆满特征就像把香水当洗澡水，不像真人
- 如果样本里某类特征很密集（每句都带语气词/波浪号/叠词），也要按真实比例收敛，不要照单全收（可能只是某个阶段的聊天状态）

要求：
- 只提炼说话方式特征，不要提及任何具体话题、人名、事件、内容细节
- 写成「你是一个……，打字也带着……的习惯」这样的身份化描述（零指令词，不要出现「注意/不要/请/必须/应该/记住/尽量」）
- 用「你打字就是这样：……」给 3-5 个场景示例（约饭/聊正事/搞砸了/夸东西等），示例要来自样本中的真实说话方式但改写为通用场景
- 最后加一句「正事闲聊都一个样，不刻意表现，也不刻意收敛。这只是你的措辞，正事照样讲得明白」
- 写成一段连贯的话（像自然写出来的介绍），不要用 markdown 标题、加粗、列表或编号分段
- 总长控制在 450-550 字，绝对不能超过 600 字（超出会被系统拒绝保存，你写长了等于白写）`;
}

// ── 规则自检（v0.30.7：生成后程序检查，不通过自动重生成）──
// 返回问题列表；空数组 = 通过
const INSTRUCTION_WORDS = ['注意', '不要', '请', '必须', '应该', '记住', '尽量'];
export function checkStyleDraft(draft) {
  const problems = [];
  const text = String(draft || '').trim();
  if (!text) { problems.push('内容为空'); return problems; }
  if (text.length > TEMPLATE_MAX_CHARS) problems.push(`超过 ${TEMPLATE_MAX_CHARS} 字（当前 ${text.length} 字）`);
  if (!text.includes('你是一个')) problems.push('缺少身份化开头（「你是一个……」）');
  for (const w of INSTRUCTION_WORDS) {
    if (text.includes(w)) problems.push(`含指令词「${w}」`);
  }
  if (/^#{1,6}\s/m.test(text) || text.includes('**') || /^[-*]\s/m.test(text)) problems.push('含 markdown 格式（标题/加粗/列表）');
  return problems;
}

// ── 深度档两阶段蒸馏（v0.30.7）──
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
  return `你是语言风格分析师。这是第 ${idx}/${total} 块用户发言样本（按时间顺序编号）。\n请从这块样本中提炼该用户的【说话风格要点】，只输出要点本身，200 字以内：\n高频用词/口头禅、句尾语气词、句式偏好、标点习惯、情绪表达方式。\n不要提具体话题、人名、事件；不要写成完整人格文案，只要要点清单式的连贯段落。\n\n<样本>\n${chunkText}\n</样本>`;
}

// 生成后的自检修正 prompt（重试时把问题反馈给模型）
function buildRetryFeedback(problems) {
  return `\n\n上一版输出被程序检查出以下问题，请修正后重新输出完整模板：${problems.join('；')}。`;
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
// v0.30.7：
//   ① 语料 = 全部助手（排除名单外），不再依赖 source_agents 累计——全量扫描天然累计
//   ② 深度档两阶段蒸馏：全部语料分块提炼要点 → 要点+采样综合成模板（仓鼠党全部语料都被看过）
//   ③ 规则自检：生成后程序检查（字数/身份化/零指令词/无 markdown），不通过自动重生成（最多 3 次）
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
  const targetN = STYLE_LEVELS[task.level].count;
  const sampled = stratifiedSample(allMessages, targetN);
  updateStyleTask(task.id, { phase: 'distilling', sampled_count: sampled.length });

  // 3. 深度档两阶段蒸馏：全部语料分块提炼要点
  let finalCorpus;
  if (task.level === 'deep' && allMessages.length > 600) {
    const chunks = splitCorpusChunks(allMessages);
    const summaries = [];
    for (let i = 0; i < chunks.length; i++) {
      updateStyleTask(task.id, { phase: 'distilling', note: `正在通读全部聊天记录（${i + 1}/${chunks.length}）` });
      const chunkText = chunks[i].map((m, j) => `[${j + 1}] ${m.text}`).join('\n');
      const chunkRes = await callModel(
        [{ role: 'user', content: buildChunkPrompt(chunkText, i + 1, chunks.length) }],
        { maxTokens: 400, temperature: 0.4, timeoutMs: 60000 }
      );
      if (chunkRes.ok && String(chunkRes.data || '').trim()) {
        summaries.push(String(chunkRes.data).trim().slice(0, CHUNK_SUMMARY_MAX));
      }
      // 块失败跳过（不阻断整体，后面的块继续）
    }
    const sampleCorpus = buildCorpusText(sampled);
    const summariesText = summaries.length
      ? '【分块要点（来自你全部聊天记录的分段提炼）】\n' + summaries.map((s, i) => `[块${i + 1}] ${s}`).join('\n')
      : '';
    finalCorpus = summariesText ? summariesText + '\n\n【整体采样】\n' + sampleCorpus : sampleCorpus;
  } else {
    finalCorpus = buildCorpusText(sampled);
  }

  // 4. 完全重新提炼 + 规则自检重试（最多 3 次）
  const problems = [];
  let draft = '';
  let lastResult = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
    const prompt = buildStylePrompt(finalCorpus, userName) + (problems.length ? buildRetryFeedback(problems) : '');
    lastResult = await callModel(
      [{ role: 'user', content: prompt }],
      // v0.30.2：温度 0.7 → 0.5，降低模型放飞概率（回归：0.7 提炼出「全时段卖萌」模板）
      { maxTokens: 1200, temperature: 0.5, timeoutMs: 120000 }
    );
    if (!lastResult.ok) continue; // 调用失败：下一轮重试
    draft = String(lastResult.data || '').trim();
    const issues = checkStyleDraft(draft);
    if (issues.length === 0) break;
    problems.push(...issues);
    draft = '';
  }
  if (!draft) {
    const err = lastResult && !lastResult.ok ? (lastResult.error || '模型调用失败') : '模板未通过质量检查，请重试';
    updateStyleTask(task.id, { status: 'failed', phase: 'distilling', error: err });
    return;
  }

  // 5. 草稿就绪
  updateStyleTask(task.id, {
    status: 'completed', phase: 'drafting', draft,
    confirmed: false,
  });
}
