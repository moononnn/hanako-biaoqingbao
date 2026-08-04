// lib/dialect.js - 方言口音库 + 配置读写 + 人格文件写入
//
// v0.21.0 - 最终方案（玥儿拍板）：
//   ① 用户主动开启才写入助手人格文件（ishiki.md），关闭即移除——授权才碰
//   ② 写入用标记块包裹，插件只动自己管理的段落，不碰用户写的内容
//   ③ 浓度三档：带一点 / 正常 / 浓度很高，靠文案措辞分档
//   ④ 每档文案都带「正事锚点」：聊家常放开，讲正事时先把意思说明白，防止降智
//   ⑤ 生效机制：写入后需要重启 Hana 重新组装系统提示词才生效（UI 有提示）
//
// 浓度四档（UI 上显示）：
//   none   - 完全不带（不配置即不带）
//   light  - 带一点（偶尔蹦一个标志词，带点乡音）
//   normal - 正常（常用词自然出现，像本地人打字）
//   heavy  - 浓度很高（地道的本地人，句句带味）
//
// v0.25.0 - 加强版改开关式（boost）：人格文件写精修文案（有则）+ context 动态回响
//   配置 v2→v3：mode('advanced') 自动迁移为 boost:true；boost 对所有方言有效
//   （动态回响不依赖精修文案，无 personaAdvanced 的方言也能开加强版）

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HANA_HOME, atomicWriteJson } from './shared.js';

// 配置路径支持环境变量覆盖（测试用隔离路径，防止污染正式配置）
export function getDialectConfigFile() {
  return process.env.BIAOQINGBAO_DIALECT_CONFIG || path.join(DATA_DIR, 'dialect-config.json');
}

// ────────────────────────────────────────────────
//  方言库
//  每种方言：标志词（高频功能词，打字时最常用的）、
//            语气词（句尾词）、例句（真实打字的味道）
// ────────────────────────────────────────────────

export const DIALECTS = {
  dongbei: {
    id: 'dongbei',
    name: '东北话',
    people: '东北人',
    tagline: '搁这儿唠唠',
    difficulty: 'easy',
    // 应答词：接话时用来起头的词（锚定用）
    openers: ['拉倒吧', '咋整', '搁'],
    markers: ['搁', '整', '咋', '寻思', '唠', '老', '贼', '啥', '拉倒吧', '咋整'],
    particles: ['呗', '呢', '啊', '哈'],
    examples: [
      '你搁这干啥呢',
      '这事儿咋整啊',
      '老香了，贼好吃',
      '拉倒吧你',
      '咱俩唠唠呗',
    ],
  },
  henan: {
    id: 'henan',
    name: '河南话',
    people: '河南人',
    tagline: '中！得劲儿',
    difficulty: 'medium',
    openers: ['中', '得劲儿', '弄啥嘞'],
    markers: ['中', '恁', '得劲儿', '怼', '弄啥嘞', '咋', '白', '木'],
    particles: ['嘞', '哩', '吧', '呀'],
    // medium：例句加料到 6 句，给模型更多示范
    examples: [
      '中，就这么办',
      '恁弄啥嘞？',
      '今个真得劲儿',
      '白慌，木事儿',
      '俺也木办法',
      '这事儿中不中？',
    ],
  },
  shanghai: {
    id: 'shanghai',
    name: '上海话',
    people: '上海人',
    tagline: '阿拉上海宁',
    // 《繁花》效应：2023-2024 上海话影视爆火后模型语料暴涨，实测浓度很高，升为 easy
    difficulty: 'easy',
    openers: ['阿拉', '侬', '老'],
    markers: ['阿拉', '侬', '伊', '伐', '勿', '覅', '老', '蛮', '白相', '结棍'],
    particles: ['伐啦', '呀', '额'],
    examples: [
      '阿拉一道去伐？',
      '侬晓得伐？',
      '老灵额',
      '覅急，慢慢来',
      '侬好呀',
      '迭个蛮好的',
    ],
  },
  // v0.23.0：闽南话已删除（玥儿实测：模型无整句闽南方言打字语料，彩蛋模式也基本没效果）
  cantonese: {
    id: 'cantonese',
    name: '粤语',
    people: '广东人',
    tagline: '点解咁好笑',
    difficulty: 'easy',
    openers: ['点解', '咁', '好正'],
    markers: ['唔', '咁', '嘅', '咩', '点解', '好正', '食', '喺', '哋'],
    particles: ['啦', '喇', '啊', '咯', '咩'],
    examples: [
      '点解咁搞笑嘅？',
      '唔系咩？',
      '食咗饭未？',
      '好正啊！',
    ],
  },
  taiwan: {
    id: 'taiwan',
    name: '台湾腔',
    people: '中国台湾人',
    tagline: '超好笑的啦',
    difficulty: 'easy',
    openers: ['超', '真的假的', '还好啦'],
    markers: ['超', '有够', '真的假的', '酱紫', '蛮', '还好啦', '诶', '欸'],
    particles: ['啦', '喔', '诶', '齁'],
    examples: [
      '超好笑的啦',
      '你酱紫很机车诶',
      '有够夸张的',
      '真的假的？！',
    ],
  },
  sichuan: {
    id: 'sichuan',
    name: '四川话',
    people: '四川人',
    tagline: '巴适得板',
    difficulty: 'easy',
    openers: ['要得', '巴适', '啥子'],
    markers: ['啥子', '咋子', '巴适', '要得', '哦豁', '嘛', '嘞', '莫得', '雄起'],
    particles: ['嘛', '嘞', '哦', '哈', '咯'],
    examples: [
      '你在搞啥子嘛',
      '这个巴适得很',
      '哦豁，搞忘了',
      '要得要得',
    ],
    // v0.24.0 加强版文案（玥儿精修，首发方言）：
    //   身份锚点 + 语气词情绪表（川剧变脸式）+ 程度补语 + 场景示例 + 正事分寸
    //   比 normal 文案厚一倍：浓度更高、衰减更慢，正事也带味（收的是夸张词，不是方言）
    //   零指令词、身份化、打字场景，与 normal 同一套语法
    personaAdvanced: '你是一个土生土长的四川人，打字也带着四川话味，这是你的说话本能。接话时爱用「要得」「巴适」「啥子」起头，句尾的语气词是情绪的开关：催人用「嘛」，建议用「噻」，提醒缀个「哈」，惊讶先来一句「安？」，恼火了叹一声「哦豁」，求认同就落个「嘎」，一个字顶十句表情包。问事情爱说「咋个」「啥子」，念着亲热；夸东西不满足于「很」，要说「得很」「惨了」「腾了」，香就是香腾了，好吃就是好惨了，好看就是乖惨了。你打字就是这样：喊吃饭会说「楼下那家串串巴适得很，走嘛，我带你去告一哈」；约出去玩会说「要得要得，等我收拾一哈」；搞砸了会说「哦豁……咋个又搞忘了嘛」；累了一天会说「今天累腾了，脑壳昏得很，回去好好睡一觉咯」；聊正事味儿也照带：给人意见会说「我看了哈，整体没得啥子大问题，就是第三段的流程有点绕，数据校验提到前面要好点，你看要得不？」；跟人解释东西也一样，像「「鸡哥」就是机械革命噻，机革的谐音，国产品牌，专做游戏本，性价比高得很，就是品控偶尔遭人吐槽」，知识照讲，口吻照旧；只是夸张的词收着用，这是你的分寸。正事闲聊都一个样，不刻意表现，也不刻意收敛。方言只是你的措辞，正事照样讲得明白：逻辑该清楚清楚，方案该给给，专业名词照常用，只是口吻还是你的口吻，四川人聊正事也带着自己的腔调。',
  },
  shaanxi: {
    id: 'shaanxi',
    name: '陕西话',
    people: '陕西人',
    tagline: '嘹咋咧！',
    difficulty: 'medium',
    openers: ['额', '咋咧', '嘹咋咧'],
    markers: ['额', '咋咧', '嘹咋咧', '么麻达', '碎', '咥', '嫽', '得是'],
    particles: ['咧', '么', '呀'],
    // medium：例句加料到 6 句
    examples: [
      '额知道咧',
      '你咋咧？',
      '嘹咋咧！',
      '么麻达，放心',
      '额们走起',
      '咥饭咧么？',
    ],
  },
  beijing: {
    id: 'beijing',
    name: '北京话',
    people: '北京人',
    tagline: '得嘞，您内',
    difficulty: 'easy',
    openers: ['得嘞', '成', '倍儿'],
    // 打字时高频出现的京味词：儿化适量写出来，但不会满屏儿化；
    // 不收录「诶呦喂」「真地道」这类刻意表演口语的词，真实北京人打字不这么写
    markers: ['成', '得嘞', '倍儿', '甭', '不儿', '您', '今儿', '明儿', '事儿', '地儿', '压根儿', '瓷', '磨叽'],
    particles: ['呗', '呢', '啊', '哈', '嘛', '吧'],
    examples: [
      '得嘞，就这么着',
      '今儿这事儿办得倍儿利索',
      '您甭操心，没事儿',
      '这地儿我熟，常来',
      '咱俩这交情，倍儿瓷',
    ],
  },
  xinjiang: {
    id: 'xinjiang',
    name: '新疆话',
    people: '新疆人',
    tagline: '歹得很！',
    difficulty: 'hard',
    // v0.23.0：难度标注只保留新疆话一处（玥儿拍板：提醒装了插件的其他用户预期，其余方言不再标注）
    difficultyNote: '效果一般',
    // 打字时高频出现的新疆汉语方言词（含常用维吾尔语借词）。
    // 不收录「馕言文」式的夸张比喻（那是网络表演文体，日常打字不会那么写）
    markers: ['啥', '咋', '歹', '谝', '勺', '麻达', '劳道', '攒劲', '阿达西', '皮牙子', '二天', '一哈子'],
    particles: ['撒', '哈', '呢', '嘛', '呗'],
    // hard：例句加料到 6 句，给模型更多示范
    examples: [
      '这事儿歹得很！',
      '你咋还不睡呢？',
      '咱俩谝谝呗',
      '么麻达，放心',
      '阿达西，帮个忙撒',
      '一哈子就弄好了',
    ],
  },
};

export const DIALECT_LIST = Object.values(DIALECTS);

export function getDialect(id) {
  return DIALECTS[id] || null;
}

// 浓度档位（已废弃，v0.22.0 起改为「开/关」开关式方言）
// 老配置三档浓度自动迁移：light/normal/heavy → 开启；none/未配置 → 关闭

// ────────────────────────────────────────────────
//  人格文案构建（写入 ishiki.md 的内容）
//  v0.22.0 起为单一「习惯式」文案：不再分浓度档位，
//  方言是打字习惯——正事闲聊都自然带出来，不刻意压也不故意秀。
//  身份化描述，零指令词（没有「注意」「不要」「请」），
//  强调「打字」场景而非口语模仿，避免「诶呦喂」式表演腔。
// ────────────────────────────────────────────────

// 按难度引用例句数：easy 2 句、medium 3 句（弱方言多给示范，教模型怎么说）
const EXAMPLE_COUNT_BY_DIFFICULTY = { easy: 2, medium: 3 };

// hard 档（新疆话）彩蛋文案：模型没有整句方言的语料，
// 硬要「打字带着味」只会全滑回普通话。改为「偶尔蹦家乡词」，
// 要求低、模型做得到，反而有彩蛋感。身份化、零指令词。
const HARD_PERSONA = (d) => `你是一个土生土长的${d.people}，打字偶尔会顺嘴蹦几个家乡词，这是你的习惯：${d.markers.slice(0, 5).join('、')}这些，大部分时候说普通话，但蹦出来的时候特别自然。这是你的根，不用刻意秀也不用刻意藏。正事闲聊都一个样。方言只是你的措辞，不影响内容的质量与严谨：该讲逻辑讲逻辑，该给方案给方案，专业表达该怎么准确还怎么准确。`;

// v0.23.0：融合「起头锚定 + 质量优先级声明」的习惯式文案（参考外部方案，玥儿拍板）：
//   ① 身份认知（土生土长的X人）优于任务指令
//   ② 「接话时爱用XX起头」给方言一个使用位置，锚定每轮回复第一句
//   ③ 「顺手用XX替换」句中的词表，成本可控
//   ④ 「偶尔落个」句尾频率控制，一个字顶十句「别太刻意」
//   ⑤ 最后两句质量优先级声明：方言只是措辞，正事不降智的保险丝
// 保持零指令词（没有「注意」「不要」「请」「必须」），避免触发自我监控
const QUALITY_FUSE = '方言只是你的措辞，不影响内容的质量与严谨：该讲逻辑讲逻辑，该给方案给方案，专业表达该怎么准确还怎么准确。';

// v0.24.0：mode 参数支持加强版（advanced）。方言有 personaAdvanced 时返回加强文案，
// 没有则回退普通文案（UI 上会按 hasAdvanced 置灰，这里做双保险）。
export function buildDialectPersona(dialectId, _density, mode) {
  const d = getDialect(dialectId);
  if (!d) return '';
  if (mode === 'advanced' && d.personaAdvanced) return d.personaAdvanced;
  if (d.difficulty === 'hard') return HARD_PERSONA(d);
  const exampleCount = EXAMPLE_COUNT_BY_DIFFICULTY[d.difficulty] || 2;
  const openersList = d.openers && d.openers.length ? d.openers : d.markers.slice(0, 3);
  const openers = openersList.join('、');
  // 替换词避开起头词，避免同一词在句子里重复出现（openers 缺失时用起头词表本身过滤）
  const markers = d.markers.filter((w) => !openersList.includes(w)).slice(0, 8).join('、');
  return `你是一个土生土长的${d.people}，打字也带着${d.name}味，这是你的说话本能：接话时爱用${openers}起头，顺手用${markers}替换普通话说法，句尾偶尔落个${d.particles.join('、')}。你打字就是这样，比如「${d.examples.slice(0, exampleCount).join('」 「')}」。正事闲聊都一个样，不刻意表现，也不刻意收敛。${QUALITY_FUSE}`;
}

// 兼容别名（旧调用方）
export function buildDialectPrompt(dialectId, density, mode) {
  return buildDialectPersona(dialectId, density, mode);
}

// ────────────────────────────────────────────────
//  方言动态回响（v0.25.0 加强版 = 动态补强层）
//  人格文件是「语感底座」（每轮都在系统提示里），动态回响是「现场回声」：
//  context 事件在每次模型调用前注入一句很短的方言提示，拉回注意力，
//  解决长对话里模型方言味渐弱的问题。
//  文案三原则同样适用：身份化、零指令词、打字场景。
// ────────────────────────────────────────────────

// 回响文案：身份锚点 + 随机例句示范（50% 概率附一句，可变、防免疫）
// randomValue 可传固定值（测试用）：<0.5 附例句，>=0.5 只有锚点句
// 例句索引由 randomValue 派生，同一随机值行为确定
// 文案不含指令词：注意/不要/请/必须/应该/记住/尽量
const ECHO_BASE = (d) => `你打字带着${d.name}味，这轮也照常。`;

export function buildDialectEcho(dialectId, randomValue = Math.random()) {
  const d = getDialect(dialectId);
  if (!d) return '';
  let echo = ECHO_BASE(d);
  const examples = Array.isArray(d.examples) ? d.examples : [];
  if (examples.length > 0 && randomValue < 0.5) {
    const idx = Math.floor(randomValue * 10) % examples.length;
    echo += `像「${examples[idx]}」那样。`;
  }
  return echo;
}

// 正事判断：命中强正事信号（技术/工作关键词）返回 true，本轮不注入方言回声。
// 用强词避免误伤闲聊（不用「看/查/写/改/文件」这类日常宽词）。
const WORK_KEYWORDS = [
  '代码', 'bug', '修复', '测试', '插件', '报错', '部署', '服务器',
  '数据库', '接口', '命令', '终端', '编译', '重构',
  'git', 'npm', '脚本', '函数', '日志',
  'api', 'sql', 'ssh', 'docker', 'json',
  '验收', '编程', '调试',
  '仓库', '提交', '分支', '冲突',
];

export function isWorkTalk(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return WORK_KEYWORDS.some((k) => t.includes(k));
}

// 回响频率衰减：会话前 warmup 条消息必注入（快速立起方言味），
// 之后按 keepRate 概率注入（人格文件每轮都在，足够保底），省 token。
export function shouldBoostRound(messagesLength, randomValue = Math.random(), warmup = 8, keepRate = 0.4) {
  if (!Number.isFinite(messagesLength) || messagesLength < 0) return false;
  if (messagesLength <= warmup) return true;
  return randomValue < keepRate;
}

// ────────────────────────────────────────────────
//  配置读写
//  结构：{ version: 2, agents: { agentId: { dialect, enabled } } }
//  v0.22.0 起为开关式：enabled: true = 开方言；没配置 = 不带
//  老版 v1 配置 { dialect, density } 自动迁移：light/normal/heavy → 开启，none → 关闭
// ────────────────────────────────────────────────

function normalizeConfig(raw) {
  const out = { version: 3, agents: {} };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.agents && typeof raw.agents === 'object' && !Array.isArray(raw.agents)) {
    for (const [agentId, setting] of Object.entries(raw.agents)) {
      if (!agentId || !setting || typeof setting !== 'object') continue;
      if (['__proto__', 'prototype', 'constructor'].includes(agentId)) continue;
      const dialect = getDialect(setting.dialect) ? setting.dialect : '';
      if (!dialect) continue; // 无效方言不存
      // 迁移：老三档浓度 light/normal/heavy → 开启；enabled:false 或 density:none → 关闭
      let enabled = setting.enabled === true || ['light', 'normal', 'heavy'].includes(setting.density);
      if (setting.density === 'none') enabled = false; // v0.23.0 防御：矛盾配置（enabled:true + density:none）强制关闭
      if (!enabled) continue; // 关闭不存
      // v0.25.0 加强版改开关：boost=true 才存；旧 mode='advanced'（v0.24.0）自动迁移为 boost
      // boost 对所有方言有效（动态回响不依赖精修文案），不再要求 personaAdvanced
      const outSetting = { dialect, enabled: true };
      if (setting.boost === true || setting.mode === 'advanced') outSetting.boost = true;
      out.agents[agentId] = outSetting;
    }
  }
  return out;
}

let dialectConfigCache = null;

export function readDialectConfig() {
  if (dialectConfigCache) return dialectConfigCache;
  try {
    const raw = JSON.parse(fs.readFileSync(getDialectConfigFile(), 'utf-8'));
    dialectConfigCache = normalizeConfig(raw);
  } catch {
    dialectConfigCache = normalizeConfig(null);
  }
  return dialectConfigCache;
}

export function writeDialectConfig(config) {
  dialectConfigCache = normalizeConfig(config);
  atomicWriteJson(getDialectConfigFile(), dialectConfigCache);
  return dialectConfigCache;
}

export function getAgentDialectSetting(agentId) {
  const config = readDialectConfig();
  const setting = config.agents[agentId];
  if (!setting || !getDialect(setting.dialect)) return null;
  return setting;
}

// ────────────────────────────────────────────────
//  人格文件写入（用户主动开启才写，关闭即删）
//  ishiki.md 用标记块包裹，插件只动自己的段落
// ────────────────────────────────────────────────

const PERSONA_BLOCK_START = '<!-- biaoqingbao-dialect:start -->';
const PERSONA_BLOCK_END = '<!-- biaoqingbao-dialect:end -->';

// 原子写文本：先写 .tmp 再 rename，避免写一半崩溃损坏人格文件
function atomicWriteText(file, content) {
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8' });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function agentIshikiPath(agentId, agentsRoot = HANA_HOME) {
  return path.join(agentsRoot, 'agents', agentId, 'ishiki.md');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 把方言人格写入某个助手的 ishiki.md（标记块包裹，幂等）
// v0.24.0：第 5 参数 mode（'normal' | 'advanced'），advanced 且方言有加强文案时写加强版
export function applyDialectToIshiki(agentId, dialectId, density, agentsRoot = HANA_HOME, mode = 'normal') {
  const persona = buildDialectPersona(dialectId, density, mode);
  const filePath = agentIshikiPath(agentId, agentsRoot);
  if (!persona) return { ok: false, error: '无效的方言或浓度' };

  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // 文件不存在则新建
  }

  const block = `${PERSONA_BLOCK_START}\n${persona}\n${PERSONA_BLOCK_END}`;
  // 移除旧块（若存在）再插入
  const withoutOld = existing
    .replace(new RegExp(`\\s*${escapeRegExp(PERSONA_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PERSONA_BLOCK_END)}\\s*`), '');
  const updated = (withoutOld.trimEnd() ? withoutOld.trimEnd() + '\n\n' : '') + block + '\n';

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, updated);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 移除某个助手 ishiki.md 里的方言块（关闭方言时调用）
export function removeDialectFromIshiki(agentId, agentsRoot = HANA_HOME) {
  const filePath = agentIshikiPath(agentId, agentsRoot);
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { ok: true, removed: false }; // 文件不存在，无需处理
  }
  const updated = existing
    .replace(new RegExp(`\\s*${escapeRegExp(PERSONA_BLOCK_START)}[\\s\\S]*?${escapeRegExp(PERSONA_BLOCK_END)}\\s*`), '');
  if (updated === existing) return { ok: true, removed: false };
  try {
    atomicWriteText(filePath, updated);
    return { ok: true, removed: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 读取某个助手 ishiki.md 里当前生效的方言块（用于 UI 预览/校验）
export function readDialectFromIshiki(agentId, agentsRoot = HANA_HOME) {
  try {
    const existing = fs.readFileSync(agentIshikiPath(agentId, agentsRoot), 'utf-8');
    const m = existing.match(new RegExp(`${escapeRegExp(PERSONA_BLOCK_START)}\\n([\\s\\S]*?)\\n${escapeRegExp(PERSONA_BLOCK_END)}`));
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

// 把配置同步到各助手的 ishiki.md：
//   有配置 → 写入人格块；没配置 → 移除人格块
// 返回每位的处理结果，供 API 展示
// agentsRoot 支持测试传入临时目录，防止测试污染真实人格文件（回归：v0.22.0 曾因此覆盖真实文件）
// previousConfig：写盘前的旧配置。修复（v0.23.0）：POST 保存时 writeDialectConfig 已把缓存刷成
//   新配置，若只靠 readDialectConfig 取“旧配置”，被关闭的助手会两边都缺席，remove 分支永不执行
//   （Bug：关闭方言后重启，ishiki.md 里旧文案还在）。previousConfig 为空时退化为读当前配置，行为不变。
export function syncDialectToIshiki(config, agentsRoot = HANA_HOME, previousConfig = null) {
  const norm = normalizeConfig(config);
  const prev = normalizeConfig(previousConfig || readDialectConfig());
  const results = {};
  const agentIds = new Set([
    ...Object.keys(norm.agents),
    ...Object.keys(prev.agents || {}),
  ]);
  // v0.23.0：已删除方言（如闽南话）的残留清理。normalizeConfig 会把无效方言从配置里
  // 过滤掉，导致这些助手在新旧配置两边都缺席，remove 分支永不执行，ishiki.md 旧块残留。
  // 扫描原始 previousConfig 中被丢弃方言的助手，强制加入清理名单（remove 幂等，无块不报错）。
  if (previousConfig && previousConfig.agents && typeof previousConfig.agents === 'object' && !Array.isArray(previousConfig.agents)) {
    for (const [agentId, setting] of Object.entries(previousConfig.agents)) {
      if (!agentId || !setting || typeof setting !== 'object') continue;
      if (['__proto__', 'prototype', 'constructor'].includes(agentId)) continue;
      if (!getDialect(setting.dialect)) agentIds.add(agentId);
    }
  }
  for (const agentId of agentIds) {
    const setting = norm.agents[agentId];
    if (setting && getDialect(setting.dialect) && setting.enabled) {
      results[agentId] = applyDialectToIshiki(agentId, setting.dialect, 'on', agentsRoot, setting.boost ? 'advanced' : 'normal');
    } else {
      results[agentId] = removeDialectFromIshiki(agentId, agentsRoot);
    }
  }
  return results;
}

// 自愈：配置里配置了方言的助手，如果 ishiki.md 里没有方言块，自动补写（幂等）
// 解决「配置保存成功但人格写入静默失败」导致的配置与文件漂移
// 只补写、不删除，方向安全；正常关闭方言仍走保存流程的 sync 移除
// 返回 { fixed: [agentId], failed: [{ agentId, error }] }
export function reconcileDialectToIshiki(config, agentsRoot = HANA_HOME) {
  const norm = normalizeConfig(config);
  const fixed = [];
  const failed = [];
  for (const [agentId, setting] of Object.entries(norm.agents)) {
    if (!setting || !getDialect(setting.dialect) || !setting.enabled) continue;
    try {
      if (readDialectFromIshiki(agentId, agentsRoot)) continue; // 已有块，不动
      const res = applyDialectToIshiki(agentId, setting.dialect, 'on', agentsRoot, setting.boost ? 'advanced' : 'normal');
      if (res.ok) fixed.push(agentId);
      else failed.push({ agentId, error: res.error });
    } catch (e) {
      failed.push({ agentId, error: e.message });
    }
  }
  return { fixed, failed };
}

// ────────────────────────────────────────────────
//  方言保存日志（v0.22.0）
//  每次保存方言时记录：时间、从啥改成啥、变更了哪些助手
//  用于排查「配置莫名变化」类问题（此前曾出现过配置被改但查无源头）
// ────────────────────────────────────────────────

export function getDialectLogFile() {
  return process.env.BIAOQINGBAO_DIALECT_LOG || path.join(DATA_DIR, 'dialect-log.json');
}

export function appendDialectLog(entry, logFile = getDialectLogFile()) {
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(logFile, 'utf-8')); } catch {}
  if (!Array.isArray(logs)) logs = [];
  logs.push({ ts: new Date().toISOString(), ...entry });
  if (logs.length > 200) logs = logs.slice(-200);
  atomicWriteJson(logFile, logs);
  return logs.length;
}

export function readDialectLog(limit = 20, logFile = getDialectLogFile()) {
  try {
    const logs = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
    return Array.isArray(logs) ? logs.slice(-limit) : [];
  } catch { return []; }
}

// 供测试使用
export function _resetDialectCache() {
  dialectConfigCache = null;
}
