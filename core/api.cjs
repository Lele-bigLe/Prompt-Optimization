'use strict';

const providers = ['deepseek', 'anthropic', 'openai-compatible'];
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function endpointFor(config, resource) {
  let url;
  try { url = new URL(config.apiBaseUrl); } catch { throw new Error('请填写有效的 API 地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('API 地址需要使用 HTTPS；本机服务可以使用 HTTP。');
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址中不要携带密钥或查询参数。');
  const suffix = config.provider === 'anthropic' ? 'messages' : 'chat/completions';
  const pathname = url.pathname.replace(/\/+$/, '');
  const root = pathname.endsWith('/' + suffix) ? pathname.slice(0, -(suffix.length + 1)) : pathname;
  url.pathname = root + '/' + (resource || suffix);
  return url.toString();
}

async function requestJson(config, key, { resource, query, body, signal, timeoutSeconds = config.timeoutSeconds ?? 90 } = {}) {
  if (!providers.includes(config.provider)) throw new Error('请选择一个 API 连接。');
  if (typeof key !== 'string' || !key.trim()) throw new Error('此连接还没有 API 密钥，请先填写或更换密钥。');
  const url = new URL(endpointFor(config, resource));
  if (query) for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
  if (config.provider === 'anthropic') headers['anthropic-version'] = '2026-10-21';
  const abort = new AbortController();
  const cancel = () => abort.abort();
  const timeout = setTimeout(cancel, Math.max(5, Math.min(300, timeoutSeconds)) * 1000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) abort.abort();
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', headers, body: body ? JSON.stringify(body) : undefined, signal: abort.signal });
    if (!response.ok) {
      await response.body?.cancel();
      const hint = { 400: '请求参数不被接受，请检查接口类型、模型和思考设置。', 401: '密钥可能无效或已过期。', 402: '服务返回支付或余额限制。', 403: '访问被拒绝，请检查账号和模型权限。', 404: '接口或模型未找到；模型列表不开放时可手动填写。', 429: '请求频率或额度受到限制，请稍后重试。' }[response.status] || (response.status >= 500 ? '模型服务暂时异常。' : '服务拒绝了此次请求。');
      throw new Error(`HTTP ${response.status}：${hint}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('API 返回内容过大，请检查服务地址或缩小模型列表。');
      chunks.push(chunk);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || data.error) throw new Error('接口返回了错误或无效数据，请检查服务商控制台。');
    return data;
  } catch (error) {
    if (abort.signal.aborted) throw new Error(signal?.aborted ? '已取消请求。' : '请求超时，请检查网络或增加等待时间。');
    if (error instanceof TypeError || error instanceof SyntaxError) throw new Error('连接失败或返回格式不正确，请检查网络、代理和 API 地址。');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
}

function modelInfo(item, provider) {
  const capabilities = item.capabilities;
  let levels;
  let thinkingTypes = [];
  let supportsImages = null;
  if (provider === 'anthropic' && capabilities) {
    levels = capabilities.effort ? efforts.filter(level => capabilities.effort[level]?.supported === true) : undefined;
    thinkingTypes = Object.entries(capabilities.thinking?.types || {}).filter(([, value]) => value?.supported === true).map(([name]) => name);
    if (thinkingTypes.includes('disabled')) levels = ['none', ...(levels || [])];
    if (typeof capabilities.image_input?.supported === 'boolean') supportsImages = capabilities.image_input.supported;
  } else if (provider === 'deepseek') {
    if (Array.isArray(item.effort?.supported_levels)) levels = ['none', ...item.effort.supported_levels.filter(level => efforts.includes(level))];
    if (Array.isArray(item.input_modalities)) supportsImages = item.input_modalities.includes('image');
  }
  return { id: item.id, name: String(item.display_name || item.name || item.id).slice(0, 200), levels: levels ? [...new Set(levels)] : null, supportsImages, thinkingTypes };
}

async function listModels(config, key, signal) {
  const models = new Map();
  let cursor;
  for (let page = 0; page < 10; page++) {
    const query = config.provider === 'anthropic' ? { limit: '1000', ...(cursor ? { after_id: cursor } : {}) } : undefined;
    const data = await requestJson(config, key, { resource: 'models', query, signal, timeoutSeconds: 30 });
    if (!Array.isArray(data.data)) throw new Error('服务没有返回标准模型列表，可手动填写模型 ID。');
    for (const item of data.data) {
      if (item && typeof item.id === 'string' && item.id.trim() && item.id.length <= 200) models.set(item.id, modelInfo(item, config.provider));
      if (models.size > 10000) throw new Error('模型列表过大，请直接填写所需模型 ID。');
    }
    if (!data.has_more) return [...models.values()];
    if (config.provider !== 'anthropic' || typeof data.last_id !== 'string' || data.last_id === cursor) throw new Error('此服务的模型分页方式尚未支持，请手动填写模型 ID。');
    cursor = data.last_id;
  }
  throw new Error('模型列表页数过多，请手动填写所需模型 ID。');
}

function applyReasoning(body, config) {
  const effort = config.reasoningEffort || 'auto';
  if (effort !== 'auto' && !efforts.includes(effort)) throw new Error('思考档位不正确，请重新选择。');
  const metadata = config.modelMetadata;
  if (metadata?.id === config.model && Array.isArray(metadata.levels) && effort !== 'auto' && !metadata.levels.includes(effort)) throw new Error('当前模型目录不支持这个思考档位，请重新选择。');
  if (config.provider === 'deepseek') {
    // 保留旧版本默认的快速改写方式；明确选择档位后才开启思考。
    body.thinking = { type: ['auto', 'none'].includes(effort) ? 'disabled' : 'enabled' };
    if (!['auto', 'none'].includes(effort)) body.reasoning_effort = effort;
  } else if (effort !== 'auto' && config.provider === 'anthropic') {
    if (effort === 'none') body.thinking = { type: 'disabled' };
    else {
      if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Claude API 不接受这个思考档位。');
      body.output_config = { effort };
      if (metadata?.thinkingTypes?.includes('adaptive')) body.thinking = { type: 'adaptive' };
    }
  } else if (effort !== 'auto') body.reasoning_effort = effort;
}

async function completion(input, config, key, signal, maxTokens = 8192, session) {
  if (!config.model?.trim()) throw new Error('请先选择或填写模型 ID。');
  const images = input.images || [];
  let body;
  if (config.provider === 'anthropic') {
    const content = images.flatMap((image, index) => {
      const separator = image.indexOf(',');
      return [{ type: 'text', text: `图片 ${index + 1}` }, { type: 'image', source: { type: 'base64', media_type: image.slice(5, image.indexOf(';')), data: image.slice(separator + 1) } }];
    });
    content.push({ type: 'text', text: input.text });
    body = { model: config.model, max_tokens: maxTokens, system: [{ type: 'text', text: input.system }], messages: [{ role: 'user', content }] };
  } else {
    const content = images.map(image => ({ type: 'image_url', image_url: { url: image } }));
    content.push({ type: 'text', text: input.text });
    body = { model: config.model, messages: [{ role: 'system', content: input.system }, { role: 'user', content: images.length ? content : input.text }] };
    body[config.provider === 'openai-compatible' && config.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'] = maxTokens;
  }
  const sessionReused = Boolean(session?.messages);
  if (sessionReused) {
    const content = config.provider === 'anthropic' ? [{ type:'text', text:input.revisionText }] : input.revisionText;
    if (!input.revisionText) throw new Error('缺少继续优化的修改要求，请重新优化。');
    body.messages = [...session.messages, { role:'user', content }];
  }
  applyReasoning(body, config);
  const started = performance.now();
  const data = await requestJson(config, key, { body, signal });
  if (config.provider === 'anthropic' ? !Array.isArray(data.content) : !data.choices?.[0]?.message) throw new Error('模型返回格式不正确，不能确认调用结果。');
  const text = config.provider === 'anthropic' ? data.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : data.choices[0].message.content;
  const truncated = config.provider === 'anthropic' ? data.stop_reason === 'max_tokens' : data.choices?.[0]?.finish_reason === 'length';
  if (session && !truncated && typeof text === 'string' && text.trim() && text.length <= 100000) {
    // Claude 的思考块及签名须原样保留，不能重排或只取正文后继续同一会话。
    const assistant = { role:'assistant', content:config.provider === 'anthropic' ? data.content : text };
    session.messages = [...body.messages, assistant];
  }
  return { text, truncated, sessionReused, model: config.model, modelMs: Math.round(performance.now() - started) };
}

function balanceSupported(config) {
  const url = new URL(endpointFor(config, 'user/balance'));
  return config.provider === 'deepseek' && url.origin === 'https://api.deepseek.com' && ['/user/balance', '/v1/user/balance'].includes(url.pathname);
}

async function getBalance(config, key, signal) {
  if (!balanceSupported(config)) throw new Error('暂不支持此服务的余额查询；目前仅接入 DeepSeek 官方余额接口。');
  const data = await requestJson({ ...config, apiBaseUrl: 'https://api.deepseek.com' }, key, { resource: 'user/balance', signal, timeoutSeconds: 20 });
  if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos) || !data.balance_infos.length || data.balance_infos.some(item => !item || !['CNY', 'USD'].includes(item.currency) || typeof item.total_balance !== 'string' || !/^-?\d+(\.\d+)?$/.test(item.total_balance))) throw new Error('服务返回的余额格式无法识别。');
  return { available: data.is_available, balances: data.balance_infos.map(item => ({ currency: item.currency, total: item.total_balance })), checkedAt: new Date().toISOString() };
}

module.exports = { providers, efforts, endpointFor, listModels, completion, getBalance };
