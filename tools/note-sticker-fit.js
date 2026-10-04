// note-sticker-fit.js — 伙伴配图自评工具
// 你自己发出去的图，贴不贴你想表达的，由你自己留一笔。
// 只记给「这个伙伴 + 这个情绪情境 + 这一张图」，跟用户的喜欢/不喜欢、应景是两本账。
// v1 只降权不升权：标「跑偏」的图以后在这个情境下少出现；标「到位」只如实记下。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR, resolveAgentId } from '../lib/shared.js';
import { applyAgentFitNote, isAgentSelfNoteEnabled } from '../lib/agent-fit-notes.js';
import { readRecentMatch, sessionIdFromContext } from '../lib/recent-match.js';

const STICKERS_FILE = join(DATA_DIR, 'stickers.json');

function reply(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

export const name = "note_sticker_fit";
export const description = "给你自己刚发出去的表情包留一笔：这张图贴不贴你当时想表达的。只有明显觉得「跑偏」或明显觉得「特别贴」时才用，不要每张都记，也不要为了表示自己认真而记。emotion 和 sticker_id 都可以不传，插件会默认对应你最近发出的那张。记「跑偏」会让这张图在你这个情绪下以后少出现；记「到位」只做记录。这张图本来就是你的表达，不用在回复里说明它是谁挑的、也不用为它道歉。";

export const parameters = {
  type: "object",
  properties: {
    fit: {
      type: "string",
      enum: ["off", "on"],
      description: "off = 这张跟你当时想表达的不符（跑偏）；on = 这张特别贴你想表达的。"
    },
    emotion: {
      type: "string",
      description: "可选：要记在哪个情绪情境下。不传则用你最近那张图对应的情绪。"
    },
    sticker_id: {
      type: "string",
      description: "可选：指定表情包 ID。不传则默认你最近发出的那张。"
    },
    reason: {
      type: "string",
      description: "可选：一句话说明，给自己以后翻看用。比如「画面太闹，我想说的是疲惫」。"
    }
  },
  required: ["fit"]
};

export async function execute(input, ctx) {
  const { fit, emotion, sticker_id, reason } = input || {};
  if (fit !== 'off' && fit !== 'on') {
    return reply({ ok: false, error: 'fit 必须是 off（跑偏）或 on（到位）' });
  }
  if (!isAgentSelfNoteEnabled({ dataDir: DATA_DIR })) {
    return reply({ ok: false, error: '用户已关闭伙伴配图自评，这次不记了' });
  }

  const agentId = resolveAgentId(null, ctx);
  let stickerId = typeof sticker_id === 'string' ? sticker_id.trim() : '';
  let contextEmotion = typeof emotion === 'string' ? emotion.trim() : '';

  // 不传图 ID 时，默认对应「这个会话里最近发出的那张」。
  if (!stickerId) {
    const sessionId = sessionIdFromContext(ctx);
    const record = sessionId ? readRecentMatch({ dataDir: DATA_DIR, sessionId }) : null;
    if (!record?.stickerId) {
      return reply({ ok: false, error: '这个会话里还没记录到你发过表情包，可以带上 sticker_id 再试' });
    }
    stickerId = record.stickerId;
    if (!contextEmotion) contextEmotion = String(record.emotion || '');
  }

  if (!contextEmotion) {
    return reply({ ok: false, error: '需要带上 emotion（这张图当时对应什么情绪）' });
  }

  // 校验图确实在库里，避免脏数据进账本（与用户反馈工具同一道闸）
  try {
    const raw = await readFile(STICKERS_FILE, 'utf-8');
    const stickers = JSON.parse(raw);
    if (!Array.isArray(stickers) || !stickers.some(s => s?.id === stickerId)) {
      return reply({ ok: false, error: '表情包不存在: ' + stickerId });
    }
  } catch {
    return reply({ ok: false, error: '表情包库读取失败，请稍后再试' });
  }

  const result = await applyAgentFitNote({
    dataDir: DATA_DIR,
    agentId,
    emotion: contextEmotion,
    stickerId,
    fit,
    note: reason,
  });
  if (!result.ok) return reply({ ok: false, error: result.error });

  ctx?.log?.info?.(`[biaoqingbao] 伙伴自评: agent=${agentId} emotion=${contextEmotion} sticker=${stickerId} fit=${fit} off=${result.off} on=${result.on}`);

  return reply({
    ok: true,
    data: {
      sticker_id: stickerId,
      emotion: contextEmotion,
      fit,
      off_count: result.off,
      on_count: result.on,
      message: fit === 'off'
        ? '记下了。这张以后在你这个情绪下会少出现。'
        : '记下了。这张在你这个情绪下贴得住。',
    }
  });
}
