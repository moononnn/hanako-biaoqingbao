// extensions/dialect-boost.js - 方言加强版动态回响（v0.25.0）
//
// 人格文件（ishiki.md）是方言的「语感底座」，每轮系统提示都在，但长对话里模型
// 注意力会漂移。本扩展在每次模型调用前（context 事件）注入一句很短的方言回声，
// 拉回「打字带家乡味」的状态：
//   - 只在「方言开启 + 加强版开关（boost）打开」的助手生效（按 agentId 过滤）
//   - 正事场合自动让路：命中技术/工作关键词的本轮不注入（人格文件里的正事锚点兜底）
//   - 频率衰减：会话前 8 条消息必注入，之后按 60% 概率注入，省 token
//   - 只改内存中的请求消息数组，不落盘、不进记忆管道、用户界面不可见
//
// 注入内容遵循文案三原则：身份化（你打字带着X味）、零指令词、打字场景。

import { getAgentDialectSetting, buildDialectEcho, isWorkTalk, shouldBoostRound } from '../lib/dialect.js';
import { resolveAgentId } from '../lib/shared.js';

// 取最后一条用户消息的纯文本（兼容 string 与多模态 content 数组）
function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.find((p) => p?.type === 'text');
      if (t?.text) return t.text;
    }
    return '';
  }
  return '';
}

export default function (pi) {
  pi.on('context', (event, ctx) => {
    try {
      const agentId = resolveAgentId(event, ctx);
      const setting = getAgentDialectSetting(agentId);
      if (!setting || !setting.boost) return;
      const messages = event?.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      // 正事让路：本轮命中技术/工作信号就不注入
      if (isWorkTalk(lastUserText(messages))) return;
      // 频率衰减：会话前 8 条必注入，之后 60%
      if (!shouldBoostRound(messages.length)) return;
      const echo = buildDialectEcho(setting.dialect);
      if (!echo) return;
      messages.push({ role: 'system', content: echo });
      return { messages };
    } catch (e) {
      // 方言回响是锦上添花，任何异常都不能影响聊天
      console.warn(`[biaoqingbao] dialect-boost 出错（不影响聊天）: ${e.message}`);
    }
  });
}
