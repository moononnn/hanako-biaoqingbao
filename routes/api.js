// 表情包插件 - API 路由
// 提供：列表 / 图片 / 上传 / 修改 / 删除 / 识图自动打标 / 模型配置
// v0.17.4-share: 公共函数统一从 lib/shared.js 导入，消除代码重复
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import {
  STICKERS_DIR, DATA_DIR, PREFERENCES_FILE, BLOCKED_FILE,
  HANA_HOME, MIME_MAP,
  readMeta, writeMeta,
  readVisionConfig, writeVisionConfig, getProviderApiConfig,
  getAvailableVisionModels, getAvailableTextModels,
  tagImage,
  readEmbeddingConfig, writeEmbeddingConfig, resolveEmbeddingApi,
  generateEmbeddings, readVectors, writeVectors,
  readTextConfig, writeTextConfig,
  readAgentFreq as readAgentFreqConfig, writeAgentFreq as writeAgentFreqConfig,
  json, atomicWriteJson,
} from '../lib/shared.js';
import { upsertTeachingSample, removeTeachingSample } from '../lib/teaching.js';
import {
  DIALECT_LIST,
  readDialectConfig, writeDialectConfig, syncDialectToIshiki, reconcileDialectToIshiki,
  removeDialectFromIshiki,
  appendDialectLog, readDialectLog,
} from '../lib/dialect.js';
import { extractImagesFromZip, hasImageSignature, detectImageFormat } from '../lib/zip-images.js';
import { registerBatchTasksRoutes } from './_batch-tasks.js';

function nextStickerId(meta) {
  let max = 0;
  for (const sticker of meta) {
    const value = parseInt(String(sticker.id || '').replace(/^stk_/, '').replace(/^sticker_/, ''), 10);
    if (!Number.isNaN(value) && value > max) max = value;
  }
  return 'stk_' + String(max + 1).padStart(3, '0');
}

function splitTags(value) {
  return value ? String(value).split(',').map(item => item.trim()).filter(Boolean) : [];
}

function buildStickerEntry(id, destFile, sourceName, fields) {
  const ext = sourceName.split('.').pop();
  return {
    id,
    file: destFile,
    description: fields.description || sourceName.slice(0, -(ext.length + 1)),
    tags: {
      emotion: splitTags(fields.emotion),
      scene: splitTags(fields.scene),
      keywords: splitTags(fields.keywords),
    },
    added_at: new Date().toISOString(),
  };
}

export default async function registerRoutes(app, ctx) {
  ctx?.log?.info?.('[biaoqingbao] API 路由已注册');

  // v0.25.1 - 上传写队列：前端并发上传时，「读 meta → 分配 id → 写文件 → 追加 → 写 meta」
  // 必须串行，否则两个请求会分配到同一个 id 互相覆盖，或 meta.json 并发读改写丢失条目。
  // （坑 47：并发写文件竞态）
  let uploadWriteChain = Promise.resolve();
  function enqueueUploadWrite(task) {
    const p = uploadWriteChain.then(task, task);
    uploadWriteChain = p.catch(() => {});
    return p;
  }

  // ═══ GET /api/list — 列表（可按情绪筛选） ═══
  app.get('/api/list', (c) => {
    const emotion = c.req.query('emotion') || '';
    const meta = readMeta();
    let result = meta;
    if (emotion) {
      const emList = emotion.split(',').map(s => s.trim());
      result = meta.filter(s => emList.some(em =>
        (s.tags?.emotion || []).some(tag => tag.includes(em) || em.includes(tag))
      ));
    }
    return json({ ok: true, data: result, total: result.length });
  });

  // ═══ GET /api/image — 返回图片 ═══
  app.get('/api/image', (c) => {
    const id = c.req.query('id');
    if (!id) { c.status(400); return c.text('missing id'); }
    const s = readMeta().find(x => x.id === id);
    if (!s) { c.status(404); return c.text('not found'); }
    try {
      const data = fs.readFileSync(path.join(STICKERS_DIR, s.file));
      const ext = s.file.split('.').pop().toLowerCase();
      c.header('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
      c.header('Cache-Control', 'max-age=86400');
      return c.body(data);
    } catch { c.status(404); return c.text('file not found'); }
  });

  // ═══ POST /api — 上传/修改/删除 ═══
  app.post('/api', async (c) => {
    const body = await c.req.json();
    const action = body.action || '';

    // ── 上传 ──
    if (action === 'upload') {
      const { imageBase64, fileName, emotion, scene, keywords, description } = body;
      if (!imageBase64 || !fileName) return json({ ok: false, error: '缺少图片数据或文件名' });
      const ext = fileName.split('.').pop().toLowerCase();
      if (!['png','jpg','jpeg','gif','webp','bmp'].includes(ext))
        return json({ ok: false, error: '不支持的文件格式' });
      const imageData = Buffer.from(imageBase64.replace(/^data:image\/[\w.+-]+;base64,/, ''), 'base64');
      if (imageData.length === 0 || imageData.length > 20 * 1024 * 1024)
        return json({ ok: false, error: '图片为空或超过 20MB' });
      // v0.25.0 - 格式校验：先按扩展名查签名；不符时按真实签名识别格式入库（从群/聊天软件复制的动图常被存成 .jpg，
      // 内容其实是 GIF——识别出来按真实格式存，动图照常动；真识别不出才拒绝）
      let realExt = ext;
      if (!hasImageSignature(imageData, ext)) {
        const detected = detectImageFormat(imageData);
        if (!detected) return json({ ok: false, error: '图片内容与文件格式不符' });
        realExt = detected;
      }

      // 入库写操作进串行队列（校验在队列外，互不阻塞）
      return await enqueueUploadWrite(async () => {
        const meta = readMeta();
        const id = nextStickerId(meta);
        const destFile = id + '.' + realExt;
        const destPath = path.join(STICKERS_DIR, destFile);
        try {
          fs.mkdirSync(STICKERS_DIR, { recursive: true });
          fs.writeFileSync(destPath, imageData);
          const entry = buildStickerEntry(id, destFile, fileName, { emotion, scene, keywords, description });
          meta.push(entry); writeMeta(meta);
          return json({ ok: true, data: entry, message: '已入库' });
        } catch (error) {
          try { fs.unlinkSync(destPath); } catch {}
          return json({ ok: false, error: error.message || '图片入库失败' }, 500);
        }
      });
    }

    // ── ZIP 批量导入 ──
    if (action === 'import_zip') {
      const { zipBase64, fileName } = body;
      if (!zipBase64 || !fileName) return json({ ok: false, error: '缺少 ZIP 文件数据' });
      if (!fileName.toLowerCase().endsWith('.zip')) return json({ ok: false, error: '请选择 ZIP 文件' });

      const zipData = Buffer.from(zipBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (zipData.length === 0 || zipData.length > 50 * 1024 * 1024)
        return json({ ok: false, error: 'ZIP 文件为空或超过 50MB' });

      const writtenFiles = [];
      try {
        const { images, skipped } = await extractImagesFromZip(zipData);
        const meta = readMeta();
        const knownHashes = new Set();
        for (const sticker of meta) {
          try {
            const existing = fs.readFileSync(path.join(STICKERS_DIR, sticker.file));
            knownHashes.add(createHash('sha256').update(existing).digest('hex'));
          } catch {}
        }

        const imported = [];
        fs.mkdirSync(STICKERS_DIR, { recursive: true });
        for (const image of images) {
          const hash = createHash('sha256').update(image.data).digest('hex');
          if (knownHashes.has(hash)) {
            skipped.push({ file: image.fileName, reason: '图片内容重复' });
            continue;
          }
          knownHashes.add(hash);
          const id = nextStickerId(meta);
          const destFile = id + '.' + image.ext;
          const destPath = path.join(STICKERS_DIR, destFile);
          fs.writeFileSync(destPath, image.data);
          writtenFiles.push(destPath);
          const entry = buildStickerEntry(id, destFile, image.fileName, {});
          meta.push(entry);
          imported.push(entry);
        }
        writeMeta(meta);
        return json({
          ok: true,
          data: { imported: imported.length, skipped: skipped.length, skippedItems: skipped.slice(0, 30), importedIds: imported.map(e => e.id) },
          message: `成功导入 ${imported.length} 张，跳过 ${skipped.length} 个文件`,
        });
      } catch (error) {
        for (const file of writtenFiles) {
          try { fs.unlinkSync(file); } catch {}
        }
        return json({ ok: false, error: error.message || 'ZIP 导入失败' }, 500);
      }
    }

    // ── 修改 ──
    if (action === 'update') {
      const { id, emotion, scene, keywords, description, semantic_description, atmosphere } = body;
      if (!id) return json({ ok: false, error: '缺少ID' });
      const meta = readMeta();
      const idx = meta.findIndex(s => s.id === id);
      if (idx === -1) return json({ ok: false, error: '未找到' });
      // v0.26.0 教学样本：快照用户改标签前的名字/描述，改了就记教学（用户教一次，以后同类图识别更准）
      const before = {
        keywords: (meta[idx].tags?.keywords || []).slice(),
        description: meta[idx].description || '',
      };
      if (emotion !== undefined) meta[idx].tags.emotion = emotion.split(',').map(s => s.trim()).filter(Boolean);
      if (scene !== undefined) meta[idx].tags.scene = scene.split(',').map(s => s.trim()).filter(Boolean);
      if (keywords !== undefined) meta[idx].tags.keywords = keywords.split(',').map(s => s.trim()).filter(Boolean);
      if (description !== undefined) meta[idx].description = description;
      // v0.16.0：语义描述字段（用于向量检索）
      if (semantic_description !== undefined) meta[idx].semantic_description = semantic_description;
      // v0.11.0：氛围标签
      if (atmosphere !== undefined) meta[idx].tags.atmosphere = atmosphere.split(',').map(s => s.trim()).filter(Boolean);
      // v0.10.0：记录「最后一次识图应用」的时间，方便用户记住什么时候识过
      meta[idx].tagged_at = new Date().toISOString();
      writeMeta(meta);
      // v0.26.0：用户改了名字/描述 → 记教学样本（异步，不影响保存响应）
      const afterKw = meta[idx].tags?.keywords || [];
      const afterDesc = meta[idx].description || '';
      if (JSON.stringify(before.keywords) !== JSON.stringify(afterKw) || before.description !== afterDesc) {
        upsertTeachingSample(id, { description: afterDesc, keywords: afterKw, semanticDescription: meta[idx].semantic_description || '' })
          .catch(() => {});
      }
      return json({ ok: true, message: '已更新', tagged_at: meta[idx].tagged_at });
    }

    // ── 批量应用（识图结果一键写入，一次读改写 meta）──
    if (action === 'batch_update') {
      const { items } = body;
      if (!Array.isArray(items) || items.length === 0) return json({ ok: false, error: '缺少 items' });
      if (items.length > 1000) return json({ ok: false, error: '单次最多 1000 条' });
      const meta = readMeta();
      let updated = 0;
      const now = new Date().toISOString();
      for (const it of items) {
        if (!it || !it.id) continue;
        const idx = meta.findIndex(s => s.id === it.id);
        if (idx === -1) continue;
        const toList = (v) => Array.isArray(v) ? v.map(s => String(s).trim()).filter(Boolean) : splitTags(v);
        if (it.emotion !== undefined) meta[idx].tags.emotion = toList(it.emotion);
        if (it.scene !== undefined) meta[idx].tags.scene = toList(it.scene);
        if (it.keywords !== undefined) meta[idx].tags.keywords = toList(it.keywords);
        if (it.description !== undefined) meta[idx].description = it.description;
        if (it.semantic_description !== undefined) meta[idx].semantic_description = it.semantic_description;
        meta[idx].tagged_at = now;
        updated++;
      }
      if (updated === 0) return json({ ok: false, error: '没有找到可更新的表情包' });
      writeMeta(meta);
      return json({ ok: true, updated, message: `已应用 ${updated} 张` });
    }

    // ── 删除 ──
    if (action === 'delete') {
      const { id } = body;
      if (!id) return json({ ok: false, error: '缺少ID' });
      const meta = readMeta();
      const idx = meta.findIndex(s => s.id === id);
      if (idx === -1) return json({ ok: false, error: '未找到' });
      try { fs.unlinkSync(path.join(STICKERS_DIR, meta[idx].file)); } catch {}
      meta.splice(idx, 1); writeMeta(meta);

      // 同步清理偏好引用 + bad-matches.json
      let cleanedRefs = 0;
      try {
        const prefsFile = path.join(DATA_DIR, 'preferences.json');
        if (fs.existsSync(prefsFile)) {
          const prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
          for (const uid in (prefs.users || {})) {
            const mappings = prefs.users[uid].mappings || [];
            for (const m of mappings) {
              const beforeP = (m.preferred_ids || []).length;
              const beforeV = (m.vetoed_ids || []).length;
              const beforeD = m.dislike_counts ? Object.keys(m.dislike_counts).length : 0;
              m.preferred_ids = (m.preferred_ids || []).filter(x => x !== id);
              m.vetoed_ids = (m.vetoed_ids || []).filter(x => x !== id);
              if (m.dislike_counts) delete m.dislike_counts[id];
              cleanedRefs += (beforeP - m.preferred_ids.length) + (beforeV - m.vetoed_ids.length)
                + (beforeD - (m.dislike_counts ? Object.keys(m.dislike_counts).length : 0));
            }
          }
          if (cleanedRefs > 0) atomicWriteJson(prefsFile, prefs);
        }
      } catch {}
      try {
        const bmFile = path.join(DATA_DIR, 'bad-matches.json');
        if (fs.existsSync(bmFile)) {
          const bm = JSON.parse(fs.readFileSync(bmFile, 'utf-8'));
          const before = (bm.records || []).length;
          bm.records = (bm.records || []).filter(r => r.sticker_id !== id);
          if (bm.records.length < before) atomicWriteJson(bmFile, bm);
        }
      } catch {}
      // v0.19.5 - 同步清理该图的向量，避免孤儿向量污染索引与状态页
      try {
        const vd = readVectors();
        if (vd.vectors && vd.vectors[id]) {
          delete vd.vectors[id];
          vd.generated_at = new Date().toISOString();
          writeVectors(vd);
        }
      } catch {}
      // v0.26.0 - 同步清理该图的教学样本（删图后不再参与后续识别参考）
      try { removeTeachingSample(id); } catch {}

      const msg = cleanedRefs > 0 ? `已删除（清理了 ${cleanedRefs} 条偏好引用）` : '已删除';
      return json({ ok: true, message: msg, cleanedReferences: cleanedRefs });
    }

    return json({ ok: false, error: '未知操作' });
  });

  // ═══ POST /api/smart-pick — 智能选图（HTTP 接口版，供 web_fetch 调用）═══
  app.post('/api/smart-pick', async (c) => {
    const body = await c.req.json();
    const { context, hint } = body;
    if (!context) return json({ ok: false, error: '缺少 context' });

    ctx?.log?.info?.('[biaoqingbao] HTTP smart-pick 被调用');

    // 1. 分析上下文
    const ANALYSIS_PROMPT = '你是一个表情包选择助手。分析对话上下文，判断是否适合发表情包，并提取关键词。\n\n只返回纯JSON（不要markdown代码块，不要其他文字）：\n{"should_use": true/false, "emotion": "", "keywords": [], "intensity": "medium", "reason": ""}\n\n规则：\n- 正经问答、写代码、查资料、严肃讨论 → should_use=false\n- 聊天、吐槽、撒娇、玩梗、日常闲聊、安慰、恭喜 → should_use=true\n- emotion 只能选这6个之一：搞笑 / 开心 / 难过 / 无语 / 感谢 / 鼓励\n- keywords：从对话中提取2-5个具体词\n- intensity：light / medium / strong\n- reason：一句话说明为什么适合/不适合';

    let analysis;
    try {
      const result = await ctx.bus.request('utility:call-text', {
        messages: [
          { role: 'system', content: ANALYSIS_PROMPT },
          { role: 'user', content: `对话上下文：\n${context}\n${hint ? `\n额外提示：${hint}` : ''}` }
        ],
        maxTokens: 250,
        temperature: 0.3,
        operation: 'biaoqingbao-http-smart-pick'
      }, { timeoutMs: 15000 });

      const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
      const cleaned = text.replace(/\`\`\`json?\s*/g, '').replace(/\`\`\`/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch (e) {
      ctx?.log?.warn?.('[biaoqingbao] HTTP smart-pick LLM 不可用:', e.message);
      return json({ ok: false, error: 'LLM 分析不可用', fallback: true });
    }

    if (!analysis.should_use) {
      return json({ ok: true, data: { action: 'skip', reason: analysis.reason || '不适合发表情包', analysis } });
    }

    // 2. 搜索匹配
    const stickers = readMeta();
    const emotion = analysis.emotion ? [analysis.emotion] : [];
    const kwList = analysis.keywords || [];

    const scored = stickers.map(s => {
      let score = 0; const tags = s.tags || {};
      for (const kw of kwList) {
        for (const tag of (tags.keywords || [])) {
          if (tag === kw) score += 5;
          else if (tag.includes(kw) || kw.includes(tag)) score += 2;
        }
        if (s.description && s.description.includes(kw)) score += 2;
      }
      for (const em of emotion) {
        for (const tag of (tags.emotion || [])) {
          if (tag === em) score += 3;
          else if (tag.includes(em) || em.includes(tag)) score += 1;
        }
      }
      return { ...s, _score: score };
    }).filter(s => s._score > 0).sort((a, b) => b._score - a._score);

    if (scored.length === 0) {
      return json({ ok: true, data: { action: 'skip', reason: '没有找到匹配的表情包' } });
    }

    const best = scored[0];
    ctx?.log?.info?.(`[biaoqingbao] HTTP smart-pick 选中: ${best.description} (score=${best._score})`);

    // 3. 返回结果（不含 data URL，客户端用 /api/image?id=xxx 加载图片）
    return json({
      ok: true,
      data: {
        action: 'send',
        sticker: {
          id: best.id,
          description: best.description,
          emotion: analysis.emotion,
          score: best._score
        }
      }
    });
  });

  // ═══ GET /api/vision-models — 返回可用视觉模型列表 ═══
  app.get('/api/vision-models', (c) => {
    return json({ ok: true, data: getAvailableVisionModels() });
  });

  // ═══ GET /api/vision-config — 返回当前视觉模型配置 ═══
  app.get('/api/vision-config', (c) => {
    const cfg = readVisionConfig();
    // 不返回 API key 明文，只返回是否有值
    return json({
      ok: true,
      data: {
        ...cfg,
        customApiKey: cfg.customApiKey ? '********' : '',
      },
    });
  });

  // ═══ POST /api/vision-config — 保存视觉模型配置 ═══
  app.post('/api/vision-config', async (c) => {
    const body = await c.req.json();
    const cfg = readVisionConfig();
    if (body.source !== undefined) cfg.source = body.source;
    if (body.providerId !== undefined) cfg.providerId = body.providerId;
    if (body.modelId !== undefined) cfg.modelId = body.modelId;
    if (body.customBaseUrl !== undefined) cfg.customBaseUrl = body.customBaseUrl;
    if (body.customModel !== undefined) cfg.customModel = body.customModel;
    // 只有前端传了非空值才覆盖密码（避免 ******** 覆盖）
    if (body.customApiKey !== undefined && body.customApiKey !== '' && body.customApiKey !== '********') {
      cfg.customApiKey = body.customApiKey;
    }
    writeVisionConfig(cfg);
    return json({ ok: true, message: '模型配置已保存' });
  });

  // ═══ POST /api/vision-test - 测试识图模型连通性 (v0.15.1) ═══
  app.post('/api/vision-test', async (c) => {
    try {
      const body = await c.req.json();
      // 用表单配置（不写盘），发一张 1x1 测试图给模型
      let baseUrl, apiKey, model;
      if (body.source === 'custom') {
        baseUrl = body.customBaseUrl;
        apiKey = body.customApiKey;
        model = body.customModel;
      } else if (body.providerId) {
        const pc = getProviderApiConfig(body.providerId);
        baseUrl = pc.baseUrl;
        apiKey = pc.apiKey;
        model = body.modelId;
      } else {
        return json({ ok: false, error: '未选择模型' });
      }
      if (!baseUrl || !apiKey || !model) {
        return json({ ok: false, error: '配置不完整，请填写所有字段' });
      }
      // 1x1 红色 PNG
      const testImg = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
      const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: '这是什么颜色？一个词回答。' },
            { type: 'image_url', image_url: { url: testImg } },
          ]}],
          max_tokens: 50,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        return json({ ok: false, error: `HTTP ${resp.status}: ${text.substring(0, 200)}` });
      }
      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content || '';
      return json({ ok: true, data: { reply: reply.substring(0, 100) || '连接成功（空回复）' } });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  });

  // ═══ POST /api/auto-tag - 识图自动打标签（单张） ═══
  app.post('/api/auto-tag', async (c) => {
    try {
      const { imageBase64, fileName } = await c.req.json();
      if (!imageBase64) return json({ ok: false, error: '缺少图片数据' });
      const result = await tagImage(imageBase64, fileName);
      if (!result.ok) ctx?.log?.warn?.('[biaoqingbao] 单图识图失败:', result.error);
      return json(result);
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 识图失败:', e.message);
      return json({ ok: false, error: e.message });
    }
  });

  // ═══ POST /api/auto-tag-id — 按 id 单张识图（v0.25.1）═══
  // 卡片上的「识图」按钮走这个：当场识别、当场写入标签，不再绕后台任务。
  // preview=true 时只识别不落库（编辑器预览用，用户点保存才生效）。
  app.post('/api/auto-tag-id', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const id = body && body.id;
      if (!id) return json({ ok: false, error: '缺少 id' }, 400);
      const preview = body.preview === true;
      const meta = readMeta();
      const sticker = meta.find(s => s.id === id);
      if (!sticker) return json({ ok: false, error: '表情包不存在' }, 404);
      const filePath = path.join(STICKERS_DIR, sticker.file);
      if (!fs.existsSync(filePath)) return json({ ok: false, error: '图片文件不存在' }, 404);
      const buf = fs.readFileSync(filePath);
      const result = await tagImage(buf.toString('base64'), sticker.file);
      if (!result.ok) {
        ctx?.log?.warn?.('[biaoqingbao] 单张识图失败:', result.error);
        return json({ ok: false, error: result.error || '识图失败' });
      }
      const sug = result.data || {};
      if (preview) {
        ctx?.log?.info?.('[biaoqingbao] 单张识图预览:', id);
        return json({ ok: true, data: sug, message: '识别完成（预览，点保存才生效）' });
      }
      // 写回前重新读最新快照再合并：识图期间其他写操作（上传/删除/改标签）不能丢（发布前审查修复）
      const latest = readMeta();
      const idx = latest.findIndex(s => s.id === id);
      if (idx === -1) return json({ ok: false, error: '表情包不存在' }, 404);
      if (sug.description) latest[idx].description = sug.description;
      if (sug.semantic_description) latest[idx].semantic_description = sug.semantic_description;
      if (Array.isArray(sug.emotion)) latest[idx].tags.emotion = sug.emotion.filter(Boolean);
      if (Array.isArray(sug.scene)) latest[idx].tags.scene = sug.scene.filter(Boolean);
      if (Array.isArray(sug.keywords)) latest[idx].tags.keywords = sug.keywords.filter(Boolean);
      latest[idx].tagged_at = new Date().toISOString();
      writeMeta(latest);
      ctx?.log?.info?.('[biaoqingbao] 单张识图并应用:', id);
      return json({ ok: true, data: sug, message: '识图完成，标签已应用' });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 单张识图应用失败:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ POST /api/batch-auto-tag — 异步批量识图任务（由 _batch-tasks.js 注册）═══
  // v0.12.0 重构：旧版同步版已迁移到 _batch-tasks.js 模块，支持异步后台 + 持久化 + 断点续跑
  // v0.14.12 修复：删除本地残留的旧同步版实现（之前某个版本回归，导致 Hono 按注册顺序先匹配此处，
  //   串行遍历每张图片调视觉模型，3 张最坏 180 秒，前端 fetch 永远 pending → 体验成批识图卡死）
  // 详见 routes/_batch-tasks.js

  // 文本模型配置从 lib/shared.js 导入（readTextConfig, writeTextConfig, getAvailableTextModels）

  // GET /api/text-models — 列出 Hana 可用文本模型
  app.get('/api/text-models', (c) => {
    return json({ ok: true, data: getAvailableTextModels() });
  });

  // GET /api/text-config — 读取当前配置（API Key 脱敏）
  app.get('/api/text-config', (c) => {
    const cfg = readTextConfig();
    return json({
      ok: true,
      data: {
        ...cfg,
        customApiKey: cfg.customApiKey ? '********' : '',
      },
    });
  });

  // POST /api/text-config — 保存配置
  app.post('/api/text-config', async (c) => {
    const body = await c.req.json();
    const cfg = readTextConfig();
    if (body.enabled !== undefined) cfg.enabled = !!body.enabled;
    if (body.source !== undefined) cfg.source = body.source;
    if (body.providerId !== undefined) cfg.providerId = body.providerId;
    if (body.modelId !== undefined) cfg.modelId = body.modelId;
    if (body.customBaseUrl !== undefined) cfg.customBaseUrl = body.customBaseUrl;
    if (body.customModel !== undefined) cfg.customModel = body.customModel;
    // 非空值才覆盖 key（避免 ******** 把真值覆盖掉）
    if (body.customApiKey !== undefined && body.customApiKey !== '' && body.customApiKey !== '********') {
      cfg.customApiKey = body.customApiKey;
    }
    writeTextConfig(cfg);
    return json({ ok: true, message: '内容分析模型配置已保存' });
  });

  // POST /api/text-test — 测试模型连接
  // 前端表单里改了想立刻测试时，会把当前表单 cfg 一起发过来；
  // 不带 body 时测的是磁盘上已保存的。
  app.post('/api/text-test', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const disk = readTextConfig();
      // 合并策略：表单 cfg 覆盖磁盘 cfg，customApiKey 特殊处理（占位符或空 → 用磁盘真值）
      const cfg = (body && Object.keys(body).length > 0) ? { ...disk, ...body } : disk;
      if (!cfg.customApiKey || cfg.customApiKey === '********') {
        cfg.customApiKey = disk.customApiKey || '';
      }
      const testPrompt = '你好，这是一条连接测试消息。请用一句话简短回应。';

      if (cfg.source === 'hana') {
        if (!cfg.providerId || !cfg.modelId) {
          return json({ ok: false, error: '请先选择供应商和模型' }, 400);
        }
        // 走 utility:call-text（参考坑 14）
        const result = await ctx.bus.request('utility:call-text', {
          messages: [{ role: 'user', content: testPrompt }],
          providerId: cfg.providerId,
          modelId: cfg.modelId,
          maxTokens: 100,
          temperature: 0.5,
          operation: 'biaoqingbao-text-test'
        }, { timeoutMs: 20000 });

        const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
        return json({ ok: true, data: { reply: String(text).substring(0, 200), provider: cfg.providerId, model: cfg.modelId } });
      }

      if (cfg.source === 'custom') {
        if (!cfg.customBaseUrl || !cfg.customApiKey || !cfg.customModel) {
          return json({ ok: false, error: '请填写完整的自定义配置（API 地址 / Key / 模型名）' }, 400);
        }
        const resp = await fetch(`${cfg.customBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.customApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.customModel,
            messages: [{ role: 'user', content: testPrompt }],
            max_tokens: 100,
            temperature: 0.5,
          }),
          signal: AbortSignal.timeout(20000),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return json({ ok: false, error: `HTTP ${resp.status}: ${text.substring(0, 200)}` }, 200);
        }

        const data = await resp.json();
        const reply = data.choices?.[0]?.message?.content || '';
        return json({ ok: true, data: { reply: String(reply).substring(0, 200), provider: 'custom', model: cfg.customModel } });
      }

      return json({ ok: false, error: '未知来源类型' }, 400);
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 内容分析模型测试失败:', e.message);
      return json({ ok: false, error: e.message }, 200);
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.8 缺图统计和 bad match API
  // ════════════════════════════════════════════════════════════════

  const MISSING_CATS_FILE = path.join(DATA_DIR, 'missing-categories.json');

  function readMissingCategories() {
    try {
      const raw = JSON.parse(fs.readFileSync(MISSING_CATS_FILE, 'utf-8'));
      return raw.categories || {};
    } catch {
      return {};
    }
  }

  // GET /api/missing-categories — 读取缺图统计
  app.get('/api/missing-categories', (c) => {
    const cats = readMissingCategories();
    // 过滤出需要提醒的（miss_count >= 2 或 bad_match_count >= 1）
    const alerts = [];
    for (const [key, val] of Object.entries(cats)) {
      if (val.miss_count >= 2 || val.bad_match_count >= 1) {
        alerts.push({ key, ...val });
      }
    }
    // 按 last_occurrence 降序
    alerts.sort((a, b) => new Date(b.last_occurrence) - new Date(a.last_occurrence));
    return json({ ok: true, data: alerts });
  });

  // POST /api/missing-categories — 清除/重置缺图记录
  app.post('/api/missing-categories', async (c) => {
    const body = await c.req.json();
    const action = body.action || '';

    if (action === 'clear_all') {
      atomicWriteJson(MISSING_CATS_FILE, { categories: {} });
      return json({ ok: true, message: '已清空所有缺图提醒' });
    }

    if (action === 'clear_key') {
      const key = body.key;
      if (!key) return json({ ok: false, error: '缺少 key' });
      const cats = readMissingCategories();
      delete cats[key];
      atomicWriteJson(MISSING_CATS_FILE, { categories: cats });
      return json({ ok: true, message: '已清除该缺图提醒' });
    }

    return json({ ok: false, error: '未知操作' });
  });

  // POST /api/text-analysis — 实际调用辅助模型分析对话内容
  // observer 会调这个；手动触发测试也可以
  // 输入：{ messages: [...], context: '...' }
  // 输出：{ should_use, emotion, keywords, intensity, reason }
  app.post('/api/text-analysis', async (c) => {
    try {
      const body = await c.req.json();
      const { messages, context, prompt } = body;
      if (!messages && !context) {
        return json({ ok: false, error: '缺少 messages 或 context' }, 400);
      }

      const cfg = readTextConfig();

      // 提取 message.content 里的文字（兼容 string / array / object / null）
      // Pi SDK 的 messages 里 assistant 多模态消息的 content 经常是
      // [{ type: 'text', text: '...' }, { type: 'tool_use', ... }] 这样的数组
      function extractText(content) {
        if (content == null) return '';
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
          return content
            .map(p => {
              if (p == null) return '';
              if (typeof p === 'string') return p;
              if (typeof p === 'object') {
                if (typeof p.text === 'string') return p.text;
                if (typeof p.content === 'string') return p.content;
                if (typeof p.input === 'object') return ''; // tool_use 之类，不混入对话
              }
              return '';
            })
            .filter(Boolean)
            .join(' ');
        }
        if (typeof content === 'object' && typeof content.text === 'string') return content.text;
        return '';
      }

      // 构造要分析的内容（取最后几条消息）
      let toAnalyze = context || '';
      if (!toAnalyze && Array.isArray(messages)) {
        toAnalyze = messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-6)
          .map(m => {
            const text = extractText(m.content);
            return text ? `${m.role === 'user' ? '用户' : '助手'}：${text}` : '';
          })
          .filter(Boolean)
          .join('\n');
      }

      // v2: 支持自定义 prompt
      const usePrompt = prompt || `你是一个表情包配图决策助手。分析最近的对话，判断助手这一轮回复是否适合配一张表情包，以及配什么情绪/关键词。

只返回纯 JSON（不要 markdown 代码块，不要其他文字）：
{"should_use": true/false, "emotion": "", "keywords": [], "intensity": "medium", "reason": ""}

规则：
- 正经问答、写代码、查资料、严肃讨论、纯指令 → should_use=false
- 闲聊、吐槽、撒娇、玩梗、日常问候、安慰、恭喜、感谢、鼓励 → should_use=true
- emotion 只能选 6 个之一：搞笑 / 开心 / 难过 / 无语 / 感谢 / 鼓励
- keywords：从对话中提取 2-5 个具体词（如"加班""打工人""猫咪""生日"），不要泛泛的词
- intensity：light=轻微日常 / medium=普通情绪 / strong=强烈情绪
- reason：一句话说明为什么适合/不适合`;

      let analysisText = '';

      if (cfg.source === 'hana') {
        if (!cfg.providerId || !cfg.modelId) {
          return json({ ok: false, error: '未配置 Hana 模型', fallback: true }, 200);
        }
        const result = await ctx.bus.request('utility:call-text', {
          messages: [
            { role: 'system', content: usePrompt },
            { role: 'user', content: `最近的对话：\n${toAnalyze}` }
          ],
          providerId: cfg.providerId,
          modelId: cfg.modelId,
          maxTokens: 250,
          temperature: 0.3,
          operation: 'biaoqingbao-text-analysis'
        }, { timeoutMs: 15000 });

        analysisText = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
      } else if (cfg.source === 'custom') {
        if (!cfg.customBaseUrl || !cfg.customApiKey || !cfg.customModel) {
          return json({ ok: false, error: '未配置自定义模型', fallback: true }, 200);
        }
        const resp = await fetch(`${cfg.customBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.customApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.customModel,
            messages: [
              { role: 'system', content: usePrompt },
              { role: 'user', content: `最近的对话：\n${toAnalyze}` }
            ],
            max_tokens: 250,
            temperature: 0.3,
          }),
          signal: AbortSignal.timeout(15000),
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => '');
          return json({ ok: false, error: `模型返回 HTTP ${resp.status}: ${text.substring(0, 200)}` }, 200);
        }
        const data = await resp.json();
        analysisText = data.choices?.[0]?.message?.content || '';
      } else {
        return json({ ok: false, error: '未知来源类型', fallback: true }, 200);
      }

      // 解析 JSON
      const cleaned = analysisText.replace(/```json?\s*/g, '').replace(/```/g, '').trim();
      let analysis;
      try {
        analysis = JSON.parse(cleaned);
      } catch {
        const m = cleaned.match(/\{[\s\S]*\}/);
        if (m) {
          try { analysis = JSON.parse(m[0]); } catch {}
        }
      }
      if (!analysis) {
        return json({ ok: false, error: '模型返回格式无法解析', raw: analysisText.substring(0, 300) }, 200);
      }

      return json({ ok: true, data: analysis });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 内容分析失败:', e.message);
      return json({ ok: false, error: e.message, fallback: true }, 200);
    }
  });

  // ═══ GET /api/display-config — 读取配图卡片显示配置 ═══
  app.get('/api/display-config', (c) => {
    let cfg = { smallImageFit: true };
    try {
      cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'display-config.json'), 'utf-8')) };
    } catch {}
    return json({ ok: true, data: cfg });
  });

  // ═══ POST /api/display-config — 保存配图卡片显示配置 ═══
  app.post('/api/display-config', async (c) => {
    try {
      const body = await c.req.json();
      const threshold = Math.max(50, Math.min(500, Number(body.smallImageThreshold) || 200));
      const cfg = {
        smallImageFit: typeof body.smallImageFit === 'boolean' ? body.smallImageFit : true,
        smallImageThreshold: threshold,
      };
      atomicWriteJson(path.join(DATA_DIR, 'display-config.json'), cfg);
      return json({ ok: true, data: cfg });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ GET /api/preferences — 读取偏好 ═══
  app.get('/api/preferences', (c) => {
    const agent = c.req.query('agent') || '';
    const prefsFile = path.join(DATA_DIR, 'preferences.json');
    try {
      const raw = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
      if (agent && raw.users[agent]) {
        return json({ ok: true, data: raw.users[agent] });
      }
      return json({ ok: true, data: raw });
    } catch {
      return json({ ok: true, data: { version: 1, users: {} } });
    }
  });

  // ═══ POST /api/preferences/correct — 纠正偏好 ═══
  app.post('/api/preferences/correct', async (c) => {
    try {
      const body = await c.req.json();
      const { agent, sticker_id, context_emotion, context_keywords, feedback_type } = body || {};
      if (!sticker_id || !feedback_type) {
        return json({ ok: false, error: '缺少必要参数' }, 400);
      }

      const prefsFile = path.join(DATA_DIR, 'preferences.json');
      let prefs = { version: 1, users: {} };
      try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf-8')); } catch {}

      const agentId = agent || 'default';
      if (!prefs.users[agentId]) prefs.users[agentId] = { mappings: [] };
      const user = prefs.users[agentId];

      const kwList = (context_keywords || '').split(',').map(s => s.trim()).filter(Boolean);
      const emotion = context_emotion || '';

      let mapping = user.mappings.find(m => {
        if (m.context.emotion !== emotion) return false;
        const mKws = m.context.keywords || [];
        // v0.19.5 - 双方都无关键词也视为匹配（之前空数组 some 恒 false，导致每次反馈都新建重复 mapping）
        if (kwList.length === 0 && mKws.length === 0) return true;
        return kwList.some(k => mKws.includes(k)) && mKws.some(k => kwList.includes(k));
      });

      if (!mapping) {
        mapping = {
          context: { emotion, keywords: kwList },
          preferred_ids: [], vetoed_ids: [], dislike_counts: {}, weight: 1,
          updated_at: new Date().toISOString()
        };
        user.mappings.push(mapping);
      }

      if (feedback_type === 'positive') {
        // v0.25.0 - 喜欢：清掉累计不喜欢次数，移除历史拉黑，加入 preferred
        mapping.vetoed_ids = mapping.vetoed_ids.filter(id => id !== sticker_id);
        if (mapping.dislike_counts) delete mapping.dislike_counts[sticker_id];
        if (!mapping.preferred_ids.includes(sticker_id)) mapping.preferred_ids.push(sticker_id);
      } else {
        // v0.25.0 - 不喜欢改为累计计数（多轮不喜欢 → 频率衰减），不再写入 vetoed 硬拉黑
        mapping.preferred_ids = mapping.preferred_ids.filter(id => id !== sticker_id);
        if (!mapping.dislike_counts) mapping.dislike_counts = {};
        mapping.dislike_counts[sticker_id] = (mapping.dislike_counts[sticker_id] || 0) + 1;
      }
      mapping.weight = Math.min(10, mapping.weight + 1);
      mapping.updated_at = new Date().toISOString();

      atomicWriteJson(prefsFile, prefs);
      const dislikeCount = (mapping.dislike_counts || {})[sticker_id] || 0;
      return json({ ok: true, message: '偏好已更新', dislike_count: dislikeCount });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ POST /api/preferences/update — 手动调整偏好映射 ═══
  // 支持：set_weight / remove_from_list / delete_mapping
  app.post('/api/preferences/update', async (c) => {
    try {
      const body = await c.req.json();
      const { action, agent, mapping_index, list, sticker_id, weight } = body || {};
      if (!action) return json({ ok: false, error: '缺少 action' }, 400);

      const prefsFile = path.join(DATA_DIR, 'preferences.json');
      let prefs = { version: 1, users: {} };
      try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf-8')); } catch {}

      const agentId = agent || 'default';
      const user = prefs.users[agentId];
      if (!user || !user.mappings || !user.mappings[mapping_index]) {
        return json({ ok: false, error: '未找到该映射' }, 404);
      }
      const mapping = user.mappings[mapping_index];

      if (action === 'set_weight') {
        const w = parseInt(weight, 10);
        if (Number.isNaN(w)) return json({ ok: false, error: '权重必须是数字' }, 400);
        mapping.weight = Math.max(0, Math.min(10, w));
      } else if (action === 'remove_from_list') {
        if (!sticker_id || !list) return json({ ok: false, error: '缺少 sticker_id 或 list' }, 400);
        if (list === 'preferred') {
          mapping.preferred_ids = (mapping.preferred_ids || []).filter(id => id !== sticker_id);
        } else if (list === 'vetoed') {
          mapping.vetoed_ids = (mapping.vetoed_ids || []).filter(id => id !== sticker_id);
        } else if (list === 'dislikes') {
          // v0.25.0 - 移除某张图的不喜欢累计次数
          if (mapping.dislike_counts) delete mapping.dislike_counts[sticker_id];
        } else {
          return json({ ok: false, error: 'list 必须是 preferred / vetoed / dislikes' }, 400);
        }
      } else if (action === 'delete_mapping') {
        user.mappings.splice(mapping_index, 1);
      } else {
        return json({ ok: false, error: '未知 action: ' + action }, 400);
      }
      mapping.updated_at = new Date().toISOString();
      user.updated_at = new Date().toISOString();

      // 确保目录存在并写入（原子写，避免断电/崩溃损坏）
      atomicWriteJson(prefsFile, prefs);
      return json({ ok: true, message: '已更新' });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ POST /api/preferences/cleanup — 清理已删除 sticker 的偏好引用 ═══
  app.post('/api/preferences/cleanup', async (c) => {
    try {
      const meta = readMeta();
      const validIds = new Set(meta.map(s => s.id));

      const prefsFile = path.join(DATA_DIR, 'preferences.json');
      let prefs = { version: 1, users: {} };
      try { prefs = JSON.parse(fs.readFileSync(prefsFile, 'utf-8')); } catch {}

      let cleanedPrefs = 0;
      let cleanedMappings = 0;
      for (const uid in (prefs.users || {})) {
        const mappings = prefs.users[uid].mappings || [];
        const kept = [];
        for (const m of mappings) {
          const beforeP = (m.preferred_ids || []).length;
          const beforeV = (m.vetoed_ids || []).length;
          const beforeD = m.dislike_counts ? Object.keys(m.dislike_counts).length : 0;
          m.preferred_ids = (m.preferred_ids || []).filter(x => validIds.has(x));
          m.vetoed_ids = (m.vetoed_ids || []).filter(x => validIds.has(x));
          if (m.dislike_counts) {
            for (const k of Object.keys(m.dislike_counts)) {
              if (!validIds.has(k)) delete m.dislike_counts[k];
            }
          }
          cleanedPrefs += (beforeP - m.preferred_ids.length) + (beforeV - m.vetoed_ids.length)
            + (beforeD - (m.dislike_counts ? Object.keys(m.dislike_counts).length : 0));
          // 如果 mapping 偏好、排除、不喜欢计数都是空，删除整条
          const hasAny = m.preferred_ids.length > 0 || m.vetoed_ids.length > 0
            || (m.dislike_counts && Object.keys(m.dislike_counts).length > 0);
          if (!hasAny) {
            cleanedMappings += 1;
            continue;
          }
          kept.push(m);
        }
        prefs.users[uid].mappings = kept;
      }
      if (cleanedPrefs > 0 || cleanedMappings > 0) {
        atomicWriteJson(prefsFile, prefs);
      }
      return json({ ok: true, cleanedReferences: cleanedPrefs, cleanedMappings, message: `已清理 ${cleanedPrefs} 条引用、${cleanedMappings} 条空映射` });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ GET /api/decision-log — 读取决策日志 ═══
  app.get('/api/decision-log', (c) => {
    const agent = c.req.query('agent') || '';
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const logFile = path.join(DATA_DIR, 'decision-log.json');
    try {
      const raw = JSON.parse(fs.readFileSync(logFile, 'utf-8'));
      let entries = raw.entries || [];
      if (agent) entries = entries.filter(e => e.agent === agent);
      entries = entries.slice(-limit).reverse();
      return json({ ok: true, data: { entries }, total: entries.length });
    } catch {
      return json({ ok: true, data: { entries: [] }, total: 0 });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.18.0 聊天调整表情包标签（多轮对话 + AI 提议）
  // ════════════════════════════════════════════════════════════════

  const chatSessions = new Map();
  const CHAT_SESSION_TTL = 30 * 60 * 1000; // 30 分钟无活动则过期

  function genSessionId() {
    return 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
  }

  function cleanupChatSessions() {
    const now = Date.now();
    for (const [sid, s] of chatSessions) {
      if (now - s.lastActive > CHAT_SESSION_TTL) chatSessions.delete(sid);
    }
  }

  // 调用 content analysis 模型（优先 Hana utility:call-text，fallback 自定义 API）
  async function callTextModel(messages, opts = {}) {
    const cfg = readTextConfig();
    if (!cfg.enabled) return { ok: false, error: '内容分析模型未启用，请在设置中启用' };

    if (cfg.source === 'hana') {
      if (!cfg.providerId || !cfg.modelId) {
        return { ok: false, error: '请先在设置中选择内容分析模型' };
      }
      try {
        const result = await ctx.bus.request('utility:call-text', {
          messages,
          providerId: cfg.providerId,
          modelId: cfg.modelId,
          maxTokens: opts.maxTokens || 800,
          temperature: opts.temperature || 0.5,
          operation: 'biaoqingbao-sticker-chat',
        }, { timeoutMs: opts.timeoutMs || 30000 });
        const text = typeof result === 'string' ? result : (result.text || result.content || JSON.stringify(result));
        return { ok: true, data: text };
      } catch (e) {
        return { ok: false, error: '模型调用失败: ' + (e.message || e) };
      }
    }

    if (cfg.source === 'custom') {
      if (!cfg.customBaseUrl || !cfg.customApiKey || !cfg.customModel) {
        return { ok: false, error: '请先在设置中配置自定义模型' };
      }
      try {
        const resp = await fetch(`${cfg.customBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${cfg.customApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: cfg.customModel,
            messages,
            max_tokens: opts.maxTokens || 800,
            temperature: opts.temperature || 0.5,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs || 30000),
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          return { ok: false, error: `模型 HTTP ${resp.status}: ${t.substring(0, 200)}` };
        }
        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        return { ok: true, data: text };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    return { ok: false, error: '未知的模型来源' };
  }

  // 系统 prompt：指导 AI 怎么跟用户聊标签调整
  const STICKER_CHAT_PROMPT = `你是表情包标签调整助手。用户要跟你聊一张表情包的标签哪里不对、应该怎么改。

你的能力边界：
- 你看不到图片，只能看到当前的标签字面 + 用户说的话
- 基于用户的反馈提调整建议，不要凭空想象图片内容
- 如果用户说的不够清楚，可以追问澄清

对话节奏：
- 多轮对话很正常，用户可能解释、追问、否定你的建议
- 用自然语言跟用户聊，不要每轮都急着出修改方案
- 达成共识时：才输出修改建议块（用 <suggestion> 标签包裹 JSON）

输出格式：
1. 自然语言回复在前：表达理解、说你的看法、给建议或追问
2. 如果达成共识（用户认可你的调整方向），在回复末尾追加修改建议块：

<suggestion>
{"description":"新描述","semantic_description":"新语义描述","emotion":["新情绪"],"scene":["新场景"],"keywords":["新关键词"]}
</suggestion>

字段要求：
- description: 一句话描述，10-25 字
- semantic_description: 30-50 字，描述这张图适合在什么场景回复什么内容
- emotion: 1-3 个具体情绪词（委屈、撒娇、得意、社死），不要行为描述
- scene: 每个不超过 4 个字（催回复、吐槽、早安、安慰）
- keywords: 4-8 个具体画面元素词

注意：
- 没变化的字段也要写，保持 JSON 完整
- 输出 <suggestion> 后用户点了确认就会写入，所以要谨慎，只在用户明确同意时输出
- 如果用户还在犹豫/追问/否定，只用自然语言回复，不要加 <suggestion>`;

  // ── POST /api/sticker/chat ──
  app.post('/api/sticker/chat', async (c) => {
    try {
      cleanupChatSessions();

      const body = await c.req.json();
      const { sticker_id, message, session_id } = body || {};
      if (!sticker_id || !message) return json({ ok: false, error: '缺少 sticker_id 或 message' }, 400);

      const meta = readMeta();
      const sticker = meta.find(s => s.id === sticker_id);
      if (!sticker) return json({ ok: false, error: '表情包不存在' }, 404);

      // 获取或创建 session
      let sid = session_id;
      let session;
      if (sid && chatSessions.has(sid) && chatSessions.get(sid).sticker_id === sticker_id) {
        session = chatSessions.get(sid);
      } else {
        sid = genSessionId();
        session = { sticker_id, history: [], lastActive: Date.now() };
        chatSessions.set(sid, session);
      }

      session.history.push({ role: 'user', content: message });
      session.lastActive = Date.now();

      // 构造当前标签的描述（系统消息里告诉 AI）
      const tags = sticker.tags || {};
      const currentTagsText = [
        '【当前标签】',
        '描述：' + (sticker.description || '（无）'),
        '语义描述：' + (sticker.semantic_description || '（无）'),
        '情绪：' + ((tags.emotion || []).join('、') || '（无）'),
        '场景：' + ((tags.scene || []).join('、') || '（无）'),
        '关键词：' + ((tags.keywords || []).join('、') || '（无）'),
      ].join('\n');

      // v0.18.0 - 历史定位：找这张图上次是何时何地发的，拿当时那段对话作为参考
      let usageContextText = '';
      try {
        const logRaw = fs.readFileSync(path.join(DATA_DIR, 'decision-log.json'), 'utf-8');
        const logData = JSON.parse(logRaw);
        const entries = (logData.entries || [])
          .filter(e => e.sticker_id === sticker_id && e.session_path && e.context_ts)
          .sort((a, b) => (b.context_ts || 0) - (a.context_ts || 0));

        for (const entry of entries) {
          const sessionFile = resolveLoggedSessionPath(entry.session_path);
          if (!sessionFile || !fs.existsSync(sessionFile)) continue;
          const found = findMessageNearTs(sessionFile, entry.context_ts, 'assistant');
          if (!found) continue;

          const beforeText = found.before ? extractMessageText(found.before.content) : '';
          const targetText = extractMessageText(found.target.content);
          const afterText = found.after ? extractMessageText(found.after.content) : '';
          const trim = (s) => s.length > 200 ? s.slice(0, 200) + '…' : s;

          usageContextText = [
            '',
            '【这张图上次被使用的语境】',
            '时间：' + entry.ts,
            beforeText ? '上一轮用户说：' + trim(beforeText) : '',
            '这张图出现在助手回复里：' + trim(targetText),
            afterText ? '下一轮对话：' + trim(afterText) : '',
          ].filter(Boolean).join('\n');
          break; // 只用最近的次
        }
      } catch (e) {
        // 查不到 context 就静默跳过，不报错
      }

      const messages = [
        { role: 'system', content: STICKER_CHAT_PROMPT + '\n\n' + currentTagsText + usageContextText },
        ...session.history,
      ];

      const result = await callTextModel(messages, { maxTokens: 900, temperature: 0.6 });
      if (!result.ok) return json({ ok: false, error: result.error }, 500);

      const rawReply = result.data || '';
      session.history.push({ role: 'assistant', content: rawReply });

      // 截断历史，避免太长（保留最近 20 条 = 10 轮）
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }
      session.lastActive = Date.now();

      // 提取 <suggestion> 块
      let suggestion = null;
      const sugMatch = rawReply.match(/<suggestion>([\s\S]*?)<\/suggestion>/);
      if (sugMatch) {
        try {
          const parsed = JSON.parse(sugMatch[1].trim());
          if (parsed && typeof parsed === 'object') {
            suggestion = {
              description: String(parsed.description || sticker.description || '').trim(),
              semantic_description: String(parsed.semantic_description || sticker.semantic_description || '').trim(),
              emotion: Array.isArray(parsed.emotion) ? parsed.emotion.filter(Boolean).map(String) : (tags.emotion || []),
              scene: Array.isArray(parsed.scene) ? parsed.scene.filter(Boolean).map(String).map(s => s.slice(0, 4)) : (tags.scene || []),
              keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter(Boolean).map(String) : (tags.keywords || []),
            };
          }
        } catch (e) {
          ctx?.log?.warn?.('[biaoqingbao] suggestion JSON 解析失败:', e.message);
        }
      }

      // 清理回复中的 <suggestion> 标签，前端展示更干净
      const cleanReply = rawReply.replace(/<suggestion>[\s\S]*?<\/suggestion>/g, '').trim();

      // v0.25.0 - 附带旧标签，前端（配图卡片内联聊天）可直接渲染修改前后对照
      return json({ ok: true, session_id: sid, reply: cleanReply, suggestion, old_tags: {
        description: sticker.description || '',
        emotion: tags.emotion || [],
        scene: tags.scene || [],
        keywords: tags.keywords || [],
      } });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] chat error:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ── POST /api/sticker/chat/confirm ──
  app.post('/api/sticker/chat/confirm', async (c) => {
    try {
      const body = await c.req.json();
      const { session_id, sticker_id, new_tags } = body || {};
      if (!sticker_id || !new_tags) return json({ ok: false, error: '缺少 sticker_id 或 new_tags' }, 400);
      if (typeof new_tags !== 'object' || Array.isArray(new_tags)) return json({ ok: false, error: 'new_tags 必须是对象' }, 400);

      // v0.25.0 - 会话归属校验：提供了 session_id 就必须存在且属于该 sticker（防跨图确认）
      // 会话过期（TTL 30 分钟）时降级放行并记日志：页面有鉴权，边缘情况不让用户白点一次
      if (session_id) {
        const session = chatSessions.get(session_id);
        if (!session) {
          ctx?.log?.warn?.('[biaoqingbao] confirm 会话不存在（可能已过期）: ' + session_id);
        } else if (session.sticker_id !== sticker_id) {
          return json({ ok: false, error: '会话与表情包不匹配' }, 400);
        }
      }

      const meta = readMeta();
      const idx = meta.findIndex(s => s.id === sticker_id);
      if (idx < 0) return json({ ok: false, error: '表情包不存在' }, 404);

      const sticker = meta[idx];

      // v0.26.0 教学样本：快照确认前的名字/描述（聊天式改标签也是用户显式教学）
      const before = {
        keywords: (sticker.tags?.keywords || []).slice(),
        description: sticker.description || '',
      };

      // v0.25.0 - new_tags 白名单严格校验：只接受已知字段，类型/长度全部收紧，防脏数据入库
      const cleanTags = {};
      if (new_tags.description !== undefined) {
        if (typeof new_tags.description !== 'string') return json({ ok: false, error: 'description 必须是字符串' }, 400);
        cleanTags.description = new_tags.description.trim().slice(0, 100);
      }
      if (new_tags.semantic_description !== undefined) {
        if (typeof new_tags.semantic_description !== 'string') return json({ ok: false, error: 'semantic_description 必须是字符串' }, 400);
        cleanTags.semantic_description = new_tags.semantic_description.trim().slice(0, 300);
      }
      const cleanTagList = (v, maxCount, itemMaxLen) => {
        if (!Array.isArray(v)) return null;
        return v.map(s => String(s).trim().slice(0, itemMaxLen)).filter(Boolean).slice(0, maxCount);
      };
      if (new_tags.emotion !== undefined) {
        const list = cleanTagList(new_tags.emotion, 5, 30);
        if (list === null) return json({ ok: false, error: 'emotion 必须是数组' }, 400);
        cleanTags.emotion = list;
      }
      if (new_tags.scene !== undefined) {
        const list = cleanTagList(new_tags.scene, 8, 4);
        if (list === null) return json({ ok: false, error: 'scene 必须是数组' }, 400);
        cleanTags.scene = list;
      }
      if (new_tags.keywords !== undefined) {
        const list = cleanTagList(new_tags.keywords, 12, 30);
        if (list === null) return json({ ok: false, error: 'keywords 必须是数组' }, 400);
        cleanTags.keywords = list;
      }

      // 更新标签（保留原有字段，只覆盖 new_tags 里提供的）
      if (cleanTags.description !== undefined) sticker.description = cleanTags.description;
      if (cleanTags.semantic_description !== undefined) sticker.semantic_description = cleanTags.semantic_description;
      sticker.tags = sticker.tags || {};
      if (cleanTags.emotion !== undefined) sticker.tags.emotion = cleanTags.emotion;
      if (cleanTags.scene !== undefined) sticker.tags.scene = cleanTags.scene;
      if (cleanTags.keywords !== undefined) sticker.tags.keywords = cleanTags.keywords;
      sticker.tagged_at = new Date().toISOString();

      writeMeta(meta);

      // 清理 session
      if (session_id && chatSessions.has(session_id)) chatSessions.delete(session_id);

      // v0.26.0：用户改了名字/描述 → 记教学样本（异步，不影响确认响应）
      const afterKw = sticker.tags?.keywords || [];
      const afterDesc = sticker.description || '';
      if (JSON.stringify(before.keywords) !== JSON.stringify(afterKw) || before.description !== afterDesc) {
        upsertTeachingSample(sticker_id, { description: afterDesc, keywords: afterKw, semanticDescription: sticker.semantic_description || '' })
          .catch(() => {});
      }

      // 单图重算 embedding（基于新的 semantic_description）
      let vectorOk = false;
      let vectorError = null;
      if (sticker.semantic_description && sticker.semantic_description.trim()) {
        const embResult = await generateEmbeddings(sticker.semantic_description);
        if (embResult.ok && embResult.data[0]) {
          const vectorsData = readVectors();
          // v0.19.5 - 用解析后的真实 model/dimensions（schema 字段是 modelId，不能用 embCfg.model）
          const { model: currentModel, dimensions: currentDims } = resolveEmbeddingApi();
          if (vectorsData.model && currentModel && vectorsData.model !== currentModel) {
            vectorError = `向量模型已更换（${vectorsData.model} → ${currentModel}），请到「生成向量」里整体重算`;
            ctx?.log?.warn?.('[biaoqingbao] 单条重算被跳过:', vectorError);
          } else {
            if (!vectorsData.vectors) vectorsData.vectors = {};
            vectorsData.vectors[sticker_id] = embResult.data[0];
            vectorsData.generated_at = new Date().toISOString();
            // 确保 model/dimensions 有值
            if (!vectorsData.model) vectorsData.model = currentModel || '';
            if (!vectorsData.dimensions) vectorsData.dimensions = currentDims || 0;
            writeVectors(vectorsData);
            vectorOk = true;
          }
        } else {
          vectorError = embResult.error;
          ctx?.log?.warn?.('[biaoqingbao] 重算向量失败:', embResult.error);
        }
      } else {
        // v0.19.5 - 语义描述被清空时，删除该图旧向量，避免孤儿向量
        const vectorsData = readVectors();
        if (vectorsData.vectors && vectorsData.vectors[sticker_id]) {
          delete vectorsData.vectors[sticker_id];
          vectorsData.generated_at = new Date().toISOString();
          writeVectors(vectorsData);
          vectorOk = true;
        }
      }

      ctx?.log?.info?.(`[biaoqingbao] sticker ${sticker_id} 标签已修改（vector: ${vectorOk ? 'ok' : 'fail'})`);

      return json({
        ok: true,
        message: vectorOk ? '已修改，向量也重算了' : '已修改',
        vector_regenerated: vectorOk,
        vector_error: vectorOk ? null : vectorError,
        sticker: meta[idx],
      });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] confirm error:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ── POST /api/sticker/chat/close — 手动清理 session（关闭弹窗时调） ──
  app.post('/api/sticker/chat/close', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const sid = body?.session_id;
      if (sid && chatSessions.has(sid)) {
        chatSessions.delete(sid);
        return json({ ok: true, message: 'session 已清理' });
      }
      return json({ ok: true, message: '无需清理' });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.18.0 历史定位：根据 sticker_id 查找到那次发图所在的对话消息
  // 隐私安全：只返回拼接后的对话摘要，不返回原始字段
  // ════════════════════════════════════════════════════════════════

  // 新记录保存相对 HANA_HOME 的路径；旧版绝对路径继续兼容读取。
  function resolveLoggedSessionPath(storedPath) {
    if (!storedPath) return '';
    return path.isAbsolute(storedPath) ? storedPath : path.join(HANA_HOME, storedPath);
  }

  // 在 session jsonl 文件里按 context_ts 找最近的那条消息
  function findMessageNearTs(jsonlPath, targetTs, roleFilter = 'assistant') {
    try {
      if (!fs.existsSync(jsonlPath)) return null;
      const content = fs.readFileSync(jsonlPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      let best = null;
      let bestDiff = Infinity;
      const messages = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          // 尝试各种可能的时间戳字段
          const ts = obj.ts || obj.timestamp || obj.createdAt || obj.time;
          if (!ts) continue;
          const objTs = typeof ts === 'number' ? ts : new Date(ts).getTime();
          if (isNaN(objTs)) continue;
          messages.push({ ts: objTs, role: obj.role, content: obj.content });
        } catch {}
      }
      // 找时间最接近的、role 匹配的
      for (const m of messages) {
        if (m.role !== roleFilter) continue;
        const diff = Math.abs(m.ts - targetTs);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = m;
        }
      }
      if (!best) return null;

      // 找前后各 1 条作为上下文
      const idx = messages.findIndex(m => m.ts === best.ts && m.role === best.role);
      const before = idx > 0 ? messages[idx - 1] : null;
      const after = idx < messages.length - 1 ? messages[idx + 1] : null;

      return { before, target: best, after, diffMs: bestDiff };
    } catch (e) {
      return null;
    }
  }

  // 提取消息文本（处理 string / array content）
  function extractMessageText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter(p => p?.type === 'text')
        .map(p => p.text || '')
        .join('\n')
        .trim();
    }
    return '';
  }

  // ── GET /api/sticker/context?sticker_id=xxx ──
  app.get('/api/sticker/context', (c) => {
    try {
      const stickerId = c.req.query('sticker_id');
      if (!stickerId) return json({ ok: false, error: '缺少 sticker_id' }, 400);

      // 读 decision-log，找最近的 entry
      let logData;
      try {
        logData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'decision-log.json'), 'utf-8'));
      } catch {
        return json({ ok: false, error: 'decision-log 为空或不存在' }, 404);
      }

      const entries = (logData.entries || [])
        .filter(e => e.sticker_id === stickerId && e.session_path && e.context_ts)
        .sort((a, b) => (b.context_ts || 0) - (a.context_ts || 0));

      if (entries.length === 0) {
        return json({
          ok: true,
          data: {
            found: false,
            reason: '没找到带定位信息的发图记录（旧记录可能没有 session_path/context_ts）',
          },
        });
      }

      // 优先找最近的；如果文件不存在了再 fallback
      for (const entry of entries) {
        const sessionFile = resolveLoggedSessionPath(entry.session_path);
        if (!sessionFile || !fs.existsSync(sessionFile)) continue;
        const found = findMessageNearTs(sessionFile, entry.context_ts, 'assistant');
        if (!found) continue;

        const beforeText = found.before ? extractMessageText(found.before.content) : '';
        const targetText = extractMessageText(found.target.content);
        const afterText = found.after ? extractMessageText(found.after.content) : '';

        // 截断到合理长度（单条 200 字内）
        const trim = (s) => s.length > 200 ? s.slice(0, 200) + '…' : s;

        return json({
          ok: true,
          data: {
            found: true,
            sticker_id: stickerId,
            when: entry.ts,
            session_id: entry.session_id || null,
            context: {
              before: trim(beforeText),
              target: trim(targetText),
              after: trim(afterText),
            },
            diff_ms: found.diffMs,
          },
        });
      }

      return json({
        ok: true,
        data: {
          found: false,
          reason: 'session 文件已被清理或不可访问',
        },
      });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] context error:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ═══ GET /api/agents — 扫描可用助手列表 ═══
  app.get('/api/agents', (c) => {
    try {
      const agentsDir = path.join(HANA_HOME, 'agents');
      if (!fs.existsSync(agentsDir)) return json({ ok: true, data: [] });
      const dirs = fs.readdirSync(agentsDir, { withFileTypes: true });
      const agents = [];
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        // 从 config.yaml 读助手名
        let name = d.name;
        const yamlPath = path.join(agentsDir, d.name, 'config.yaml');
        if (fs.existsSync(yamlPath)) {
          try {
            const yaml = fs.readFileSync(yamlPath, 'utf-8');
            // 简单解析 yaml，找 agent: 下的 name:
            const lines = yaml.split('\n');
            let inAgent = false;
            for (const line of lines) {
              if (line.trim() === 'agent:') { inAgent = true; continue; }
              if (inAgent) {
                const m = line.match(/^\s+name:\s*['"]?([^'"\n]+)['"]?\s*$/);
                if (m) { name = m[1].trim(); break; }
                if (line.trim() !== '' && !line.startsWith('  ')) { inAgent = false; }
              }
            }
          } catch {}
        }
        agents.push({ id: d.name, name });
      }
      return json({ ok: true, data: agents });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  });

  // ═══ POST /api/agents/remove — 删除助手（v0.25.2）═══
  // 只清理该助手在插件里的数据（频率/偏好/方言/人格块），不写任何忽略名单：
  // 用户点「刷新列表」后所有助手（含刚删的）会重新出现，自由度交给用户。
  app.post('/api/agents/remove', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const agentId = body && String(body.agentId || '').trim();
      if (!agentId) return json({ ok: false, error: '缺少 agentId' }, 400);

      // 1) 配图频率设置
      const freq = readAgentFreqConfig();
      if (freq.agents && freq.agents[agentId]) {
        delete freq.agents[agentId];
        writeAgentFreqConfig(freq);
      }

      // 2) 偏好记录（喜欢/不喜欢/累计次数）
      try {
        const prefs = JSON.parse(fs.readFileSync(PREFERENCES_FILE, 'utf-8'));
        if (prefs.users && prefs.users[agentId]) {
          delete prefs.users[agentId];
          atomicWriteJson(PREFERENCES_FILE, prefs);
        }
      } catch {}

      // 3) 方言配置 + 人格文件里的方言块（有残留就一并清掉）
      const dcfg = readDialectConfig();
      if (dcfg.agents && dcfg.agents[agentId]) {
        try { removeDialectFromIshiki(agentId); } catch {}
        delete dcfg.agents[agentId];
        writeDialectConfig(dcfg);
      }

      // 4) 历史屏蔽名单
      try {
        const blocked = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf-8'));
        if (Array.isArray(blocked.blockedIds)) {
          const before = blocked.blockedIds.length;
          blocked.blockedIds = blocked.blockedIds.filter((x) => x !== agentId);
          if (blocked.blockedIds.length !== before) atomicWriteJson(BLOCKED_FILE, blocked);
        }
      } catch {}

      ctx?.log?.info?.('[biaoqingbao] 删除助手:', agentId);
      return json({ ok: true, message: `已删除助手「${agentId}」，其插件数据已清理（刷新列表后会重新出现）` });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 删除助手失败:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.17.0 助手配图频率控制（屏蔽助手的升级版）
  // ════════════════════════════════════════════════════════════════

  // 频率配置从 lib/shared.js 导入（readAgentFreqConfig, writeAgentFreqConfig）

  // ── GET /api/agent-freq - 读取配图频率配置 ──
  app.get('/api/agent-freq', (c) => {
    const config = readAgentFreqConfig();
    return json({ ok: true, data: config });
  });

  // ── POST /api/agent-freq - 校验并保存统一的 version 2 配置 ──
  app.post('/api/agent-freq', async (c) => {
    try {
      const body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ ok: false, error: '配置格式不正确' }, 400);
      }
      if (body.agents != null && (typeof body.agents !== 'object' || Array.isArray(body.agents))) {
        return json({ ok: false, error: '助手频率配置格式不正确' }, 400);
      }
      const saved = writeAgentFreqConfig(body);
      return json({ ok: true, message: '已保存', data: saved });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.20.0 方言口音（让助手说话带方言味）
  // ════════════════════════════════════════════════════════════════

  // ── GET /api/dialect - 读取方言配置 + 方言库元数据（纯读，自愈只发生在 POST 保存后）──
  app.get('/api/dialect', (c) => {
    const config = readDialectConfig();
    return json({
      ok: true,
      data: {
        config,
        dialects: DIALECT_LIST.map(d => ({ id: d.id, name: d.name, tagline: d.tagline, difficulty: d.difficulty, difficultyNote: d.difficultyNote, hasAdvanced: Boolean(d.personaAdvanced) })),
      },
    });
  });

  // ── POST /api/dialect - 保存方言配置（整表替换，归一化 + 同步写入/移除人格文件）──
  app.post('/api/dialect', async (c) => {
    try {
      const body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ ok: false, error: '配置格式不正确' }, 400);
      }
      if (body.agents != null && (typeof body.agents !== 'object' || Array.isArray(body.agents))) {
        return json({ ok: false, error: '助手方言配置格式不正确' }, 400);
      }
      const before = readDialectConfig();
      const saved = writeDialectConfig(body);
      // 记录变更（时间、从啥改成啥、变更了哪些助手），供排查用
      try {
        const changed = [];
        for (const [agentId, s] of Object.entries(saved.agents)) {
          const b = before.agents[agentId];
          if (!b || b.dialect !== s.dialect) changed.push({ agentId, from: (b && b.dialect) || '未配置', to: s.dialect });
        }
        for (const [agentId, b] of Object.entries(before.agents)) {
          if (!saved.agents[agentId]) changed.push({ agentId, from: b.dialect, to: '关闭' });
        }
        if (changed.length > 0) appendDialectLog({ changed, config: saved });
      } catch (e) {
        // 日志失败不影响保存主流程
      }
      // 同步写入/移除各助手的 ishiki.md（用户主动开启才写，关闭即删）
      // 传 before 作为旧配置：否则 sync 内部读到的缓存已是新配置，关闭的助手会被漏掉
      const syncResults = syncDialectToIshiki(saved, undefined, before);
      const failed = Object.entries(syncResults).filter(([_, r]) => r && r.ok === false);
      // 对配置里已开启方言的助手做二次自愈：sync 失败时再补一次，仍失败才报错
      const repaired = reconcileDialectToIshiki(saved);
      const stillFailed = failed.filter(([id]) => !repaired.fixed.includes(id));
      // v0.23.0：错误信息去本地路径（fs 原始报错可能带 ishiki.md 绝对路径，不进前端）
      const cleanErr = (msg) => String(msg || '')
        .replace(/[A-Za-z]:\\[^\s'";，。]*/g, '<path>')
        .replace(/\\\\[^\\\s]+\\[^\s'";，。]*/g, '<path>');
      const message = stillFailed.length
        ? `已保存，但 ${stillFailed.map(([id]) => id).join('、')} 的人格写入失败：${stillFailed.map(([_, r]) => cleanErr(r.error)).join('；')}（重启后不生效）`
        : '已保存。重启 Hana 后生效，建议开一个新对话框聊天（旧对话框里可能残留旧方言味道）';
      return json({
        ok: true,
        message,
        data: saved,
        syncFailed: stillFailed.map(([id, r]) => ({ agentId: id, error: cleanErr(r.error) })),
      });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  });

  // ── GET /api/dialect-log - 读取方言保存日志（最近 20 条，排查用）──
  app.get('/api/dialect-log', (c) => {
    return json({ ok: true, data: readDialectLog(20) });
  });

  // ── 兼容旧版 GET /api/blocked-agents（从全局开关读取）──
  app.get('/api/blocked-agents', (c) => {
    const config = readAgentFreqConfig();
    const blockedIds = Object.entries(config.agents || {})
      .filter(([_, settings]) => settings?.enabled === false)
      .map(([id]) => id);
    return json({ ok: true, data: blockedIds });
  });

  // 兼容旧版完整名单写法：{ blockedIds: ["agent-a", "agent-b"] }
  app.post('/api/blocked-agents', async (c) => {
    try {
      const body = await c.req.json();
      if (!body || !Array.isArray(body.blockedIds)) {
        return json({ ok: false, error: 'blockedIds 必须是数组' }, 400);
      }
      const blockedIds = [...new Set(body.blockedIds.filter(id =>
        typeof id === 'string' && id.trim() && !['__proto__', 'prototype', 'constructor'].includes(id)
      ))];
      const config = readAgentFreqConfig();
      for (const settings of Object.values(config.agents || {})) settings.enabled = true;
      for (const id of blockedIds) {
        const current = config.agents[id] || {
          enabled: true,
          daily: config.default_daily,
          task: config.default_task,
        };
        current.enabled = false;
        config.agents[id] = current;
      }
      const saved = writeAgentFreqConfig(config);
      return json({ ok: true, data: blockedIds.filter(id => saved.agents[id]?.enabled === false) });
    } catch (e) {
      return json({ ok: false, error: e.message });
    }
  });

  // ════════════════════════════════════════════════════════════════
  //  v0.16.0 Embedding 向量检索 API
  // ════════════════════════════════════════════════════════════════

  // ── GET /api/embedding-config - 读取 Embedding 配置 ──
  app.get('/api/embedding-config', (c) => {
    const cfg = readEmbeddingConfig();
    // 脱敏：不返回完整 API key
    const safe = { ...cfg };
    if (safe.customApiKey) safe.customApiKey = safe.customApiKey.substring(0, 8) + '***';
    return json({ ok: true, data: safe });
  });

  // ── POST /api/embedding-test - 测试 embedding 模型连通性 ──
  // v0.18.4 - 复用 vision/text 的「测试连通」模式
  app.post('/api/embedding-test', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const disk = readEmbeddingConfig();
      const cfg = (body && Object.keys(body).length > 0) ? { ...disk, ...body } : disk;
      // customApiKey 占位符还原为磁盘真值
      if (cfg.source === 'custom' && (!cfg.customApiKey || cfg.customApiKey === '********')) {
        cfg.customApiKey = disk.customApiKey || '';
      }

      const { baseUrl, apiKey, model } = resolveEmbeddingApi(cfg);
      if (!apiKey || !baseUrl || !model) {
        return json({ ok: false, error: '未配置 Embedding 模型（请检查 provider/key/model 是否完整）' }, 400);
      }

      // 发一条测试文本，验证 API 可调用 + 返回向量维度合理
      const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input: ['连接测试'] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return json({ ok: false, error: `HTTP ${resp.status}: ${t.substring(0, 200)}` });
      }
      const data = await resp.json();
      const vec = data.data?.[0]?.embedding;
      if (!vec || !Array.isArray(vec)) {
        return json({ ok: false, error: 'API 返回空向量或格式异常' });
      }
      return json({ ok: true, data: { dimensions: vec.length, model, source: cfg.source, provider: cfg.providerId || 'custom' } });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ── POST /api/embedding-config - 保存 Embedding 配置 ──
  // v0.18.0 - schema 对齐 vision/text：source='hana'/'custom'，modelId 而非 model
  app.post('/api/embedding-config', async (c) => {
    try {
      const body = await c.req.json();
      const oldCfg = readEmbeddingConfig();
      const cfg = {
        source: body.source || 'hana',
        providerId: body.providerId ?? oldCfg.providerId ?? '',
        modelId: body.modelId ?? body.model ?? oldCfg.modelId ?? '',
        dimensions: body.dimensions ?? oldCfg.dimensions ?? 1024,
        customBaseUrl: body.customBaseUrl ?? oldCfg.customBaseUrl ?? '',
        customApiKey: body.customApiKey ?? oldCfg.customApiKey ?? '',
        customModel: body.customModel ?? oldCfg.customModel ?? '',
        customDimensions: body.customDimensions ?? oldCfg.customDimensions ?? 1024,
      };
      writeEmbeddingConfig(cfg);
      return json({ ok: true, message: '配置已保存' });
    } catch (e) {
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ── POST /api/generate-embeddings - 批量生成向量 ──
  app.post('/api/generate-embeddings', async (c) => {
    try {
      const meta = readMeta();
      const body = await c.req.json().catch(() => ({}));
      const onlyMissing = body.onlyMissing !== false;
      const existing = readVectors();
      const existingVectors = existing.vectors || {};

      const { baseUrl, apiKey, model, dimensions } = resolveEmbeddingApi();
      if (!apiKey || !baseUrl || !model) {
        return json({ ok: false, error: '未配置 Embedding 模型' });
      }

      // 默认只处理有语义描述、但还没有当前模型向量的表情包
      // v0.19.5 - 无 model 字段的旧库视为「未知模型」，保守起见整体重算，避免新旧模型向量混库
      const hasVectors = Object.keys(existingVectors).length > 0;
      const modelChanged = Boolean(existing.model && existing.model !== model) || (hasVectors && !existing.model);
      const withDesc = meta.filter(s => s.semantic_description && s.semantic_description.trim())
        .filter(s => !onlyMissing || modelChanged || !existingVectors[s.id]);
      if (withDesc.length === 0) {
        return json({ ok: true, data: { total: 0, processed: 0, failed: 0, skipped: meta.length } });
      }

      // 分批调用（每批 20 条，避免单次请求太大）
      const BATCH_SIZE = 20;
      // v0.19.5 - 模型已更换时从空集合开始，旧模型向量不再残留，避免不同维度向量混库
      const vectors = modelChanged ? {} : { ...existingVectors };
      let processed = 0;
      let failed = 0;
      const errors = [];

      for (let i = 0; i < withDesc.length; i += BATCH_SIZE) {
        const batch = withDesc.slice(i, i + BATCH_SIZE);
        const texts = batch.map(s => s.semantic_description);
        const result = await generateEmbeddings(texts);
        if (!result.ok) {
          failed += batch.length;
          errors.push(`批次 ${i / BATCH_SIZE + 1}: ${result.error}`);
          continue;
        }
        for (let j = 0; j < batch.length; j++) {
          if (result.data[j]) {
            vectors[batch[j].id] = result.data[j];
            processed++;
          } else {
            failed++;
          }
        }
      }
      // v0.19.5 - 模型已更换且全部失败时，不写回（磁盘保持原状），提示用户重试
      if (modelChanged && processed === 0 && Object.keys(vectors).length === 0) {
        return json({ ok: true, data: { total: withDesc.length, processed: 0, failed: withDesc.length, errors, note: '模型已更换且本次生成全部失败，未写入任何新向量（旧库保持不变），请检查模型配置后重试' } });
      }

      const vectorsData = {
        version: 1,
        model,
        dimensions,
        generated_at: new Date().toISOString(),
        vectors,
      };
      writeVectors(vectorsData);

      return json({
        ok: true,
        data: {
          total: withDesc.length,
          processed,
          failed,
          errors: errors.length > 0 ? errors : undefined,
        },
      });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 生成向量失败:', e.message);
      return json({ ok: false, error: e.message }, 500);
    }
  });

  // ── GET /api/vector-status - 查看向量状态 ──
  app.get('/api/vector-status', (c) => {
    const meta = readMeta();
    const withSemanticDesc = meta.filter(s => s.semantic_description && s.semantic_description.trim());
    const v = readVectors();
    const vectorMap = v.vectors || {};
    const { baseUrl, apiKey, model } = resolveEmbeddingApi();
    const configured = Boolean(apiKey && baseUrl && model);
    const modelChanged = Boolean(v.model && model && v.model !== model);
    const pending = withSemanticDesc.filter(s => modelChanged || !vectorMap[s.id]).length;
    return json({
      ok: true,
      data: {
        totalStickers: meta.length,
        withSemanticDesc: withSemanticDesc.length,
        vectorCount: Object.keys(vectorMap).length,
        pending,
        configured,
        model: v.model || '',
        generated_at: v.generated_at || '',
        dimensions: v.dimensions || 0,
      },
    });
  });

  // v0.12.0 - 注册异步批量识图任务路由（独立模块，try/catch 防止注册失败影响主路由）
  // 修复：v0.14.x 接力修复时误删，导致 /api/batch-tasks 整组端点不响应，角标不显示
  try {
    registerBatchTasksRoutes(app, ctx);
  } catch (e) {
    ctx?.log?.error?.('[biaoqingbao] 批量任务路由注册失败:', e.message);
  }

  // ═══ GET /api/check-update — 检查 GitHub 更新（v0.19.5 分享版）═══
  app.get('/api/check-update', async (c) => {
    try {
      const manifestPath = path.join(__dirname, '..', 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const currentVersion = manifest.version || '0.1.0';
      const REPO = 'moononnn/hanako-biaoqingbao';

      // 获取最新 tag（只取一个，请求最小化）
      const resp = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=1`, {
        headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'biaoqingbao' },
        signal: AbortSignal.timeout(8000),
      });

      // 优雅降级：API 不可用不报错，提示暂时不可用，但仓库地址仍给出
      if (!resp.ok) {
        return json({
          ok: true, success: true, current: currentVersion, latest: null, hasUpdate: false,
          apiDown: true, // v0.19.5 - 标记：API 挂了，前端据此显示仓库地址
          message: 'GitHub API 暂时不可用（' + resp.status + '）',
          repoUrl: `https://github.com/${REPO}`,
        });
      }

      const tags = await resp.json();
      if (!tags || !Array.isArray(tags) || tags.length === 0) {
        return json({
          ok: true, success: true, current: currentVersion, latest: currentVersion, hasUpdate: false,
          message: '已是最新版本 ✨',
          repoUrl: `https://github.com/${REPO}`,
        });
      }

      const latestTag = tags[0].name.replace(/^v/, '');
      const hasUpdate = compareVersions(latestTag, currentVersion) > 0;

      // 有更新才拉 release 正文，失败不影响主流程
      let releaseBody = '';
      if (hasUpdate) {
        try {
          const releaseResp = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tags[0].name}`, {
            headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'biaoqingbao' },
            signal: AbortSignal.timeout(5000),
          });
          if (releaseResp.ok) {
            const release = await releaseResp.json();
            releaseBody = release.body || '';
          }
        } catch { /* release body 获取失败不影响主流程 */ }
      }

      return json({
        ok: true, success: true,
        current: currentVersion,
        latest: latestTag,
        hasUpdate,
        updateUrl: hasUpdate ? `https://github.com/${REPO}/releases/tag/${tags[0].name}` : null,
        downloadUrl: hasUpdate ? `https://github.com/${REPO}/archive/refs/tags/${tags[0].name}.zip` : null,
        repoUrl: `https://github.com/${REPO}`,
        releaseBody,
        message: hasUpdate
          ? `发现新版本 v${latestTag}！当前 v${currentVersion}`
          : '已是最新版本 ✨',
      });
    } catch (e) {
      ctx?.log?.error?.('[biaoqingbao] 检查更新失败:', e.message || e);
      return json({
        ok: false, success: false, error: e.message || '网络不可达',
        repoUrl: 'https://github.com/moononnn/hanako-biaoqingbao',
      });
    }
  });
}

// ─── 版本号比较（semver，兼容 2 段版本号） ───
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}
