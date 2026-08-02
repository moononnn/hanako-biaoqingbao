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
  readTextConfig, getAgentFreqSettings, consumeAgentStickerCooldown, resolveAgentId,
  matchRitualWord, sanitizeTag,
} from '../lib/shared.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANA_HOME = process.env.HANA_HOME || join(homedir(), '.hanako');
const DATA_DIR = join(__dirname, '..', 'data');
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
const EMOTION_DETECT_PROMPT = `你是一个情绪感知器。分析对话上下文，判断助手在回复用户时可能感受到什么情绪，以及当前对话的场景类型。

只返回纯JSON（不要markdown代码块）：
{"has_emotion": true/false, "emotion": "", "scene_type": "", "reason": ""}

- has_emotion：助手在回复时是否有情绪波动（true=有，false=没有）
- emotion：助手可能感受到的情绪，一个词或短句。必须是情绪感受词，不要行为描述。
  ✅ 正确：兴奋、得意、委屈、心疼、无奈、感动、无语、治愈、吃瓜、撒娇、社死、emo、想抱抱你、哭笑不得、偷着乐
  ❌ 错误：耐心解释、正在思考、认真分析、努力帮忙（这些是行为，不是情绪）
  注意：尽量用具体的情绪词（如"兴奋""得意"）而不是泛词（如"开心"）
- scene_type：当前对话场景，三选一："闲聊"（日常聊天、吐槽、玩梗、情感交流）、"正事"（技术讨论、写代码、查资料、工作执行）、"中性"（介于两者之间，或难以判断时）
- reason：一句话说明为什么

判断标准：
- 关注的是"助手在回复时会感受到什么情绪"，不是用户的状态
- 即使是技术讨论，如果助手可能感到兴奋、得意、挫败等情绪，has_emotion 也可以是 true
- 纯粹的信息检索、文件操作、无情感色彩的执行任务 = 无情绪
- 情绪不需要很强烈，只要有"想表达点什么"的感觉就行`;

// ── HTTP 调用自己的 /api/text-analysis ──
async function callEmotionAnalysis(messages) {
  const server = getServerInfo();
  if (!server?.port || !server?.token) {
    return { ok: false, error: 'server-info 读取失败' };
  }
  const url = `http://127.0.0.1:${server.port}/api/plugins/biaoqingbao/api/text-analysis?token=${server.token}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, prompt: EMOTION_DETECT_PROMPT }),
      signal: AbortSignal.timeout(15000),
    });
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

// ── 注入提示（双通道）──
function injectPrompt(event, emotion) {
  // 通道 A：system 消息
  event.messages.push({ role: 'system', content: `表情包插件检测到你此刻可能有些${emotion}。你可以调用 express 工具发一张表情包来表达这个感受。` });

  // 通道 B：用户消息尾部行动提示
  const nudge = `\n\n💡 你似乎有些${emotion}，调用 express({ emotion: '${emotion}' }) 发一张表情包表达这个感受`;
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
      // 0. 全局开关与连续配图冷却
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

      // 5. 调辅助模型分析情绪 + 场景
      const result = await callEmotionAnalysis(event.messages);
      if (!result.ok) {
        appendLog(debugLogPath, `[context] 情绪分析失败: ${result.error}`);
        return;
      }

      const data = result.data;
      if (!data?.has_emotion) {
        appendLog(debugLogPath, `[context] 无情绪波动，跳过：${data?.reason || 'unknown'}`);
        return;
      }

      // v0.19.5 - 情绪词清洗（共用 sanitizeTag，去控制字符/换行/引号）
      const emotion = sanitizeTag(data.emotion || '', 30);
      if (!emotion) {
        appendLog(debugLogPath, `[context] has_emotion=true 但 emotion 为空或不合规，跳过`);
        return;
      }

      // 6. B 方案第二阶段：按 sceneFreq / preFreq 校准，使最终概率恰好等于场景频率
      const sceneType = data.scene_type || '中性';
      const sceneFreq = sceneType === '正事' ? freqSettings.task : freqSettings.daily;
      const conditionalPercent = getConditionalScenePercent(sceneFreq, preFreq);
      if (!passesFrequency(conditionalPercent)) {
        appendLog(debugLogPath, `[context] 情绪=${emotion} 场景=${sceneType} 目标=${sceneFreq}% 校准未通过`);
        return;
      }

      // 7. 注入提示
      if (injectPrompt(event, emotion)) {
        appendLog(debugLogPath, `[context] ✅ 情绪感知: ${emotion} | 场景: ${sceneType} | freq: ${sceneFreq} | reason: ${data.reason || ''}`);
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
