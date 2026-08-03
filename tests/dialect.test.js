import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DIALECTS, DIALECT_LIST,
  getDialect, buildDialectPrompt, buildDialectPersona,
  readDialectConfig, writeDialectConfig, getAgentDialectSetting,
  applyDialectToIshiki, removeDialectFromIshiki, readDialectFromIshiki,
  syncDialectToIshiki, reconcileDialectToIshiki,
  appendDialectLog, readDialectLog,
  _resetDialectCache,
} from '../lib/dialect.js';

// ── 测试隔离：每次把配置路径指向临时文件，绝不碰正式配置 ──
// （回归：测试曾直接写正式 data/dialect-config.json，把用户的配置覆盖丢了）
const tempConfigFiles = [];
function useTempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-test-'));
  const file = path.join(dir, 'dialect-config.json');
  process.env.BIAOQINGBAO_DIALECT_CONFIG = file;
  tempConfigFiles.push(dir);
  _resetDialectCache();
  return file;
}

test.after(() => {
  for (const dir of tempConfigFiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('方言库完整性：9 种方言齐全，字段非空，难度标注仅新疆话保留', () => {
  assert.equal(DIALECT_LIST.length, 9);
  const ids = new Set(DIALECT_LIST.map(d => d.id));
  for (const d of DIALECT_LIST) {
    assert.ok(d.name, `${d.id} 缺 name`);
    assert.ok(d.people, `${d.id} 缺 people`);
    assert.ok(d.tagline, `${d.id} 缺 tagline`);
    assert.ok(['easy', 'medium', 'hard'].includes(d.difficulty), `${d.id} 难度标注无效`);
    // v0.23.0：难度标注只保留新疆话一处（提醒其他用户预期）
    if (d.id === 'xinjiang') {
      assert.equal(d.difficultyNote, '效果一般', '新疆话应保留「效果一般」提醒');
    } else {
      assert.ok(!d.difficultyNote, `${d.id} 不应再标注效果`);
    }
    assert.ok(Array.isArray(d.markers) && d.markers.length >= 4, `${d.id} 标志词不足`);
    assert.ok(Array.isArray(d.particles) && d.particles.length >= 2, `${d.id} 语气词不足`);
    assert.ok(Array.isArray(d.examples) && d.examples.length >= 3, `${d.id} 例句不足`);
    // 弱方言加料：medium ≥ 5 句、hard ≥ 6 句，给模型更多示范
    if (d.difficulty === 'medium') assert.ok(d.examples.length >= 5, `${d.id} medium 例句应 ≥5`);
    if (d.difficulty === 'hard') assert.ok(d.examples.length >= 6, `${d.id} hard 例句应 ≥6`);
  }
  for (const id of ids) {
    assert.ok(getDialect(id), `getDialect(${id}) 应命中`);
  }
});

test('习惯式文案：身份化、锚定起头、质量声明、零指令词、强调打字场景、正事不压制', () => {
  // easy/medium：整句方言模式
  for (const id of ['dongbei', 'taiwan', 'beijing', 'henan']) {
    const text = buildDialectPersona(id, 'on');
    assert.ok(text, `${id} 文案不应为空`);
    assert.ok(text.includes('土生土长的'), `${id} 文案应为身份化断言`);
    assert.ok(text.includes('说话本能'), `${id} 文案应强调「说话本能」`);
    assert.ok(text.includes('打字'), `${id} 文案应强调「打字」场景`);
    assert.ok(text.includes('打字也带着'), `${id} 整句模式应说「打字也带着X味」`);
    // v0.23.0：锚定机制（接话时用方言词起头，钉住每轮第一句）
    assert.ok(text.includes('接话时爱用'), `${id} 文案应有起头锚定`);
    assert.ok(text.includes('起头'), `${id} 文案应说「起头」`);
    assert.ok(text.includes('句尾偶尔落个'), `${id} 文案应有句尾频率控制`);
    // v0.23.0：质量优先级声明（方言只是措辞，正事不降智的保险丝）
    assert.ok(text.includes('方言只是你的措辞'), `${id} 文案应有质量声明`);
    assert.ok(text.includes('不影响内容的质量与严谨'), `${id} 文案质量声明应明确`);
    // 正事不是压制而是自然带出
    assert.ok(text.includes('正事闲聊都一个样'), `${id} 文案应说正事闲聊都自然带`);
    // 零指令词
    for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
      assert.ok(!text.includes(bad), `${id} 文案不应含指令词「${bad}」`);
    }
  }
  // hard 档：彩蛋模式（偶尔蹦家乡词，不要求整句方言）
  for (const id of ['xinjiang']) {
    const text = buildDialectPersona(id, 'on');
    assert.ok(text.includes('土生土长的'), `${id} 彩蛋文案应为身份化断言`);
    assert.ok(text.includes('偶尔'), `${id} 彩蛋文案应说「偶尔蹦」`);
    assert.ok(text.includes('家乡词'), `${id} 彩蛋文案应提「家乡词」`);
    assert.ok(text.includes('大部分时候说普通话'), `${id} 彩蛋文案应允许普通话为主`);
    assert.ok(!text.includes('打字也带着'), `${id} 彩蛋文案不应要求整句方言`);
    assert.ok(!text.includes('接话时爱用'), `${id} 彩蛋文案不应有整句锚定`);
    assert.ok(text.includes('方言只是你的措辞'), `${id} 彩蛋文案也应有质量声明`);
    for (const bad of ['注意', '不要', '请', '必须', '应该', '记住', '尽量']) {
      assert.ok(!text.includes(bad), `${id} 彩蛋文案不应含指令词「${bad}」`);
    }
  }
  // 按难度引用例句：easy 2 句、medium 3 句（hard 彩蛋模式用标志词，不引用例句）
  assert.equal(buildDialectPersona('dongbei', 'on').split('「').length - 1, 2, 'easy 方言应引用 2 句例句');
  assert.equal(buildDialectPersona('henan', 'on').split('「').length - 1, 3, 'medium 方言应引用 3 句例句');
  assert.equal(buildDialectPersona('xinjiang', 'on').split('「').length - 1, 0, 'hard 彩蛋文案不引用例句');
  // 北京话不出现「诶呦喂」式表演词，新疆话不出现馕言文式夸张比喻
  const bj = buildDialectPersona('beijing', 'on');
  assert.ok(!bj.includes('诶呦喂') && !bj.includes('真地道'), '北京话文案不应有表演腔');
  // 北京话 markers 含「不儿」（平级词，不强制出现）
  assert.ok(DIALECTS.beijing.markers.includes('不儿'), '北京话标志词应含「不儿」');
  // 替换词应避开起头词，不重复
  const dongbei = buildDialectPersona('dongbei', 'on');
  assert.equal(dongbei.split('拉倒吧').length - 1, 1, '起头词不应在替换词里重复出现');
  const xj = buildDialectPersona('xinjiang', 'on');
  assert.ok(!xj.includes('雄鹰') && !xj.includes('豹子'), '新疆话文案不应有馕言文夸张比喻');
  // 台湾腔写清楚中国台湾
  assert.ok(buildDialectPersona('taiwan', 'on').includes('中国台湾人'), '台湾腔文案应写明「中国台湾人」');
  // buildDialectPrompt 兼容别名
  assert.equal(buildDialectPrompt('dongbei', 'on'), buildDialectPersona('dongbei', 'on'));
});

test('人格文案：无效方言返回空，任何档位参数都返回文案（开关式）', () => {
  assert.equal(buildDialectPersona('xx', 'normal'), '');
  assert.equal(buildDialectPersona('dongbei', 'none'), buildDialectPersona('dongbei', 'on'), '开启状态与档位参数无关');
  assert.equal(buildDialectPersona('', 'normal'), '');
  assert.ok(buildDialectPersona('dongbei', 'light').length > 0, '老档位参数 light 也返回文案');
  assert.ok(buildDialectPersona('dongbei', 'heavy').length > 0, '老档位参数 heavy 也返回文案');
});

test('配置归一化：只保留有效配置，非法值丢弃', () => {
  useTempConfig();
  const config = writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      yumi: { dialect: '不存在的方言', enabled: true },
      xingxing: { dialect: 'henan', density: 'max' }, // 老格式非法浓度 → 丢弃
      '__proto__': { dialect: 'henan', enabled: true },
      ok2: null,
    },
  });
  assert.deepEqual(config.agents, { hanako: { dialect: 'dongbei', enabled: true } });
});

test('配置：关闭档不保存（enabled:false / density:none 迁移均不存），读回返回 null', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: {
      a: { dialect: 'henan', enabled: false },
      b: { dialect: 'henan', density: 'none' }, // 老格式关闭
    },
  });
  assert.equal(getAgentDialectSetting('a'), null);
  assert.equal(getAgentDialectSetting('b'), null);
  assert.equal(getAgentDialectSetting('不存在的助手'), null);
});

test('配置：老版三档浓度自动迁移为 enabled（light/normal/heavy → 开启）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 1,
    agents: {
      a: { dialect: 'dongbei', density: 'light' },
      b: { dialect: 'henan', density: 'normal' },
      c: { dialect: 'taiwan', density: 'heavy' },
    },
  });
  const read = readDialectConfig();
  assert.deepEqual(read.agents, {
    a: { dialect: 'dongbei', enabled: true },
    b: { dialect: 'henan', enabled: true },
    c: { dialect: 'taiwan', enabled: true },
  });
  assert.equal(read.version, 2);
});

test('配置：读写往返一致（新格式）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'taiwan', enabled: true },
      yumi: { dialect: 'sichuan', enabled: true },
    },
  });
  const read = readDialectConfig();
  assert.deepEqual(read.agents, {
    hanako: { dialect: 'taiwan', enabled: true },
    yumi: { dialect: 'sichuan', enabled: true },
  });
  assert.deepEqual(getAgentDialectSetting('hanako'), { dialect: 'taiwan', enabled: true });
});

test('配置：清缓存后从磁盘真实读取（回归：fs 未导入被缓存掩盖）', () => {
  useTempConfig();
  writeDialectConfig({
    version: 2,
    agents: { hanako: { dialect: 'dongbei', enabled: true } },
  });
  _resetDialectCache();
  const read = readDialectConfig();
  assert.deepEqual(read.agents, { hanako: { dialect: 'dongbei', enabled: true } });
  assert.deepEqual(getAgentDialectSetting('hanako'), { dialect: 'dongbei', enabled: true });
});

// ── 人格文件写入（用户主动开启才写，关闭即删）──

function makeTempAgentsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-agents-'));
}

test('applyDialectToIshiki：新建文件写入人格块', () => {
  const root = makeTempAgentsRoot();
  const res = applyDialectToIshiki('hanako', 'dongbei', 'normal', root);
  assert.equal(res.ok, true);
  const content = fs.readFileSync(path.join(root, 'agents', 'hanako', 'ishiki.md'), 'utf-8');
  assert.ok(content.includes('<!-- biaoqingbao-dialect:start -->'));
  assert.ok(content.includes('<!-- biaoqingbao-dialect:end -->'));
  assert.ok(content.includes('东北话'));
});

test('applyDialectToIshiki：保留已有内容，追加人格块', () => {
  const root = makeTempAgentsRoot();
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n- 你是一个温暖的人\n', 'utf-8');

  applyDialectToIshiki('hanako', 'henan', 'on', root);
  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(content.startsWith('# 人格定义\n\n- 你是一个温暖的人'), '原有内容应保留');
  assert.ok(content.includes('土生土长的河南人'), '应为身份化习惯式描述');
  assert.ok(content.includes('biaoqingbao-dialect:start'), '应含方言块');
});

test('applyDialectToIshiki：重复写入幂等，只保留一个块', () => {
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('yumi', 'sichuan', 'on', root);
  applyDialectToIshiki('yumi', 'sichuan', 'on', root);
  const content = fs.readFileSync(path.join(root, 'agents', 'yumi', 'ishiki.md'), 'utf-8');
  const starts = content.split('<!-- biaoqingbao-dialect:start -->').length - 1;
  const ends = content.split('<!-- biaoqingbao-dialect:end -->').length - 1;
  assert.equal(starts, 1);
  assert.equal(ends, 1);
  assert.ok(content.includes('土生土长的四川人'), '应为习惯式文案');
});

test('removeDialectFromIshiki：移除块且保留其他内容', () => {
  const root = makeTempAgentsRoot();
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n- 你是一个温暖的人\n\n<!-- biaoqingbao-dialect:start -->\n你是地道的东北人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');

  const res = removeDialectFromIshiki('hanako', root);
  assert.equal(res.ok, true);
  assert.equal(res.removed, true);
  const content = fs.readFileSync(filePath, 'utf-8');
  assert.ok(!content.includes('biaoqingbao-dialect'), '方言块应被移除');
  assert.ok(content.includes('# 人格定义'), '原有内容应保留');
});

test('removeDialectFromIshiki：无块时返回 removed=false，不报错', () => {
  const root = makeTempAgentsRoot();
  const res = removeDialectFromIshiki('hanako', root); // 文件不存在
  assert.equal(res.ok, true);
  assert.equal(res.removed, false);
});

test('readDialectFromIshiki：读回写入的人格文案', () => {
  const root = makeTempAgentsRoot();
  applyDialectToIshiki('hanako', 'taiwan', 'light', root);
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('台湾'));
  assert.ok(persona.includes('超'));
});

test('syncDialectToIshiki：有配置写入、无配置移除（隔离目录，不碰真实人格文件）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  writeDialectConfig({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
    },
  });
  const results = syncDialectToIshiki({ version: 2, agents: { hanako: { dialect: 'dongbei', enabled: true } } }, root);
  assert.equal(typeof results, 'object');
  assert.ok(results.hanako && results.hanako.ok, 'hanako 应写入成功');
  // 验证写入的是隔离目录（回归：此前 sync 内部写真实 HANA_HOME，测试跑完把真实人格文件覆盖了）
  const persona = readDialectFromIshiki('hanako', root);
  assert.ok(persona.includes('土生土长的东北人'), '隔离目录应有方言块');
});

test('关闭方言后 sync 应移除人格块（回归：POST 保存后缓存已刷成新配置，旧配置必须显式传入）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  // 第一次保存：开启方言，写入人格块
  const first = { version: 2, agents: { hanako: { dialect: 'taiwan', enabled: true } } };
  writeDialectConfig(first);
  syncDialectToIshiki(first, root, null);
  assert.ok(readDialectFromIshiki('hanako', root).includes('台湾'), '开启后应有方言块');
  // 第二次保存：关闭方言（配置里不再有该助手）。模拟 POST 流程：
  // 先 writeDialectConfig（缓存刷成新配置）再 sync，previousConfig 传旧配置
  const second = { version: 2, agents: {} };
  writeDialectConfig(second);
  const results = syncDialectToIshiki(second, root, first);
  assert.ok(results.hanako && results.hanako.removed === true, '关闭后应移除方言块');
  assert.equal(readDialectFromIshiki('hanako', root), '', '人格文件里不应再有方言块');
  // 不传 previousConfig 的旧行为（读缓存）应保留：配置里本就没有的助手不会被误删别人的块
  const otherRoot = makeTempAgentsRoot();
  const withAgent = { version: 2, agents: { yumi: { dialect: 'sichuan', enabled: true } } };
  writeDialectConfig(withAgent);
  syncDialectToIshiki(withAgent, otherRoot, null);
  assert.ok(readDialectFromIshiki('yumi', otherRoot).includes('四川'), '正常开启流程不受影响');
});

test('已删除方言（闽南话）残留的人格块会被清理（回归：normalize 过滤后 remove 分支拿不到）', () => {
  useTempConfig();
  const root = makeTempAgentsRoot();
  // 模拟 v0.22 时代：用户配过闽南话，ishiki.md 已写入 minnan 块（老文案直接用标记块构造）
  const filePath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是土生土长的闽南人，打字带闽南味\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');
  const oldConfig = { version: 2, agents: { hanako: { dialect: 'minnan', enabled: true } } };
  assert.ok(readDialectFromIshiki('hanako', root), '前置：minnan 块应存在');
  // 升级到 v0.23：保存时 previousConfig 显式传入旧配置（含已删除的 minnan）
  const newConfig = { version: 2, agents: {} };
  writeDialectConfig(newConfig);
  const results = syncDialectToIshiki(newConfig, root, oldConfig);
  assert.ok(results.hanako && results.hanako.removed === true, 'minnan 助手应走 remove 分支');
  assert.equal(readDialectFromIshiki('hanako', root), '', '人格文件里不应再有 minnan 块');
  // 顺带：同一保存里换成新方言时不应误删（旧 minnan → 新 dongbei 应写入新块）
  const swapRoot = makeTempAgentsRoot();
  const swapPath = path.join(swapRoot, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(swapPath), { recursive: true });
  fs.writeFileSync(swapPath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是土生土长的闽南人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');
  const swapped = syncDialectToIshiki({ version: 2, agents: { hanako: { dialect: 'dongbei', enabled: true } } }, swapRoot, oldConfig);
  assert.ok(swapped.hanako && swapped.hanako.ok, '换方言应写入成功');
  const swappedText = readDialectFromIshiki('hanako', swapRoot);
  assert.ok(swappedText.includes('东北'), '应是东北话块而非残留');
  assert.ok(!swappedText.includes('闽南'), '不应残留 minnan 文案');
});

test('reconcileDialectToIshiki：配置有但文件缺块时补写，有块不动，无配置不碰', () => {
  const root = makeTempAgentsRoot();
  // yumi：配置有，但文件里没有块 → 应补写
  // hanako：配置有，文件已有块 → 不动
  const hanakoPath = path.join(root, 'agents', 'hanako', 'ishiki.md');
  fs.mkdirSync(path.dirname(hanakoPath), { recursive: true });
  fs.writeFileSync(hanakoPath, '# 人格定义\n\n<!-- biaoqingbao-dialect:start -->\n你是地道的东北人\n<!-- biaoqingbao-dialect:end -->\n', 'utf-8');

  const res = reconcileDialectToIshiki({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      yumi: { dialect: 'taiwan', enabled: true },
    },
  }, root);

  assert.deepEqual(res.fixed, ['yumi'], '应只补写缺块的 yumi');
  assert.deepEqual(res.failed, []);
  // yumi 补写成功
  assert.ok(readDialectFromIshiki('yumi', root).includes('台湾'));
  // hanako 内容未被改动（无重复块）
  const hanakoContent = fs.readFileSync(hanakoPath, 'utf-8');
  assert.equal(hanakoContent.split('biaoqingbao-dialect:start').length - 1, 1, 'hanako 不应被重复写块');
  // 再次 reconcile 幂等
  const res2 = reconcileDialectToIshiki({
    version: 2,
    agents: {
      hanako: { dialect: 'dongbei', enabled: true },
      yumi: { dialect: 'taiwan', enabled: true },
    },
  }, root);
  assert.deepEqual(res2.fixed, [], '第二次应无补写');
});

test('方言保存日志：写入读取往返，保留最近 200 条', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-log-'));
  const file = path.join(dir, 'dialect-log.json');
  appendDialectLog({ changed: [{ agentId: 'hanako', from: 'dongbei', to: 'henan' }], config: { version: 2 } }, file);
  appendDialectLog({ changed: [{ agentId: 'yumi', from: '未配置', to: 'taiwan' }], config: { version: 2 } }, file);
  const logs = readDialectLog(20, file);
  assert.equal(logs.length, 2);
  assert.ok(logs[0].ts, '应记录时间');
  assert.deepEqual(logs[1].changed[0], { agentId: 'yumi', from: '未配置', to: 'taiwan' });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('方言保存日志：读取不存在的文件返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biaoqingbao-dialect-log-'));
  const logs = readDialectLog(20, path.join(dir, 'nope.json'));
  assert.deepEqual(logs, []);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

test('方言库：每种方言例句里包含标志词的味道（抽查）', () => {
  const checks = {
    dongbei: ['搁', '咋'],
    henan: ['中', '嘞'],
    shanghai: ['阿拉', '伐'],
    cantonese: ['咁', '嘅'],
    taiwan: ['啦', '超'],
    sichuan: ['啥子', '巴适'],
    shaanxi: ['额', '咧'],
    beijing: ['得嘞', '倍儿'],
    xinjiang: ['歹', '谝'],
  };
  for (const [id, words] of Object.entries(checks)) {
    const joined = DIALECTS[id].examples.join(' ');
    for (const w of words) {
      assert.ok(joined.includes(w), `${id} 例句应包含「${w}」`);
    }
  }
});
