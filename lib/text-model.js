// lib/text-model.js - 表情包内容分析模型的选定模型直连适配
//
// Hana 的 utility:call-text 只解析全局 utility 角色，不读取插件请求里的
// providerId/modelId。学我说话的配置则允许用户在插件内选择模型，所以这里
// 用 Hana 已保存的 provider 凭据直连该选定模型，并显式关闭思考模式。
// 这样“设置里选了谁”和“实际调用了谁”保持同一条链路。

import fs from 'node:fs';

import { MODELS_JSON, getProviderApiConfig } from './shared.js';

export const EMPTY_TEXT_RESPONSE = '模型未回复正文，请检查思考内容或稍后重试。';

function trimSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isPlaceholderKey(value) {
  return !value || String(value).startsWith('hana-runtime-api-key:') || value === 'local';
}

function normalizeApi(value) {
  return String(value || '').trim().toLowerCase();
}

function isDeepSeekModel(model) {
  return model?.providerId === 'deepseek' || /deepseek/i.test(String(model?.modelId || ''));
}

function readCatalog(modelsPath = MODELS_JSON) {
  const raw = fs.readFileSync(modelsPath, 'utf8');
  const catalog = JSON.parse(raw);
  if (!catalog || typeof catalog !== 'object' || !catalog.providers || typeof catalog.providers !== 'object') {
    throw new Error('Hana 模型目录格式无效');
  }
  return catalog;
}

// 从 models.json 解析插件选择的模型。这里不读取任何密钥。
export function readTextModelDefinition(providerId, modelId, modelsPath = MODELS_JSON) {
  const pid = String(providerId || '').trim();
  const mid = String(modelId || '').trim();
  if (!pid || !mid) throw new Error('未选择内容分析模型');

  let catalog;
  try {
    catalog = readCatalog(modelsPath);
  } catch (error) {
    throw new Error(`读取 Hana 模型目录失败: ${error.message}`);
  }

  const provider = catalog.providers[pid];
  if (!provider || typeof provider !== 'object') {
    throw new Error(`Hana 模型供应商不存在: ${pid}`);
  }
  const modelEntry = (Array.isArray(provider.models) ? provider.models : [])
    .find((item) => (typeof item === 'string' ? item : item?.id) === mid);
  if (!modelEntry) throw new Error(`Hana 模型不存在: ${pid}/${mid}`);

  const model = typeof modelEntry === 'object' ? modelEntry : { id: modelEntry };
  const api = normalizeApi(model.api || provider.api || 'openai-completions');
  return {
    providerId: pid,
    modelId: mid,
    api,
    baseUrl: provider.baseUrl || provider.base_url || '',
    reasoning: model.reasoning === true,
    provider,
    model,
  };
}

// 合并 Hana 运行时凭据。provider:credentials 取不到时，兼容旧版本地凭据目录。
export async function resolveConfiguredTextModel(ctx, providerId, modelId, modelsPath = MODELS_JSON) {
  const definition = readTextModelDefinition(providerId, modelId, modelsPath);
  let runtime = {};
  try {
    const result = await ctx?.bus?.request?.('provider:credentials', { providerId: definition.providerId });
    if (result && typeof result === 'object') runtime = result;
  } catch {
    // 本地 provider-catalog 仍是可用的只读兜底。
  }

  const stored = getProviderApiConfig(definition.providerId);
  const baseUrl = runtime.baseUrl || runtime.base_url || stored.baseUrl || definition.baseUrl;
  const apiKey = runtime.apiKey || runtime.api_key || stored.apiKey || '';
  const runtimeHeaders = runtime.headers && typeof runtime.headers === 'object' ? runtime.headers : {};
  if (!baseUrl) throw new Error(`模型供应商未配置 API 地址: ${definition.providerId}`);

  return {
    ...definition,
    baseUrl: trimSlashes(baseUrl),
    apiKey,
    headers: runtimeHeaders,
  };
}

export function buildTextEndpoint(baseUrl, api) {
  const base = trimSlashes(baseUrl);
  if (!base) throw new Error('模型供应商未配置 API 地址');
  const kind = normalizeApi(api);

  if (kind === 'openai-responses') {
    return /\/responses$/i.test(base) ? base : `${base}/responses`;
  }
  if (kind === 'openai-completions') {
    if (/\/chat\/completions$/i.test(base)) return base;
    return /\/v1$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  }
  if (kind === 'anthropic-messages') {
    if (/\/messages$/i.test(base)) return base;
    return /\/v1$/i.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  }
  throw new Error(`当前模型接口暂不支持直连: ${api}`);
}

function normalizeMaxTokens(value, fallback = 800) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function normalizeTemperature(value) {
  return Number.isFinite(value) ? value : undefined;
}

// 构造请求体，纯函数便于测试不同接口和思考开关。
export function buildTextRequest(model, messages, options = {}) {
  const api = normalizeApi(model?.api);
  const maxTokens = normalizeMaxTokens(options.maxTokens);
  const temperature = normalizeTemperature(options.temperature);
  const disableReasoning = options.disableReasoning !== false;
  const input = Array.isArray(messages) ? messages : [];
  const headers = {
    'Content-Type': 'application/json',
    ...(model?.headers && typeof model.headers === 'object' ? model.headers : {}),
  };
  if (!isPlaceholderKey(model?.apiKey)) headers.Authorization = `Bearer ${model.apiKey}`;

  if (api === 'openai-responses') {
    const body = {
      model: model.modelId,
      input,
      max_output_tokens: maxTokens,
      stream: false,
    };
    if (temperature !== undefined) body.temperature = temperature;
    // DeepSeek Responses API 的 none 明确表示关闭思考；对其他兼容 Responses
    // 供应商也使用同一标准字段，若模型不支持通常会按供应商兼容规则忽略。
    if (disableReasoning && model?.reasoning) body.reasoning = { effort: 'none' };
    return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
  }

  if (api === 'openai-completions') {
    const body = {
      model: model.modelId,
      messages: input,
      max_tokens: maxTokens,
      stream: false,
    };
    if (temperature !== undefined) body.temperature = temperature;
    // DeepSeek Chat Completions 的 thinking 开关要放在请求顶层（SDK 的
    // extra_body 在原始 HTTP 中就是同级字段）。只对 DeepSeek 发送，避免
    // 把供应商私有参数污染到其他 OpenAI 兼容接口。
    if (disableReasoning && model?.reasoning && isDeepSeekModel(model)) {
      body.thinking = { type: 'disabled' };
    }
    return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
  }

  if (api === 'anthropic-messages') {
    const system = input
      .filter((message) => message?.role === 'system')
      .map((message) => String(message.content || ''))
      .filter(Boolean)
      .join('\n\n');
    const chatMessages = input
      .filter((message) => message?.role !== 'system')
      .map((message) => ({ role: message?.role === 'assistant' ? 'assistant' : 'user', content: message?.content ?? '' }));
    const body = {
      model: model.modelId,
      messages: chatMessages,
      max_tokens: maxTokens,
      stream: false,
    };
    if (system) body.system = system;
    if (temperature !== undefined) body.temperature = temperature;
    return { url: buildTextEndpoint(model.baseUrl, api), headers, body };
  }

  throw new Error(`当前模型接口暂不支持直连: ${model.api}`);
}

function contentText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    if (part.type && /reasoning|thinking/i.test(String(part.type))) return '';
    return typeof part.text === 'string' ? part.text : '';
  }).join('');
}

// 可见输出清洗：模型偶尔把隐藏思考块塞进 content，不能让它进入模板。
export function stripHiddenThinking(value) {
  let text = String(value || '');
  for (const tag of ['think', 'analysis', 'reasoning', 'thinking', 'pulse']) {
    text = text
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '')
      .replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'gi'), '')
      .replace(new RegExp(`</${tag}>`, 'gi'), '');
  }
  return text.trim();
}

export function extractTextResponse(payload, api) {
  if (!payload || typeof payload !== 'object') return '';
  const kind = normalizeApi(api);
  if (kind === 'openai-responses') {
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return stripHiddenThinking(payload.output_text);
    }
    const parts = [];
    for (const item of Array.isArray(payload.output) ? payload.output : []) {
      if (item?.type !== 'message') continue;
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (part?.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      }
    }
    return stripHiddenThinking(parts.join(''));
  }
  if (kind === 'openai-completions') {
    const message = payload.choices?.[0]?.message;
    return stripHiddenThinking(contentText(message?.content));
  }
  if (kind === 'anthropic-messages') {
    return stripHiddenThinking(contentText(payload.content));
  }
  return '';
}

export async function callConfiguredTextModel(ctx, config, messages, options = {}) {
  let model;
  let request;
  try {
    model = await resolveConfiguredTextModel(
      ctx,
      config?.providerId,
      config?.modelId,
      options.modelsPath || MODELS_JSON,
    );
    request = buildTextRequest(model, messages, options);
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
  const timeoutMs = normalizeMaxTokens(options.timeoutMs, 120000);
  const controller = new AbortController();
  const externalSignal = options.signal;
  const abortExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener?.('abort', abortExternal, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) {
      throw new Error(`模型 HTTP ${response.status}: ${raw.slice(0, 300)}`);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('模型响应不是合法 JSON');
    }
    const text = extractTextResponse(payload, model.api);
    if (!text) {
      const error = new Error(EMPTY_TEXT_RESPONSE);
      error.code = 'LLM_EMPTY_RESPONSE';
      throw error;
    }
    return { ok: true, data: text, model: { providerId: model.providerId, modelId: model.modelId, api: model.api } };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      return { ok: false, error: `模型请求超时（${timeoutMs}ms）` };
    }
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener?.('abort', abortExternal);
  }
}
