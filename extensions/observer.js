// extensions/observer.js - 情绪感知器 + 场景频率控制
//
// v0.19.2：
//   - 统一使用 version 2 频率配置（enabled / daily / task）
//   - 两阶段精确抽样：先按 max(daily, task) 预筛省模型调用，再按 scene/max 校准
//   - 问候按日常频率抽样；全局关闭时所有自动提示都禁用
//   - express 真正发图后的下一轮 context 进入冷却，不连续提示配图

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import {
  readTextConfig, readAgentFreq, isAutoImageEnabled, getAgentFreqSettings,
  consumeAgentStickerCooldown, resolveAgentId, matchRitualWord, sanitizeTag,
  DATA_DIR, HANA_HOME,
} from '../lib/shared.js';
// v0.34.54 - Jev 旁路挂到 observer 的真实判断现场：同一轮、同一份情绪、同一句决策。
import { runJevShadow, shouldSampleNegative } from '../lib/jev-shadow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = join(HANA_HOME, 'server-info.json');

// readTextConfig 从 lib/shared.js 导入

// ── 读 Hana server info ──
function getServerInfo() {
  try {
    return JSON.parse(readFileSync(SERVER_INFO, 'utf-8'));
  } catch {
    return null;
  }
}

export function passesFrequency(percent, randomValue = Math.random()) {
  const probability = Math.max(0, Math.min(100, Number(percent) || 0));
  return randomValue < probability / 100;
}

export function getConditionalScenePercent(sceneFreq, preFreq) {
  if (preFreq <= 0 || sceneFreq <= 0) return 0;
  return Math.min(100, sceneFreq / preFreq * 100);
}

// ── v3 情绪感知 prompt（新增 scene_type）──
// v0.34.51 - 新增 keywords 输出：完整语境的信息不再只压进一个情绪词，
//   改由 keywords 承载「此刻在聊什么具体事」，供 express 的情境通道检索用。
//   emotion 仍要求是纯感受词，禁止把事件塞进情绪词里（实测长句向量匹配会退化成近随机）。
const EMOTION_DETECT_PROMPT = `你是一个情绪感知器。分析对话上下文，判断助手在回复用户时可能感受到什么情绪、此刻在聊什么具体的事，以及当前对话的场景类型。

只返回纯JSON（不要markdown代码块）：
{"has_emotion": true/false, "emotion": "", "keywords": [], "scene": "", "tone": "", "intensity": "", "scene_type": "", "reason": ""}

- has_emotion：助手在回复时是否有情绪波动（true=有，false=没有）
- emotion：助手可能感受到的情绪，一个词或短句。必须是情绪感受词，不要行为描述。
  ✅ 正确：兴奋、得意、委屈、心疼、无奈、感动、无语、治愈、吃瓜、撒娇、社死、emo、想抱抱你、哭笑不得、偷着乐
  ❌ 错误：耐心解释、正在思考、认真分析、努力帮忙（这些是行为，不是情绪）
  注意：尽量用具体的情绪词（如"兴奋""得意"）而不是泛词（如"开心"）。只写感受本身，不要把发生的事情塞进这个词里（写"哭笑不得"，不要写"被连续放鸽子的哭笑不得"）。
- keywords：3-6 个具体词，从对话里正在说的人、事、物中提取（如"加班""放鸽子""生日""猫""赶论文"）。这些词会拿去表情包库里找同一话题的图，越具体越好；不要放情绪词（"开心""难过"这类不要），不要抽象概念，不要长句。
- scene：这张图要回应的具体情境，最多4字（如"等回复""加班"）；不明确就留空。与 scene_type 的聊天类型不同。
- tone：回复时的表达姿态，如"自嘲""调侃""撒娇""安慰"；不明确就留空，不要把用户情绪误当伙伴的语气。
- intensity：伙伴这次表达的情绪强度，light / medium / strong；拿不准就留空。
- scene_type：当前对话场景，三选一："闲聊"（日常聊天、吐槽、玩梗、情感交流）、"正事"（技术讨论、写代码、查资料、工作执行）、"中性"（介于两者之间，或难以判断时）
- reason：一句话说明为什么（说清是什么事引发了什么情绪）

判断标准：
- 关注的是"助手在回复时会感受到什么情绪"，不是用户的状态
- 即使是技术讨论，如果助手可能感到兴奋、得意、挫败等情绪，has_emotion 也可以是 true
- 纯粹的信息检索、文件操作、无情感色彩的执行任务 = 无情绪
- 情绪不需要很强烈，只要有"想表达点什么"的感觉就行`;

// ── HTTP 调用自己的 /api/text-analysis ──
async function callEmotionAnalysis(messages, agentId = 'unknown') {
  const server = getServerInfo();
  if (!server?.port || !server?.token) {
    return { ok: false, error: 'server-info 读取失败' };
  }
  const url = `http://127.0.0.1:${server.port}/api/plugins/biaoqingbao/api/text-analysis?token=${server.token}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, agentId, prompt: EMOTION_DETECT_PROMPT }),
      signal: AbortSignal.timeout(15000),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Jev 旁路观测点 ──
// v0.34.54：这里采样，判出来的分才有对照物。正样本（真贴了图）必采，
// 负样本抽 25%，正负都有才判得出 Jev 到底更准还是只是更敢发。
const JEV_STATE_TURNS = 6;

function extractMsgText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.find(part => part?.type === 'text' && typeof part.text === 'string')?.text || '';
  }
  return '';
}

export function buildJevState(messages) {
  if (!Array.isArray(messages)) return '';
  return messages
    .filter(m => m?.role === 'user' || m?.role === 'assistant')
    .slice(-JEV_STATE_TURNS)
    .map(m => {
      const text = extractMsgText(m.content);
      return text ? `${m.role === 'user' ? '用户' : '助手'}：${text}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

function observeJev(logPath, event, ctx, { decision, data, emotion, sceneType, agentId, emotionLatencyMs, positive }) {
  if (!positive && !shouldSampleNegative()) return;
  void runJevShadow({
    state: buildJevState(event?.messages),
    actual: {
      decision,
      has_emotion: data?.has_emotion === true,
      emotion: emotion || data?.emotion || '',
      scene_type: sceneType || data?.scene_type || '',
      intensity: data?.intensity || '',
      emotion_latency_ms: emotionLatencyMs,
    },
    agentId,
    sessionId: event?.sessionId || event?.session_id || ctx?.sessionId || '',
    positive,
  }).catch((error) => {
    appendLog(logPath, `[context] Jev 旁路失败: ${error.message}`);
  });
}

// ── ritual 词表（问候词短路）──
const RITUAL_WORDS = [
  '早安', '早呀', '早上好', '早安呀', '中午好', '下午好',
  '晚安', '晚安安', '不早了', '该睡了',
  '你好', '哈喽', '嗨', 'hi', 'hello',
  '在吗', '想你'
];

function detectRitual(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  let last = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') { last = messages[i]; break; }
  }
  if (!last) return null;
  const text = (typeof last.content === 'string' ? last.content :
                (Array.isArray(last.content) ? (last.content.find(p => p?.type === 'text')?.text || '') : ''))
               .toLowerCase().trim();
  if (!text) return null;
  for (const w of RITUAL_WORDS) {
    // v0.19.5 - 英文短词用词边界（matchRitualWord），避免 this/while/something 误判 hi
    if (matchRitualWord(text, w)) return { word: w, text };
  }
  return null;
}

// ── 调试日志（带轮转，最多保留 500 行）──
const MAX_LOG_LINES = 500;
function appendLog(logPath, line) {
  try {
    const dir = dirname(logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    const entry = `${ts} ${line}\n`;
    // 检查文件大小，超过限制就截断保留最后 200 行
    try {
      const stat = statSync(logPath);
      if (stat.size > 200 * 1024) { // 200KB 以上截断
        const old = readFileSync(logPath, 'utf-8').split('\n').slice(-200).join('\n');
        writeFileSync(logPath, old + entry, { encoding: 'utf-8' });
        return;
      }
    } catch {}
    writeFileSync(logPath, entry, { flag: 'a', encoding: 'utf-8' });
  } catch {}
}

// v0.34.51 - 关键词清洗：数组或逗号分隔字符串都收，去重、截长、限个数
const MAX_KEYWORDS = 6;
const KEYWORD_MAX_LEN = 12;
export function sanitizeKeywords(raw, maxCount = MAX_KEYWORDS) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(/[,，、]/) : []);
  const out = [];
  for (const item of list) {
    const k = sanitizeTag(item, KEYWORD_MAX_LEN);
    if (!k || out.includes(k)) continue;
    out.push(k);
    if (out.length >= maxCount) break;
  }
  return out;
}

// ── 注入提示（双通道）──
// v0.34.51 - 带上 keywords 与 reason：keywords 让 express 的情境通道有东西可查，
//   reason 是这个压缩环节里最便宜却一直在被丢弃的上下文。
function injectPrompt(event, emotion, keywords = [], reason = '', query = {}) {
  const kwList = keywords.join('、');
  const because = reason ? `（${reason}）` : '';
  const kwCallArg = keywords.length ? `, keywords: '${kwList}'` : '';
  const queryArgs = kwCallArg + (query.scene ? `, scene: '${query.scene}'` : '')
    + (query.tone ? `, tone: '${query.tone}'` : '')
    + (query.intensity ? `, intensity: '${query.intensity}'` : '');

  // 通道 A：system 消息
  event.messages.push({
    role: 'system',
    content: `表情包插件感知到你此刻可能有些${emotion}${because}。你可以调用 express 工具发一张表情包来表达这个感受。`
      + (queryArgs ? `想发图时可带上已识别的情境信息：express({ emotion: '${emotion}'${queryArgs} })。` : ''),
  });

  // 通道 B：用户消息尾部行动提示
  const nudge = `\n\n💡 你似乎有些${emotion}。想发图的话，调用 express({ emotion: '${emotion}'${queryArgs} }) 表达这个感受${keywords.length ? '，keywords 传的是刚聊到的具体事物' : ''}`;
  let lastUserIdx = -1;
  for (let i = event.messages.length - 1; i >= 0; i--) {
    if (event.messages[i]?.role === 'user') { lastUserIdx = i; break; }
  }
  if (lastUserIdx === -1) return false;

  const userMsg = event.messages[lastUserIdx];
  if (typeof userMsg.content === 'string') {
    userMsg.content += nudge;
  } else if (Array.isArray(userMsg.content)) {
    userMsg.content.push({ type: 'text', text: nudge });
  }
  return true;
}

// ── Pi SDK Extension 入口 ──
export default function (pi) {
  const debugLogPath = join(DATA_DIR, 'observer-debug.log');
  console.log('[biaoqingbao] Pi Extension v3 加载完成（频率控制模式）');
  appendLog(debugLogPath, '[启动] Pi Extension v3 加载（频率控制模式）');

  // ── 核心：context 事件 = LLM 调用前，注入情绪感知提示 ──
  pi.on('context', async (event, ctx) => {
    const agentId = resolveAgentId(event, ctx);
    const msgCount = event?.messages?.length || 0;
    appendLog(debugLogPath, `[context] agent=${agentId} messages=${msgCount}`);

    try {
      // 0. 全局总闸与连续配图冷却；全局关闭不改写各伙伴原有频率配置。
      const freqConfig = readAgentFreq();
      if (!isAutoImageEnabled(freqConfig)) {
        appendLog(debugLogPath, '[context] 自动配图总闸已关闭，跳过情绪检测与配图提示');
        return;
      }
      const freqSettings = getAgentFreqSettings(agentId);
      if (!freqSettings.enabled) {
        appendLog(debugLogPath, `[context] 助手 ${agentId} 已关闭配图，跳过`);
        return;
      }
      if (consumeAgentStickerCooldown(agentId)) {
        appendLog(debugLogPath, `[context] 助手 ${agentId} 上一轮刚发过图，本轮冷却`);
        return;
      }

      // 1. 读配置
      const config = readTextConfig();
      if (!config.enabled) {
        appendLog(debugLogPath, `[context] 辅助模型未启用，跳过`);
        return;
      }

      // 2. 没消息不分析
      if (!Array.isArray(event?.messages) || event.messages.length === 0) {
        return;
      }

      // 3. 问候属于日常场景：只按 daily 抽一次，不调用辅助模型
      const ritualHit = detectRitual(event.messages);
      if (ritualHit) {
        if (!isAutoImageEnabled(readAgentFreq())) {
          appendLog(debugLogPath, '[context] 自动配图总闸在问候提示前关闭，跳过');
          return;
        }
        if (!passesFrequency(freqSettings.daily)) {
          appendLog(debugLogPath, `[context] ritual 命中但日常频率=${freqSettings.daily}% 未通过`);
          return;
        }
        if (injectPrompt(event, '开心')) {
          appendLog(debugLogPath, `[context] ritual 命中: ${ritualHit.word} -> 提示 express('开心')`);
          return { messages: event.messages };
        }
        return;
      }

      // 4. B 方案第一阶段：按两个场景中的最高频率预筛，提前省掉部分辅助模型调用
      const preFreq = Math.max(freqSettings.daily, freqSettings.task);
      if (!passesFrequency(preFreq)) {
        appendLog(debugLogPath, `[context] 助手 ${agentId} 预筛频率=${preFreq}% 未通过，跳过`);
        return;
      }

      // 5. 再检查一次总闸，覆盖频率预筛期间用户刚好关闭开关的竞态。
      if (!isAutoImageEnabled(readAgentFreq())) {
        appendLog(debugLogPath, '[context] 自动配图总闸在情绪检测前关闭，跳过');
        return;
      }

      // 6. 调辅助模型分析情绪 + 场景（v0.34.54 - 记录耗时，供 Jev 对比速度）
      const emotionStartedAt = Date.now();
      const result = await callEmotionAnalysis(event.messages, agentId);
      const emotionLatencyMs = Date.now() - emotionStartedAt;
      if (!result.ok) {
        appendLog(debugLogPath, `[context] 情绪分析失败: ${result.error} | 耗时 ${emotionLatencyMs}ms`);
        return;
      }

      const data = result.data;
      if (!data?.has_emotion) {
        appendLog(debugLogPath, `[context] 无情绪波动，跳过：${data?.reason || 'unknown'} | 耗时 ${emotionLatencyMs}ms`);
        observeJev(debugLogPath, event, ctx, { decision: 'no_emotion', data, agentId, emotionLatencyMs, positive: false });
        return;
      }

      // v0.19.5 - 情绪词清洗（共用 sanitizeTag，去控制字符/换行/引号）
      const emotion = sanitizeTag(data.emotion || '', 30);
      if (!emotion) {
        appendLog(debugLogPath, `[context] has_emotion=true 但 emotion 为空或不合规，跳过`);
        return;
      }

      // v0.34.51 - 关键词与 reason：一起注入，让配图检索有情境信息可用
      const keywords = sanitizeKeywords(data.keywords);
      const reason = sanitizeTag(data.reason || '', 40);
      const query = {
        scene: sanitizeTag(data.scene || '', 4),
        tone: sanitizeTag(data.tone || '', 12),
        intensity: ['light', 'medium', 'strong'].includes(data.intensity) ? data.intensity : '',
      };

      // 7. B 方案第二阶段：按 sceneFreq / preFreq 校准，使最终概率恰好等于场景频率
      const sceneType = data.scene_type || '中性';
      const sceneFreq = sceneType === '正事' ? freqSettings.task : freqSettings.daily;
      const conditionalPercent = getConditionalScenePercent(sceneFreq, preFreq);
      if (!passesFrequency(conditionalPercent)) {
        appendLog(debugLogPath, `[context] 情绪=${emotion} 场景=${sceneType} 目标=${sceneFreq}% 校准未通过 | 耗时 ${emotionLatencyMs}ms`);
        observeJev(debugLogPath, event, ctx, { decision: 'rejected', data, emotion, sceneType, agentId, emotionLatencyMs, positive: false });
        return;
      }

      // 8. 注入提示
      if (injectPrompt(event, emotion, keywords, reason, query)) {
        appendLog(debugLogPath, `[context] ✅ 情绪感知: ${emotion} | 关键词数: ${keywords.length} | 场景: ${sceneType} | freq: ${sceneFreq} | 耗时 ${emotionLatencyMs}ms`);
        observeJev(debugLogPath, event, ctx, { decision: 'injected', data, emotion, sceneType, agentId, emotionLatencyMs, positive: true });
        console.log(`[biaoqingbao] ✅ 情绪感知: ${emotion} (场景:${sceneType} freq:${sceneFreq})`);
        return { messages: event.messages };
      }
    } catch (e) {
      console.warn(`[biaoqingbao] observer 出错（不影响聊天）: ${e.message}`);
      appendLog(debugLogPath, `[context] ❌ 出错: ${e.message}`);
    }
  });

  pi.on('agent_end', (event, ctx) => {
    const agentId = resolveAgentId(event, ctx);
    appendLog(debugLogPath, `[agent_end] agent=${agentId}`);
  });

  pi.on('session_start', () => {
    appendLog(debugLogPath, `[session_start]`);
  });
}
