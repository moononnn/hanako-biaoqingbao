// tests/style-distill.test.js - 学我说话 v2：统计基线 + 验收断言
// 覆盖：computeBaseline 各项统计精确值、句尾语气词/光溜溜结束、连续汉字短段短语、
//       verifyClaim 通过/不通过/未知指标、describeBaselineForPrompt 提示槽文案
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHORT_MSG_CHARS,
  computeBaseline,
  verifyClaim,
  describeBaselineForPrompt,
  hasEmojiOrKaomoji,
  endsWithToneWord,
  splitSentences,
  extractCatchphrases,
  CHANNELS, CHANNEL_KEYS, ratioPhrase,
  buildChannelPrompt, parseChannelJSON, verifyFeatures, clipFeatures, distilChannel,
} from '../lib/style-distill.js';

const msg = (text, ts = '2026-08-01') => ({ text, ts });

test('computeBaseline：标点占比精确统计', () => {
  const msgs = [
    msg('今天天气真好呀~'),
    msg('走嘛走嘛~'),
    msg('哈哈哈笑死我了'),
    msg('这个咋整嘛？'),
    msg('巴适得很！'),
    msg('哦豁……完蛋'),
    msg('普通一句话'),
    msg('又没标点'),
    msg('嗯嗯'),
    msg('喔喔'),
  ];
  const b = computeBaseline(msgs);
  assert.equal(b.sampled, 10);
  // 波浪号：2/10
  assert.equal(b.punct.wave, 0.2);
  // 省略号：1/10
  assert.equal(b.punct.ellipsis, 0.1);
  // 感叹号：1/10
  assert.equal(b.punct.exclaim, 0.1);
  // 问句：1/10
  assert.equal(b.punct.question, 0.1);
  // 光溜溜结束（无标点无语气词）：哈哈哈笑死我了/哦豁……完蛋/普通一句话/又没标点/嗯嗯/喔喔 = 6/10
  assert.equal(b.punct.end_clean, 0.6);
  // 语气词收尾：本组样本末尾都是标点或普通字，无语气词收尾
  assert.equal(b.end_tone_top.length, 0);
});

test('computeBaseline：句尾语气词 / 光溜溜结束 判别', () => {
  const msgs = [
    msg('你吃了没嘛'),      // 嘛 收尾
    msg('好的哈'),          // 哈 收尾
    msg('走咯走咯'),        // 咯 收尾
    msg('嗯嗯'),            // 光溜溜
    msg('明白'),            // 光溜溜
    msg('嗯嗯！'),          // 感叹号收尾，不算光溜溜也不算语气词
    msg('那当然吗'),        // 吗 收尾
  ];
  const b = computeBaseline(msgs);
  assert.equal(b.sampled, 7);
  assert.equal(b.punct.end_tone, Math.round((4 / 7) * 1000) / 1000, '嘛/哈/咯/吗 4 条以语气词收尾');
  assert.equal(b.punct.end_clean, Math.round((2 / 7) * 1000) / 1000, '嗯嗯/明白 2 条光溜溜');
  const top = b.end_tone_top.map((e) => e.word);
  assert.ok(top.includes('嘛'));
  assert.ok(top.includes('哈'));
  assert.equal(b.tone_words['吗'], Math.round((1 / 7) * 1000) / 1000);
  // 每词独立统计：嘛 1 条
  assert.equal(b.tone_words['嘛'], Math.round((1 / 7) * 1000) / 1000);
});

test('computeBaseline：句长 / 中位数 / 短消息占比', () => {
  const msgs = [
    msg('短'),                       // 1 字
    msg('这也是短的'),               // 5 字
    msg('这是一条中等长度的普通人话消息'),  // 15 字
    msg('这是很长的一句话，用来拉高平均句长，验证切句统计是不是对的。'), // 27 字，句号切
  ];
  const b = computeBaseline(msgs);
  assert.equal(b.sampled, 4);
  // 短消息（<20 字）：3/4
  assert.equal(b.short_ratio, 0.75);
  // 中位数：排序 [1,5,15,27] → (5+15)/2 = 10
  assert.equal(b.msg_len_median, 10);
  // 句子总字符 = 1 + 5 + 15 + 29(含两逗号去句号) = 50，共 4 句 → 12.5
  assert.equal(b.avg_sentence_len, 12.5);
  // 逗号不切分（SENTENCE_SPLIT_RE 只含句末标点）
  assert.equal(splitSentences('这是很长的一句话，用来拉高平均句长，验证切句统计是不是对的。').length, 1);
});

test('computeBaseline：连续汉字短段短语 TOP、emoji 占比', () => {
  const msgs = [
    msg('巴适'),
    msg('巴适得很嘛'),
    msg('巴适'),
    msg('太开心了！233333'),
    msg('今天也超开心'),
    msg('巴适'),
  ];
  const b = computeBaseline(msgs);
  assert.ok(b.catchphrases.length >= 1, '应有短语候选');
  assert.equal(b.catchphrases[0].phrase, '巴适', '最高频 2-gram 应为「巴适」');
  assert.equal(b.catchphrases[0].count, 3, '同一条消息重复出现只计一次');
  // emoji：233333 算颜文字 → 1/6
  assert.equal(b.emoji_ratio, Math.round((1 / 6) * 1000) / 1000);
});

test('extractCatchphrases：排除拼音英文碎片、不跨边界、按消息去重', () => {
  const result = extractCatchphrases([
    msg('re re re 巴适'),
    msg('er in 好！朋友'),
    msg('巴适'),
    msg('巴适'),
    msg('好朋友'),
    msg('朋友'),
  ], { minCount: 1, topN: 20 });
  assert.equal(result.find((x) => x.phrase === '巴适')?.count, 3);
  assert.equal(result.find((x) => x.phrase === 're'), undefined);
  assert.equal(result.find((x) => x.phrase === 'er'), undefined);
  assert.equal(result.find((x) => x.phrase === '好朋'), undefined, '不再把长短语切碎成二元片段');
  assert.equal(result.find((x) => x.phrase === '朋友')?.count, 2);
  assert.equal(result.some((x) => /[A-Za-z0-9]/.test(x.phrase)), false);
  const useful = extractCatchphrases([
    msg('这个'),
    msg('这个'),
    msg('巴适'),
    msg('巴适'),
  ], { minCount: 2, topN: 20 });
  assert.equal(useful.find((x) => x.phrase === '这个'), undefined, '常见结构词不应冒充口头禅');
  assert.equal(useful.find((x) => x.phrase === '巴适')?.count, 2);
  const addressed = extractCatchphrases([
    msg('联系人，你看哈'),
    msg('联系人，帮我看下'),
  ], { minCount: 1, topN: 20 });
  assert.equal(addressed.find((x) => x.phrase === '联系人'), undefined, '消息开头的称呼不应冒充口头禅');
});

test('computeBaseline：空输入安全返回默认 0', () => {
  const b = computeBaseline([]);
  assert.equal(b.sampled, 0);
  assert.equal(b.avg_sentence_len, 0);
  assert.equal(b.msg_len_median, 0);
  assert.equal(b.short_ratio, 0);
  assert.deepEqual(b.punct, { wave: 0, ellipsis: 0, exclaim: 0, question: 0, end_clean: 0, end_tone: 0 });
  assert.deepEqual(b.catchphrases, []);
});

test('verifyClaim：通过 / 不通过 / 未知指标 / 缺 claim', () => {
  const b = computeBaseline([msg('a~'), msg('b~'), msg('c'), msg('d'), msg('e'), msg('f'), msg('g'), msg('h'), msg('i'), msg('j')]);
  // wave = 2/10 = 0.2
  assert.equal(verifyClaim(b, { metric: 'punct.wave', min: 0.1, max: 0.3 }).ok, true);
  assert.equal(verifyClaim(b, { metric: 'punct.wave', min: 0.5 }).ok, false);
  assert.equal(verifyClaim(b, { metric: 'punct.wave', min: 0.5 }).actual, 0.2);
  // 提示显示为整数百分比时，0.249 回填为 0.25 仍应通过舍入误差
  assert.equal(verifyClaim({ punct: { wave: 0.249 } }, { metric: 'punct.wave', min: 0.25, max: 0.25 }).ok, true);
  assert.equal(verifyClaim({ avg_sentence_len: 12.4 }, { metric: 'avg_sentence_len', min: 12.5, max: 12.5 }).ok, false);
  // 未知指标
  assert.equal(verifyClaim(b, { metric: 'nope.xx' }).ok, false);
  assert.equal(verifyClaim(b, { metric: 'nope.xx' }).reason.includes('unknown'), true);
  // 缺 claim / 缺 metric
  assert.equal(verifyClaim(b, null).ok, false);
  assert.equal(verifyClaim(b, {}).ok, false);
});

test('verifyClaim：语气词指标（tone_words.X）', () => {
  const msgs = [msg('吃了嘛'), msg('不嘛'), msg('行好'), msg('好呀'), msg('哦')];
  const b = computeBaseline(msgs);
  // 嘛 2/5 = 0.4
  assert.equal(verifyClaim(b, { metric: 'tone_words.嘛', min: 0.2, max: 0.6 }).ok, true);
  assert.equal(verifyClaim(b, { metric: 'tone_words.嘛', min: 0.8 }).ok, false);
});

test('describeBaselineForPrompt：各通道输出统计说明且不含误导数字', () => {
  const msgs = [msg('今天天气真好呀~'), msg('走嘛走嘛~'), msg('巴适得很哦'), msg('巴适得很嘛'), msg('巴适')];
  const b = computeBaseline(msgs);
  const punctText = describeBaselineForPrompt(b, 'punct');
  assert.ok(punctText.includes('波浪号'), '标点通道应含波浪号说明');
  assert.ok(punctText.includes('40%'), '2/5 波浪号应显示 40%');
  const lexicon = describeBaselineForPrompt(computeBaseline([msg('巴适'), msg('巴适'), msg('巴适')]), 'lexicon');
  assert.ok(lexicon.includes('高频短语候选'), '词汇通道应含短语候选（样本含 3 条「巴适」）');
  const syntax = describeBaselineForPrompt(b, 'syntax');
  assert.ok(syntax.includes('平均句长'), '句法通道应含句长');
  // 情绪/正事通道也要有统计锚点；正事明确声明只是整体基线
  assert.ok(describeBaselineForPrompt(b, 'emotion').includes('emoji/颜文字'));
  assert.ok(describeBaselineForPrompt(b, 'formal').includes('整体平均句长'));
  assert.ok(describeBaselineForPrompt(b, 'formal').includes('整体语言基线'));
});

test('hasEmojiOrKaomoji / endsWithToneWord / 边界', () => {
  assert.equal(hasEmojiOrKaomoji('哈哈😄'), true);
  assert.equal(hasEmojiOrKaomoji('233333'), true);
  assert.equal(hasEmojiOrKaomoji('普通文本'), false);
  assert.equal(hasEmojiOrKaomoji(''), false);
  assert.equal(endsWithToneWord('吃了嘛'), '嘛');
  assert.equal(endsWithToneWord('嗯嗯'), null);
  assert.equal(endsWithToneWord('巴适得很！'), null, '感叹号收尾不算语气词');
  // SHORT_MSG_CHARS 常量导出
  assert.equal(SHORT_MSG_CHARS, 20);
});

// ── 阶段②③：分通道提炼 + 验收断言 ──

test('CHANNELS 定义完整：五路都有 label/desc/maxFeatures', () => {
  assert.deepEqual(CHANNEL_KEYS, ['lexicon', 'syntax', 'punct', 'emotion', 'formal']);
  for (const k of CHANNEL_KEYS) {
    assert.ok(CHANNELS[k].label, k + ' 应有 label');
    assert.ok(CHANNELS[k].desc, k + ' 应有 desc');
    assert.ok(CHANNELS[k].maxFeatures > 0, k + ' 应有特征上限');
  }
});

test('ratioPhrase：档位映射<10% 偶尔 / 10-40% 有时候 / >40% 常', () => {
  assert.equal(ratioPhrase(0.05), '偶尔');
  assert.equal(ratioPhrase(0.09), '偶尔');
  assert.equal(ratioPhrase(0.1), '有时候');
  assert.equal(ratioPhrase(0.4), '有时候');
  assert.equal(ratioPhrase(0.41), '常');
  assert.equal(ratioPhrase(0.9), '常');
  assert.equal(ratioPhrase(undefined), '偶尔');
});

test('buildChannelPrompt：含语料、提示槽统计、身份化/白名单/指令词约束', () => {
  const corpus = '[1] 今天天气真好呀~\n[2] 走嘛走嘛~';
  const baseline = computeBaseline([msg('a~'), msg('b~'), msg('c')]);
  const statText = describeBaselineForPrompt(baseline, 'punct');
  const prompt = buildChannelPrompt('punct', corpus, statText, '测试用户');
  assert.ok(prompt.includes('发言样本'));
  assert.ok(prompt.includes('[1] 今天天气真好呀~'), '应包含语料');
  assert.ok(prompt.includes('程序统计'), '应含提示槽');
  assert.ok(prompt.includes('67%'), '统计数字应入提示槽（2/3 波浪号）');
  assert.ok(prompt.includes('身份化'), '应要求身份化描述');
  assert.ok(prompt.includes('注意/不要/请/必须'), '应禁指令词');
  assert.ok(prompt.includes('punct.wave'), '应变白名单指标');
  // 反馈注入
  const fb = buildChannelPrompt('punct', corpus, statText, 'u', ['「X」自报 punct.wave 不在区间']);
  assert.ok(fb.includes('上次输出被程序否决'), '应注入验收反馈');
  // 未知通道抛错
  assert.throws(() => buildChannelPrompt('nope', '', '', 'u'), /未知通道/);
});

test('parseChannelJSON：合法 JSON / 代码块 / 外围杂字 / 非法', () => {
  const good = { features: [{ feature: '句尾偶尔带波浪号', claim: { metric: 'punct.wave', min: 0.1, max: 0.3 } }] };
  const raw = JSON.stringify(good);
  assert.equal(parseChannelJSON(raw).ok, true);
  // 代码块包裹
  const blocked = '```json\n' + raw + '\n```';
  assert.equal(parseChannelJSON(blocked).ok, true);
  // 前后杂字
  const noisy = '好的，这是我提炼的结果：' + raw + '——请查收';
  assert.equal(parseChannelJSON(noisy).ok, true);
  // 缺少 features
  assert.equal(parseChannelJSON(JSON.stringify({ foo: 1 })).ok, false);
  // 完全非法
  assert.equal(parseChannelJSON('不是 JSON').ok, false);
  assert.equal(parseChannelJSON('').ok, false);
});

test('verifyFeatures：通过/缺 claim/指标不存在/空条目 分类', () => {
  const baseline = computeBaseline([msg('a~'), msg('b~'), msg('c'), msg('d'), msg('e'), msg('f'), msg('g'), msg('h'), msg('i'), msg('j')]);
  // wave = 0.2
  const v1 = verifyFeatures(baseline, [
    { feature: '句尾偶尔带波浪号', claim: { metric: 'punct.wave', min: 0.1, max: 0.3 } },
  ]);
  assert.equal(v1.ok, true);
  assert.equal(v1.features.length, 1);
  // 混合：一条过、一条指标不存在、一条缺 claim、一条空条目
  const v2 = verifyFeatures(baseline, [
    { feature: '好的', claim: { metric: 'punct.wave', min: 0.1, max: 0.3 } },
    { feature: '坏的', claim: { metric: 'nope.xx', min: 0 } },
    { feature: '缺凭据' },
    { feature: '' },
  ]);
  assert.equal(v2.ok, false);
  assert.equal(v2.features.length, 1, '只有通过的那条保留');
  assert.equal(v2.problems.length, 3, '三个问题条目');
  assert.ok(v2.problems.some((p) => p.includes('nope.xx')));
  assert.ok(v2.problems.some((p) => p.includes('缺少 claim')));
});

test('clipFeatures：去重 + 限条数', () => {
  const fs = [
    { feature: 'a', claim: { metric: 'punct.wave' } },
    { feature: 'a', claim: { metric: 'punct.wave' } }, // 重复
    { feature: 'b' },
    { feature: 'c' },
  ];
  const out = clipFeatures(fs, 2);
  assert.equal(out.length, 2, '应按上限截断');
  assert.deepEqual(out.map((f) => f.feature), ['a', 'b']);
  // claim 洗成只留 metric/min/max
  assert.deepEqual(out[0].claim, { metric: 'punct.wave', min: undefined, max: undefined });
});

test('distilChannel：一次验收通过 → ok', async () => {
  const baseline = computeBaseline([msg('a~'), msg('b~'), msg('c')]); // wave 2/3
  const features = [{ feature: '句尾常带波浪号', claim: { metric: 'punct.wave', min: 0.5, max: 0.9 } }];
  let calls = 0;
  const fakeModel = async (messages) => {
    calls++;
    assert.ok(messages[0].content.includes('程序统计'), '应为带提示槽的通道 prompt');
    return { ok: true, data: JSON.stringify({ features }) };
  };
  const r = await distilChannel('punct', '[1] a~\n[2] b~\n[3] c', baseline, 'u', fakeModel);
  assert.equal(r.status, 'ok');
  assert.equal(r.tries, 1);
  assert.equal(r.features.length, 1);
  assert.equal(calls, 1);
});

test('distilChannel：验收不通过 → 带反馈重试 → 修正后 ok', async () => {
  const baseline = computeBaseline([msg('a~'), msg('b'), msg('c'), msg('d'), msg('e')]); // wave 1/5=0.2
  let calls = 0;
  const fakeModel = async (messages) => {
    calls++;
    if (calls === 1) {
      // 第一次：说 90%，实际 20% → 不通过
      return { ok: true, data: JSON.stringify({ features: [{ feature: '句尾总是带波浪号', claim: { metric: 'punct.wave', min: 0.8, max: 1 } }] }) };
    }
    // 第二次：修正为 20%
    return { ok: true, data: JSON.stringify({ features: [{ feature: '句尾有时候带波浪号', claim: { metric: 'punct.wave', min: 0.1, max: 0.3 } }] }) };
  };
  const r = await distilChannel('punct', 'c', baseline, 'u', fakeModel);
  assert.equal(r.status, 'ok');
  assert.equal(r.tries, 2, '应重试一次');
  assert.equal(r.features[0].feature, '句尾有时候带波浪号');
  assert.equal(calls, 2);
});

test('distilChannel：重试耗尽仍不通过 → weak 保留已通过特征', async () => {
  const baseline = computeBaseline([msg('a~'), msg('b'), msg('c'), msg('d'), msg('e')]); // wave 0.2
  const fakeModel = async () => ({
    ok: true,
    data: JSON.stringify({ features: [
      { feature: '好的那一条', claim: { metric: 'punct.wave', min: 0.1, max: 0.3 } },      // 通过
      { feature: '总是不好那条', claim: { metric: 'punct.wave', min: 0.9, max: 1 } },      // 永远不通过
    ] }),
  });
  const r = await distilChannel('punct', 'c', baseline, 'u', fakeModel, { retryDelayMs: 0 });
  assert.equal(r.status, 'weak');
  assert.equal(r.tries, 3, '默认最多重试 2 次，共 3 次调用');
  assert.equal(r.features.length, 1, '应保留通过的那条');
  assert.equal(r.features[0].feature, '好的那一条');
  assert.ok(r.problems.length > 0, '应记录问题清单');
});

test('distilChannel：模型全失败 → failed', async () => {
  const baseline = computeBaseline([msg('a~')]);
  const fakeModel = async () => ({ ok: false, error: '炸了' });
  const r = await distilChannel('punct', 'c', baseline, 'u', fakeModel, { retryDelayMs: 0 });
  assert.equal(r.status, 'failed');
  assert.equal(r.features.length, 0);
  assert.ok(r.problems.some((p) => p.includes('炸了')));
});

// ── 阶段④⑤：合并润色 + 反例/锁定回流 ──
import {
  readMetric, checkStyleDraft, splitTemplateSentences, diffTemplateFeedback,
  formatFeedbackBlock, buildMergePrompt, mergeTemplate,
} from '../lib/style-distill.js';

test('readMetric：点分路径读取 / 不存在返回 undefined', () => {
  const b = computeBaseline([msg('a~'), msg('b~'), msg('c')]);
  assert.equal(readMetric(b, 'punct.wave'), 0.667, '均为千分位舍入');
  assert.equal(readMetric(b, 'tone_words.嘛'), undefined, '未出现的语气词不在基线（模型声称会被验收拒掉）');
  assert.equal(readMetric(b, 'nope.x'), undefined);
  assert.equal(readMetric(b, undefined), undefined);
});

test('checkStyleDraft：格式/指令词/绝对化/locked 检查', () => {
  assert.deepEqual(checkStyleDraft(''), ['内容为空']);
  assert.ok(checkStyleDraft('你是一个说话带节奏的人。正事闲聊都一个样。').length === 0, '合规文案应通过');
  assert.ok(checkStyleDraft('你是一个说话带节奏的人。请注意保持简洁。' + '正事闲聊都一个样。').some((p) => p.includes('指令词')));
  assert.ok(checkStyleDraft('**加粗**你是一个……').some((p) => p.includes('markdown')));
  // 超长
  assert.ok(checkStyleDraft('你是一个' + '字'.repeat(650)).some((p) => p.includes('超过 600 字')));
  // 绝对化过多
  const absol = checkStyleDraft('你是一个总是爱笑的人，每句话都带波浪号，每次都撒娇，全都这样……正事闲聊都一个样。');
  assert.ok(absol.some((p) => p.includes('绝对化表述过多')), '绝对化词超标应拦截');
  // 未经程序统计的换算比例不能进入最终文案
  assert.ok(checkStyleDraft('你是一个说话自然的人，十句里有八句带语气词。').some((p) => p.includes('未经程序统计')));
  assert.ok(checkStyleDraft('你是一个说话自然的人，偶尔说“好呀。').some((p) => p.includes('引号未成对')));
  assert.ok(checkStyleDraft('你是一个文字编辑，打字很自然。').some((p) => p.includes('编辑角色')));
  // locked 缺失
  const lockedIssue = checkStyleDraft('你是一个说话带节奏的人。', { locked: ['你打字就是这样：吃饭翘腿'] });
  assert.ok(lockedIssue.some((p) => p.includes('缺少用户锁定内容')), '锁定内容丢失应拦截');
});

test('splitTemplateSentences / diffTemplateFeedback：删增分类', () => {
  assert.equal(splitTemplateSentences('你是一个爱笑的人。今天也要开心呀！你说啥呢').length, 3);
  const oldText = '你是一个爱笑的人。今天也要开心呀！你打字利落。';
  const newText = '你是一个爱笑的人。你打字利落。你偶尔加个小波浪~';
  const d = diffTemplateFeedback(oldText, newText);
  assert.deepEqual(d.removed, ['今天也要开心呀！']);
  assert.deepEqual(d.added, ['你偶尔加个小波浪~']);
  // 原样不动时无变化
  const same = diffTemplateFeedback('你是一个爱笑的人。', '你是一个爱笑的人。');
  assert.equal(same.removed.length, 0);
  assert.equal(same.added.length, 0);
});

test('formatFeedbackBlock：反例 + 锁定 约束块', () => {
  const blk = formatFeedbackBlock({
    counterexamples: [{ feature: '句尾永远不加标点' }],
    locked: [{ content: '你打字就是这样：吃饭翘腿' }],
  });
  assert.ok(blk.includes('禁止写的特征'), '应有反例块');
  assert.ok(blk.includes('句尾永远不加标点'));
  assert.ok(blk.includes('必须保留的内容'), '应有锁定块');
  assert.ok(blk.includes('吃饭翘腿'));
  // 空输入
  assert.equal(formatFeedbackBlock({}), '');
  assert.equal(formatFeedbackBlock(null), '');
});

test('buildMergePrompt：带实测占比 + 反例/锁定约束 + 零指令词要求', () => {
  const baseline = computeBaseline([msg('a~'), msg('b~'), msg('c'), msg('d'), msg('e')]); // wave 0.4
  const channels = {
    punct: { status: 'ok', features: [{ feature: '句尾有时候带波浪号', claim: { metric: 'punct.wave', min: 0.2, max: 0.6 } }] },
    lexicon: { status: 'ok', features: [] },
    syntax: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] },
    formal: { status: 'ok', features: [] },
  };
  const fb = { counterexamples: [{ feature: '句尾永远不加标点' }], locked: [{ content: '你打字就是这样：吃饭翘腿' }] };
  const prompt = buildMergePrompt(channels, baseline, fb, '测试用户');
  assert.ok(prompt.includes('特征清单'), '应有特征清单');
  assert.ok(prompt.includes('40%'), '应带实测占比');
  assert.ok(prompt.includes('禁止写的特征'));
  assert.ok(prompt.includes('必须保留的内容'));
  assert.ok(prompt.includes('测试用户'));
  assert.ok(prompt.includes('正事闲聊都一个样'));
  assert.ok(prompt.includes('450-550 字'));
  // 无特征通道 → 空 prompt
  const empty = buildMergePrompt({
    lexicon: { status: 'ok', features: [] }, syntax: { status: 'ok', features: [] }, punct: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] }, formal: { status: 'ok', features: [] },
  }, baseline, {}, 'u');
  assert.equal(empty, '');
});

test('mergeTemplate：合规一次通过', async () => {
  const baseline = computeBaseline([msg('a~'), msg('b'), msg('c')]);
  const channels = {
    punct: { status: 'ok', features: [{ feature: '句尾偶尔带波浪号', claim: { metric: 'punct.wave', min: 0.2, max: 0.5 } }] },
    lexicon: { status: 'ok', features: [] }, syntax: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] }, formal: { status: 'ok', features: [] },
  };
  let calls = 0;
  const fakeModel = async () => {
    calls++;
    return { ok: true, data: '你是一个说话带着自己节奏的人，打字也带着这种习惯。正事闲聊都一个样，不刻意表现，也不刻意收敛。这只是你的措辞，正事照样讲得明白。' };
  };
  const r = await mergeTemplate(channels, baseline, {}, 'u', fakeModel);
  assert.equal(r.ok, true);
  assert.equal(r.tries, 1);
  assert.equal(calls, 1);
});

test('mergeTemplate：含 locked 时终检拦截缺失', async () => {
  const baseline = computeBaseline([msg('a')]);
  const channels = {
    lexicon: { status: 'ok', features: [{ feature: '你打字带着俏皮', claim: { metric: 'emoji_ratio', min: 0, max: 1 } }] },
    syntax: { status: 'ok', features: [] }, punct: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] }, formal: { status: 'ok', features: [] },
  };
  const fb = { locked: [{ content: '你打字就是这样：吃饭翘腿' }] };
  let calls = 0;
  const fakeModel = async () => {
    calls++;
    if (calls === 1) return { ok: true, data: '你是一个爱笑的人。正事闲聊都一个样……' }; // 缺锁定内容
    return { ok: true, data: '你是一个爱笑的人。你打字就是这样：吃饭翘腿。正事闲聊都一个样……' }; // 补齐
  };
  const r = await mergeTemplate(channels, baseline, fb, 'u', fakeModel, { retryDelayMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.tries, 2, '第一次缺锁定内容应重试');
  assert.ok(r.draft.includes('吃饭翘腿'));
  assert.equal(calls, 2);
});

test('mergeTemplate：终检失败重试会带反馈，不会重复发送同一提示', async () => {
  const baseline = computeBaseline([msg('a')]);
  const channels = {
    lexicon: { status: 'ok', features: [{ feature: '你打字带着俏皮', claim: { metric: 'emoji_ratio', min: 0, max: 1 } }] },
    syntax: { status: 'ok', features: [] }, punct: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] }, formal: { status: 'ok', features: [] },
  };
  let calls = 0;
  const fakeModel = async (messages) => {
    calls++;
    if (calls === 1) return { ok: true, data: '你是一个说话带节奏的人。请注意保持轻快。正事闲聊都一个样。' };
    assert.ok(messages[0].content.includes('上一版草稿未通过程序检查'));
    assert.ok(messages[0].content.includes('带命令口吻'));
    assert.ok(messages[0].content.includes('请注意保持轻快'));
    return { ok: true, data: '你是一个说话带节奏的人。打字自然保持轻快。正事闲聊都一个样。' };
  };
  const r = await mergeTemplate(channels, baseline, {}, 'u', fakeModel, { retryDelayMs: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.tries, 2);
  assert.equal(calls, 2);
});

test('mergeTemplate：模型全失败 → 报错且不产出空草稿', async () => {
  const baseline = computeBaseline([msg('a')]);
  const channels = {
    lexicon: { status: 'ok', features: [{ feature: 'x', claim: { metric: 'emoji_ratio', min: 0, max: 1 } }] },
    syntax: { status: 'ok', features: [] }, punct: { status: 'ok', features: [] },
    emotion: { status: 'ok', features: [] }, formal: { status: 'ok', features: [] },
  };
  const fakeModel = async () => ({ ok: false, error: '炸了' });
  const r = await mergeTemplate(channels, baseline, {}, 'u', fakeModel, { retryDelayMs: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('炸了'));
});
