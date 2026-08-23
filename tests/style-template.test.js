// tests/style-template.test.js - 学我说话：模板管理 + 采样 + 任务状态机
// 覆盖：分层采样、自然语言过滤、模板确认/回退/清空、任务并发与状态迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STYLE_LEVELS, STYLE_LEVEL_IDS,
  readStyleTemplate, writeStyleTemplate, confirmStyleDraft, revertStyleTemplate, clearStyleTemplate,
  saveExcludedAgents,
  collectUserMessages, stratifiedSample, buildCorpusText, buildStylePrompt,
  createStyleTask, getStyleTask, updateStyleTask, hasRunningStyleTask, runStyleTask,
  recoverStyleTasks,
  MSG_MAX_CHARS, TEMPLATE_MAX_CHARS, HISTORY_MAX,
} from '../lib/style-template.js';
import {
  writeDialectConfig, syncUserstyleToIshiki, readDialectFromIshiki, _resetDialectCache,
} from '../lib/dialect.js';

// ── 测试隔离：临时数据目录 ──
const tempDirs = [];
function useTempData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-style-test-'));
  process.env.BIAOQINGBAO_STYLE_TEMPLATE = path.join(dir, 'style-template.json');
  process.env.BIAOQINGBAO_STYLE_TASKS = path.join(dir, 'style-tasks.json');
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// 造会话文件：agentId/sessions/xxx.jsonl
function makeSessionFile(agentsRoot, agentId, userTexts) {
  const dir = path.join(agentsRoot, 'agents', agentId, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const lines = userTexts.map((t, i) => JSON.stringify({
    type: 'message',
    timestamp: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T12:00:00.000Z`,
    message: { role: i % 3 === 0 ? 'assistant' : 'user', content: t },
  }));
  // 混入非 message 行和坏行
  lines.push('{"type":"other","x":1}');
  lines.push('not-json-line');
  fs.writeFileSync(path.join(dir, 'test-session.jsonl'), lines.join('\n'), 'utf-8');
}

test('collectUserMessages：只收 user 消息、跳过坏行、过滤非自然语言', () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', [
    '今天天气真好呀，晚上吃啥？',
    '这个方案我觉得不错',
    '```js\nconst x = 1;\n```',
    'C:\\Users\\laotv\\test\\file.txt 看一下',
    '哈哈哈哈笑死我了',
    '帮我看看这个代码 bug',
    'https://github.com/moononnn/hanako-biaoqingbao/releases/tag/v0.29.0 这个版本更新了啥',
  ]);
  const res = collectUserMessages('hanako', root);
  assert.ok(res.ok);
  // 7 条消息中 role=user 的有 4 条（索引 1,2,4,5）：代码块被过滤 → 剩 3 条自然语言
  assert.equal(res.total, 3, '应过滤掉代码块');
  const texts = res.messages.map(m => m.text);
  assert.ok(texts.some(t => t.includes('方案我觉得不错')), '应保留闲聊');
  assert.ok(texts.some(t => t.includes('代码 bug')), '应保留技术讨论（短句）');
});

test('collectUserMessages：非法 agentId 返回结构化错误', () => {
  const root = useTempData();
  const res = collectUserMessages('../evil', root);
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('stratifiedSample：数据量不足时全量返回', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ text: 'm' + i, ts: `2026-08-${String(i + 1).padStart(2, '0')}` }));
  const out = stratifiedSample(msgs, 500);
  assert.equal(out.length, 10, '不足目标数应全量返回');
});

test('stratifiedSample：超过目标数时按目标取样且覆盖时间跨度', () => {
  const msgs = [];
  // 60 天，每天 50 条 = 3000 条
  for (let d = 1; d <= 60; d++) {
    for (let i = 0; i < 50; i++) {
      msgs.push({ text: `d${d}-m${i}`, ts: `2026-06-${String(d).padStart(2, '0')}T10:00:00.000Z` });
    }
  }
  const out = stratifiedSample(msgs, 500);
  assert.equal(out.length, 500, '应取满目标数');
  // 覆盖时间跨度：最早和最晚的日期都应出现在样本里（权重差异不影响极端覆盖）
  const days = new Set(out.map(m => m.ts.slice(0, 10)));
  assert.ok(days.size >= 40, `样本应覆盖大多数天数，实际 ${days.size} 天`);
  // 时间有序
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].ts >= out[i - 1].ts, '样本应按时间排序');
  }
});

test('stratifiedSample：近期权重高（同日期占比随日期靠后增加）', () => {
  const msgs = [];
  for (let d = 1; d <= 30; d++) {
    for (let i = 0; i < 20; i++) {
      msgs.push({ text: `d${d}`, ts: `2026-07-${String(d).padStart(2, '0')}T10:00:00.000Z` });
    }
  }
  const out = stratifiedSample(msgs, 300);
  // 第 1 天和第 30 天的样本量：近期应不少于早期
  const countDay = (day) => out.filter(m => m.ts.slice(8, 10) === String(day).padStart(2, '0')).length;
  assert.ok(countDay(30) >= countDay(1), `近期天数样本应不少于早期（day30=${countDay(30)}, day1=${countDay(1)}）`);
});

test('buildCorpusText：语料预算压缩（回归：5000 条全量塞入撑爆上游）', () => {
  // 构造 5000 条消息（模拟深度档候选池）
  const msgs = Array.from({ length: 5000 }, (_, i) => ({
    text: '消息' + i + '这是一段比较长的自然语言内容'.repeat(10),
    ts: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
  const corpus = buildCorpusText(msgs);
  // 条数被压到 FEED_MAX_MSGS
  const lines = corpus.split('\n').filter(l => l.trim());
  assert.equal(lines.length, 400, '最多喂 400 条');
  // 总字符在预算内（60000 + 编号开销余量）
  assert.ok(corpus.length <= 70000, `总字符应控制在预算内，实际 ${corpus.length}`);
  // 覆盖时间跨度（首尾消息都在）
  assert.ok(corpus.includes('[1] 消息0'), '应包含最早的候选');
  assert.ok(corpus.includes('[400]'), '应包含最晚的候选');
  // 数据少时全量喂
  const small = buildCorpusText([{ text: '短消息', ts: '2026-08-01' }, { text: '另一条', ts: '2026-08-02' }]);
  assert.equal(small.split('\n').filter(l => l.trim()).length, 2, '数据少时全量');
});

test('buildCorpusText / buildStylePrompt：语料带编号、prompt 含要点与隐私口径', () => {
  const corpus = buildCorpusText([{ text: '你好呀', ts: '2026-08-01' }, { text: '哈哈', ts: '2026-08-02' }]);
  assert.ok(corpus.includes('[1] 你好呀'));
  assert.ok(corpus.includes('[2] 哈哈'));
  const prompt = buildStylePrompt(corpus, '测试用户');
  assert.ok(prompt.includes('说话风格'), '应有风格提炼要求');
  assert.ok(prompt.includes('不要提及任何具体话题'), '应有隐私口径');
  assert.ok(prompt.includes('测试用户'), '应带用户名');
  // v0.30.3：语料必须插入 prompt（回归：第一版起 corpusText 从未插入，模型一直在凭空编风格）
  assert.ok(prompt.includes('[1] 你好呀'), 'prompt 应包含语料文本');
  assert.ok(prompt.includes('[2] 哈哈'), 'prompt 应包含全部语料');
  assert.ok(prompt.includes('<发言样本>'), '应有语料标记块');
  // v0.30.2：浓度与分寸要求（回归：0.7 温度+无浓度约束提炼出「每句卖萌」模板）
  assert.ok(prompt.includes('浓度与分寸'), '应有浓度与分寸要求');
  assert.ok(prompt.includes('区分「常用」与「偶尔」'), '应要求区分常用与偶尔');
  assert.ok(prompt.includes('不要所有示例都堆满特征'), '应要求示例有反差');
  // v0.30.3：完全重新生成——prompt 不携带旧模板内容
  assert.ok(!prompt.includes('<现有模板>'), '重新生成模式不应携带旧模板');
});

test('模板管理：确认保存 → 自动备份历史 → 回退 → 清空', () => {
  useTempData();
  // 首次确认
  let res = confirmStyleDraft('模板A', { sourceAgent: 'hanako', level: 'balanced' });
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板A');
  assert.equal(res.data.history.length, 0, '首次保存无历史');
  // 第二次确认：旧模板进历史
  res = confirmStyleDraft('模板B', { sourceAgent: 'agentB', level: 'deep' });
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板B');
  assert.equal(res.data.history.length, 1);
  assert.equal(res.data.history[0].content, '模板A');
  assert.ok(res.data.source_agents.includes('hanako'));
  assert.ok(res.data.source_agents.includes('agentB'));
  // 回退到 #1
  res = revertStyleTemplate(1);
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板A', '回退后当前模板应为模板A');
  assert.equal(res.data.history.length, 1, '回退时当前模板自动备份');
  // 回退不存在的版本
  res = revertStyleTemplate(99);
  assert.equal(res.ok, false);
  // 清空
  res = clearStyleTemplate();
  assert.ok(res.ok);
  const tpl = readStyleTemplate();
  assert.equal(tpl.current, '');
  assert.equal(tpl.history.length, 0);
});

test('模板管理：空草稿拒绝、超长草稿拒绝、历史上限', () => {
  useTempData();
  let res = confirmStyleDraft('   ');
  assert.equal(res.ok, false, '空草稿应拒绝');
  res = confirmStyleDraft('x'.repeat(TEMPLATE_MAX_CHARS + 10));
  assert.equal(res.ok, false, '超长草稿应拒绝');
  // 连续确认 HISTORY_MAX 次，历史不超过上限
  for (let i = 1; i <= HISTORY_MAX + 3; i++) {
    res = confirmStyleDraft('模板' + i);
    assert.ok(res.ok);
  }
  const tpl = readStyleTemplate();
  assert.ok(tpl.history.length <= HISTORY_MAX, `历史最多 ${HISTORY_MAX} 版`);
});

test('模板管理：历史只保留最近一版，回退可逆（v0.31.1）', () => {
  useTempData();
  // 连续保存三版：history 永远只留最近被替换掉的那版
  confirmStyleDraft('模板A', { sourceAgent: 'hanako' });
  confirmStyleDraft('模板B', { sourceAgent: 'hanako' });
  let res = confirmStyleDraft('模板C', { sourceAgent: 'hanako' });
  assert.equal(res.data.current, '模板C');
  assert.equal(res.data.history.length, 1, '历史只保留最近一版');
  assert.equal(res.data.history[0].content, '模板B', '上一版 = 最近被替换的模板B');

  // 返回上一版：current 变 B，上一版自动备份为 C（可再点一次换回来）
  res = revertStyleTemplate(res.data.history[0].version);
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板B', '回退后当前应为上一版');
  assert.equal(res.data.history.length, 1);
  assert.equal(res.data.history[0].content, '模板C', '回退后上一版应为刚换下来的 C');

  // 再回退一次：回到 C（往返可逆）
  res = revertStyleTemplate(res.data.history[0].version);
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板C');
  assert.equal(res.data.history[0].content, '模板B');
});

test('任务状态机：创建 → 运行中唯一 → 更新 → 读取', () => {
  useTempData();
  const a = createStyleTask('hanako', 'balanced');
  assert.ok(a.ok);
  assert.equal(a.task.status, 'running');
  assert.equal(a.task.phase, 'reading');
  // 并发：第二个任务被拒
  const b = createStyleTask('hanako', 'deep');
  assert.equal(b.ok, false);
  assert.ok(b.error.includes('在跑'));
  // 更新
  updateStyleTask(a.task.id, { phase: 'sampling', total_messages: 100 });
  const t = getStyleTask(a.task.id);
  assert.equal(t.phase, 'sampling');
  assert.equal(t.total_messages, 100);
  // 结束运行中后可以再开
  updateStyleTask(a.task.id, { status: 'failed' });
  assert.equal(hasRunningStyleTask(), false);
  const c = createStyleTask('agentB', 'light');
  assert.ok(c.ok);
  // 非法档位
  const d = createStyleTask('agentB', 'huge');
  assert.equal(d.ok, false);
});

test('runStyleTask：完整链路（读会话 → 采样 → 调模型 → 草稿）', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', [
    '今天天气真好呀',
    '这个方案我觉得不错',
    '哈哈哈哈笑死我了',
    '帮我看看这个代码 bug',
    '晚上吃啥，走不走',
  ]);
  const created = createStyleTask('hanako', 'light');
  assert.ok(created.ok);
  const task = created.task;
  let called = 0;
  const fakeModel = async (messages, opts) => {
    called++;
    assert.ok(messages.length === 1);
    assert.ok(messages[0].content.includes('语言风格分析师'), '应走提炼 prompt');
    assert.ok(opts.maxTokens > 0);
    return { ok: true, data: '你是一个说话带点俏皮的人，打字也带着你的习惯……' };
  };
  await runStyleTask(task, fakeModel, '测试用户', root);
  const t = getStyleTask(task.id);
  assert.equal(t.status, 'completed');
  assert.equal(t.phase, 'drafting');
  assert.ok(t.draft.includes('俏皮'));
  assert.equal(t.sampled_count, 3, '过滤后可用发言为 3 条');
  assert.equal(called, 1);
});

test('runStyleTask：模型失败重试（上游偶发故障自愈，最多 3 次）', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '哈哈']);
  const created = createStyleTask('all', 'light');
  let calls = 0;
  const fakeModel = async () => {
    calls++;
    if (calls === 1) return { ok: false, error: 'Upstream response was not valid JSON' };
    return { ok: true, data: '你是一个说话带点俏皮的人，打字也带着你的习惯……' };
  };
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'completed', '重试后应成功');
  assert.equal(t.draft, '你是一个说话带点俏皮的人，打字也带着你的习惯……');
  assert.equal(calls, 2, '应调用两次');
});

test('runStyleTask：规则自检不通过时自动重生成（最多 3 次）', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '哈哈']);
  const created = createStyleTask('all', 'light');
  let calls = 0;
  const fakeModel = async (messages) => {
    calls++;
    // 第 1 次：缺身份化开头 + 超长；第 2 次：含指令词；第 3 次：合规
    if (calls === 1) return { ok: true, data: '没有身份开头的模板'.repeat(100) };
    if (calls === 2) return { ok: true, data: '你是一个……请注意不要这样说话' };
    return { ok: true, data: '你是一个说话带着自己节奏的人，打字也带着这种习惯，正事闲聊都一个样。' };
  };
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'completed');
  assert.equal(calls, 3, '前两次不合规应自动重生成');
  // 第 2 次调用应带修正反馈
  // （无法直接断言 prompt 内容，通过 calls=3 且成功验证链路）
});

test('runStyleTask：多次重试仍不合规 → failed', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '哈哈']);
  const created = createStyleTask('all', 'light');
  const fakeModel = async () => ({ ok: true, data: '没有身份开头的模板'.repeat(100) }); // 永远超长
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'failed');
  assert.ok(t.error.includes('质量检查'), '应提示未通过质量检查');
});

test('runStyleTask：排除名单生效（被排除的助手语料不参与）', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '这个方案我觉得不错', '哈哈哈哈哈']);
  makeSessionFile(root, 'agentB', ['这个也好玩呀', '明天一起去不', '嗯嗯好呀']);
  // 排除 agentB
  const tpl = readStyleTemplate();
  writeStyleTemplate({ ...tpl, excluded_agents: ['agentB'] });
  const created = createStyleTask('all', 'light');
  let promptText = '';
  const fakeModel = async (messages) => {
    promptText = messages[0].content;
    return { ok: true, data: '你是一个说话带着自己节奏的人，打字也带着这种习惯。' };
  };
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'completed');
  assert.equal(t.sampled_count, 2, '只有 hanako 的 user 消息（agentB 被排除）');
  assert.ok(promptText.includes('这个方案我觉得不错'), '语料应含 hanako 发言');
  assert.ok(!promptText.includes('明天一起去不'), '语料不应含被排除助手的发言');
});

test('runStyleTask：深度档两阶段蒸馏（分块要点 + 整体采样）', async () => {
  const root = useTempData();
  // 造 1000 条消息（user 消息约 667 条 > 600 触发两阶段）
  const texts = Array.from({ length: 1000 }, (_, i) => '日常发言' + i + '今天天气不错呀');
  makeSessionFile(root, 'hanako', texts);
  const created = createStyleTask('all', 'deep');
  let sawChunkPrompt = false;
  let sawFinalPrompt = false;
  const fakeModel = async (messages) => {
    const content = messages[0].content;
    if (content.includes('第 1/') && content.includes('风格要点')) sawChunkPrompt = true;
    if (content.includes('语言风格分析师') && content.includes('发言样本')) sawFinalPrompt = true;
    return { ok: true, data: sawChunkPrompt && !content.includes('风格要点') ? '你是一个说话带着自己节奏的人，打字也带着这种习惯。' : '这一块样本的要点是：爱用语气词，说话简短。' };
  };
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'completed');
  assert.ok(sawChunkPrompt, '应调用分块提炼');
  assert.ok(sawFinalPrompt, '应调用综合提炼');
  assert.ok(t.draft.includes('你是一个'), '最终模板应为合规模板');
});

test('runStyleTask：模型失败 → 任务 failed 且保留错误', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '哈哈']);
  const created = createStyleTask('hanako', 'light');
  const fakeModel = async () => ({ ok: false, error: '模型炸了' });
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'failed');
  assert.ok(t.error.includes('模型炸了'));
});

test('runStyleTask：无发言记录 → failed 且提示友好', async () => {
  const root = useTempData();
  fs.mkdirSync(path.join(root, 'agents', 'hanako', 'sessions'), { recursive: true });
  const created = createStyleTask('hanako', 'light');
  const fakeModel = async () => ({ ok: true, data: 'x' });
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'failed');
  assert.ok(t.error.includes('没有找到'), '错误应提示没有发言记录');
});

test('recoverStyleTasks：重启后 running 任务标记失败，不卡新任务', () => {
  useTempData();
  const a = createStyleTask('hanako', 'balanced');
  assert.ok(a.ok);
  // 模拟重启：running 遗留
  const recovered = recoverStyleTasks();
  assert.equal(recovered, 1, '应恢复 1 个遗留任务');
  const t = getStyleTask(a.task.id);
  assert.equal(t.status, 'failed');
  assert.ok(t.error.includes('重启'));
  // 不卡新任务
  const b = createStyleTask('hanako', 'light');
  assert.ok(b.ok);
  // 再 recover 一次：b 也是 running，返回 1
  assert.equal(recoverStyleTasks(), 1);
});

// ── 学我说话模板同步到 ishiki.md（v0.31.0 回归：保存新模板后重启仍用旧模板）──
// 隔离 dialect-config 路径，避免污染真实配置
function useTempDialectConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-test-'));
  process.env.BIAOQINGBAO_DIALECT_CONFIG = path.join(dir, 'dialect-config.json');
  _resetDialectCache();
  tempDirs.push(dir);
  return dir;
}

// 造一个已有旧模板人格块的 ishiki.md
function makeIshikiWithOldBlock(agentsRoot, agentId, oldText) {
  const dir = path.join(agentsRoot, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ishiki.md'),
    '# 人格定义\n\n- 你是一个有温度的存在\n\n<!-- biaoqingbao-dialect:start -->\n' + oldText + '\n<!-- biaoqingbao-dialect:end -->\n',
    'utf-8');
}

test('syncUserstyleToIshiki：保存新模板后同步 userstyle 助手，其他方言不动', () => {
  const root = useTempData();
  useTempDialectConfig();
  // 配置：hanako 用 userstyle（带 boost），agentB 用台湾话
  writeDialectConfig({
    version: 3,
    agents: {
      hanako: { dialect: 'userstyle', enabled: true, boost: true },
      agentB: { dialect: 'taiwan', enabled: true },
    },
  });
  makeIshikiWithOldBlock(root, 'hanako', '旧模板内容：你是一个说话带着旧习惯的人……');
  makeIshikiWithOldBlock(root, 'agentB', '台湾话旧人格块……');

  // 模拟用户保存新模板
  const res = confirmStyleDraft('你是一个说话带着新习惯的人，打字节奏轻快……', { sourceAgent: 'hanako', level: 'balanced' });
  assert.ok(res.ok);
  const sync = syncUserstyleToIshiki(root);

  assert.deepEqual(sync.synced, ['hanako'], '应同步 userstyle 助手');
  assert.deepEqual(sync.removed, [], '模板非空不应移除');
  assert.deepEqual(sync.failed, []);
  // hanako 的 ishiki.md 应为新模板
  const hanakoBlock = readDialectFromIshiki('hanako', root);
  assert.equal(hanakoBlock, '你是一个说话带着新习惯的人，打字节奏轻快……', '新模板应写入 ishiki.md');
  // agentB 的人格块不受影响（方言配置没动）
  const agentBBlock = readDialectFromIshiki('agentB', root);
  assert.equal(agentBBlock, '台湾话旧人格块……', '其他方言助手不应被改动');
});

test('syncUserstyleToIshiki：回退到历史版本后同样同步', () => {
  const root = useTempData();
  useTempDialectConfig();
  writeDialectConfig({
    version: 3,
    agents: { hanako: { dialect: 'userstyle', enabled: true } },
  });
  makeIshikiWithOldBlock(root, 'hanako', '模板B内容……');

  // 先存模板A，再存模板B（历史里有 A），然后回退到 A
  confirmStyleDraft('模板A内容……', { sourceAgent: 'hanako' });
  confirmStyleDraft('模板B内容……', { sourceAgent: 'hanako' });
  const res = revertStyleTemplate(1);
  assert.ok(res.ok);
  assert.equal(res.data.current, '模板A内容……');
  const sync = syncUserstyleToIshiki(root);
  assert.deepEqual(sync.synced, ['hanako']);
  assert.equal(readDialectFromIshiki('hanako', root), '模板A内容……', '回退后的模板应写入 ishiki.md');
});

test('syncUserstyleToIshiki：清空模板后移除 userstyle 人格块', () => {
  const root = useTempData();
  useTempDialectConfig();
  writeDialectConfig({
    version: 3,
    agents: { hanako: { dialect: 'userstyle', enabled: true } },
  });
  makeIshikiWithOldBlock(root, 'hanako', '旧模板内容……');

  const res = clearStyleTemplate();
  assert.ok(res.ok);
  const sync = syncUserstyleToIshiki(root);
  assert.deepEqual(sync.removed, ['hanako'], '模板为空时应移除人格块');
  assert.equal(readDialectFromIshiki('hanako', root), '', 'ishiki.md 不应再有方言块');
});

test('runStyleTask：完全重新生成不携带旧模板，语料全量扫描累计', async () => {
  const root = useTempData();
  makeSessionFile(root, 'hanako', ['今天天气真好呀', '这个方案我觉得不错', '哈哈哈哈哈']);
  makeSessionFile(root, 'agentB', ['这个也好玩呀', '明天一起去不', '嗯嗯好呀']);
  // 先确认一个模板（历史里留着，但重新生成不应携带它）
  confirmStyleDraft('你是一个爱笑的人……', { sourceAgent: 'hanako' });
  // 重新总结：语料 = 全部助手（排除名单外），且不带旧模板
  const created = createStyleTask('all', 'light');
  let promptContent = '';
  const fakeModel = async (messages) => {
    promptContent = messages[0].content;
    return { ok: true, data: '你是一个说话带着自己节奏的人，打字也带着这种习惯。' };
  };
  await runStyleTask(created.task, fakeModel, '', root);
  const t = getStyleTask(created.task.id);
  assert.equal(t.status, 'completed');
  assert.equal(t.sampled_count, 4, '语料应包含两个助手的全部 user 发言（累计：每助手 2 条）');
  assert.ok(!promptContent.includes('爱笑的人'), '重新生成不应携带旧模板内容');
  assert.ok(promptContent.includes('[1]'), '应有语料编号');
});
