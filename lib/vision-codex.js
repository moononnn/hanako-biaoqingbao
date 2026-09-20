// Codex Responses 视觉请求的纯协议适配。
// 凭据由调用方通过 Hana provider:credentials 获取，本文件不读盘、不保存凭据。

export function isCodexVisionProvider(providerId, api) {
  return String(api || '').trim() === 'openai-codex-responses'
    || String(providerId || '').trim() === 'openai-codex'
    || String(providerId || '').trim() === 'openai-codex-oauth';
}

export function codexCredentialProviderId(providerId) {
  return String(providerId || '').trim() === 'openai-codex' ? 'openai-codex-oauth' : String(providerId || '').trim();
}

export function codexEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (/\/codex\/responses$/i.test(base)) return base;
  if (/\/codex$/i.test(base)) return `${base}/responses`;
  return `${base}/codex/responses`;
}

export function codexContent(content) {
  const parts = Array.isArray(content) ? content : [{ type: 'text', text: String(content || '') }];
  return parts.flatMap((part) => {
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'text') return [{ type: 'input_text', text: String(part.text || '') }];
    if (part.type === 'image_url' && part.image_url?.url) {
      return [{ type: 'input_image', image_url: String(part.image_url.url) }];
    }
    return [];
  });
}

export function buildCodexRequest({ baseUrl, apiKey, accountId, headers = {}, model, messages, maxTokens = 1200, temperature }) {
  const endpoint = codexEndpoint(baseUrl);
  const account = String(accountId || headers['chatgpt-account-id'] || headers['ChatGPT-Account-ID'] || '').trim();
  if (!endpoint) throw new Error('Codex 模型未配置 API 地址');
  if (!apiKey) throw new Error('Codex OAuth 凭据不可用，请先登录 OpenAI Codex');
  if (!account) throw new Error('Codex OAuth 缺少账号标识，请重新登录 OpenAI Codex');
  const input = (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    content: codexContent(message?.content),
  }));
  return {
    url: endpoint,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      'OpenAI-Beta': 'responses=experimental',
      originator: 'pi',
      'chatgpt-account-id': account,
      Authorization: `Bearer ${apiKey}`,
    },
    body: {
      model,
      store: false,
      stream: true,
      // 当前 chatgpt.com Codex 端点拒绝 max_output_tokens/temperature；识图结果由插件侧截断。
      instructions: '请严格按照用户要求输出，不要输出思考过程。',
      input,
    },
  };
}

function textFromOutput(output) {
  if (!Array.isArray(output)) return '';
  return output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' || part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('');
}

export function parseCodexResponse(raw) {
  const text = String(raw || '');
  let result = '';
  let completed = null;
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .find((line) => line.startsWith('data:'))
      ?.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'response.output_text.delta') result += String(event.delta || '');
    if (event.type === 'response.output_text.done' && !result) result = String(event.text || '');
    if (event.type === 'response.completed') completed = event.response || event;
  }
  if (!result && completed) result = String(completed.output_text || '') || textFromOutput(completed.output);
  if (!result) {
    try {
      const json = JSON.parse(text);
      result = String(json.output_text || '') || textFromOutput(json.output);
    } catch {}
  }
  return result.trim();
}
