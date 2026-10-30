'use strict';

const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { env: clientEnvironment } = require('node:process');
const { LineProcess } = require('./line-process.cjs');
const { prepareInput } = require('./optimizer.cjs');
let catalogCache;

function clientArgs() {
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--tools', '', '--disable-slash-commands',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'user',
    '--settings', '{"disableAllHooks":true}',
  ];
}

async function claudeModels(executable, cwd, refresh = false, signal) {
  if (signal?.aborted) throw new Error('已取消优化。');
  if (!refresh && catalogCache?.executable === executable && Date.now() - catalogCache.createdAt < 300000) return catalogCache.models;
  await fs.mkdir(cwd, { recursive: true });
  const process = new LineProcess(executable, clientArgs(), cwd, 'Claude Code');
  const requestId = randomUUID();
  let timer;
  const cancel = () => process.stop();
  try {
    const initialized = new Promise((resolve, reject) => {
      process.on('message', message => {
        if (message.type !== 'control_response' || message.response?.request_id !== requestId) return;
        if (message.response.subtype !== 'success') reject(new Error('Claude Code 无法提供模型能力，请检查客户端版本和登录状态。'));
        else resolve(message.response.response);
      });
      process.on('fault', reject);
      process.on('close', () => reject(new Error('Claude Code 在返回模型能力前已退出。')));
      timer = setTimeout(() => reject(new Error('读取 Claude Code 模型能力超时，请稍后重试。')), 20000);
    });
    // 只初始化客户端，不发送 user 消息，不发起模型推理。
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else process.send({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } });
    const response = await initialized;
    if (!Array.isArray(response?.models)) throw new Error('Claude Code 没有返回模型目录。');
    const models = response.models.map(model => ({ value: model.value, resolvedModel: model.resolvedModel, displayName: model.displayName, description: model.description,
      supportsEffort: model.supportsEffort === true, supportedEffortLevels: model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [],
    }));
    catalogCache = { executable, models, createdAt: Date.now() };
    return models;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); process.stop(); }
}

async function claudeAccount(executable, cwd) {
  await fs.mkdir(cwd, { recursive: true });
  return new Promise((resolve, reject) => {
    execFile(executable, ['auth', 'status', '--json'], { cwd, windowsHide: true, timeout: 15000, maxBuffer: 65536 }, (error, stdout) => {
      try {
        const status = JSON.parse(stdout);
        if (!status.loggedIn) throw new Error('请先执行 claude auth login，或配置 Claude Code 当前环境的登录方式。');
        resolve({ account: status.authMethod === 'oauth_token' ? 'Claude Code 已登录账号' : 'Claude Code 当前认证环境' });
      } catch (parseError) { reject(error ? new Error('无法读取 Claude Code 登录状态，请先在 Claude Code 中完成登录。') : parseError); }
    });
  });
}

async function optimizeClaude(executable, cwd, input, config, signal) {
  const prepared = prepareInput(input, config);
  if (signal?.aborted) throw new Error('已取消优化。');
  await fs.mkdir(cwd, { recursive: true });
  const started = performance.now();
  const args = [...clientArgs(), '--system-prompt', prepared.system];
  if (config.model) args.push('--model', config.model);
  const selectedEffort = config.reasoningEffort && config.reasoningEffort !== 'auto' ? config.reasoningEffort : null;
  if (selectedEffort) {
    const models = await claudeModels(executable, cwd, false, signal);
    const model = models.find(item => item.value === config.model) ?? models.find(item => item.resolvedModel === config.model);
    if (!config.model || !model?.supportedEffortLevels.includes(selectedEffort)) throw new Error('这个模型未提供所选思考程度，请在优化器设置中重新选择。');
    args.push('--effort', selectedEffort);
  }
  if (signal?.aborted) throw new Error('已取消优化。');
  const process = new LineProcess(executable, args, cwd, 'Claude Code', selectedEffort ? { ...clientEnvironment, CLAUDE_CODE_EFFORT_LEVEL: selectedEffort } : undefined);
  let result;
  let timer;
  const cancel = () => process.stop();
  try {
    const completed = new Promise((resolve, reject) => {
      process.on('message', message => {
        if (message.type !== 'result') return;
        result = message;
        if (message.is_error || message.subtype !== 'success') reject(new Error('Claude Code 未完成优化，请检查登录、模型权限或剩余额度。'));
        else resolve(message);
      });
      process.on('fault', reject);
      process.on('close', code => {
        if (signal?.aborted) reject(new Error('已取消优化。'));
        else if (code !== 0 || result?.is_error || result?.subtype !== 'success') reject(new Error('Claude Code 未完成优化，请检查登录、模型权限或剩余额度。'));
        else resolve(result);
      });
      timer = setTimeout(() => { process.stop(); reject(new Error('Claude Code 优化超时。')); }, config.timeoutSeconds * 1000);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else {
      const content = prepared.images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.slice(5, image.indexOf(';')), data: image.slice(image.indexOf(',') + 1) } }));
      content.push({ type: 'text', text: prepared.text });
      process.send({ type: 'user', message: { role: 'user', content } });
      process.child.stdin.end();
    }
    const response = await completed;
    if (typeof response.result !== 'string' || !response.result.trim() || response.result.length > 100000) throw new Error('Claude Code 未返回完整可用的优化文本。');
    return { text: response.result.trim(), model: Object.keys(response.modelUsage ?? {})[0] || config.model || 'Claude Code 当前模型', modelMs: Math.round(performance.now() - started) };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); process.stop(); }
}

module.exports = { claudeAccount, claudeModels, optimizeClaude };
