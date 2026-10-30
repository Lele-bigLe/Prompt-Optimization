'use strict';

const vscode = require('vscode');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { optimize, endpointFor } = require('../core/optimizer.cjs');
const { CodexAgent } = require('../core/codex.cjs');
const { claudeAccount, claudeModels, optimizeClaude } = require('../core/claude.cjs');
const { createSettings } = require('./settings.cjs');
const { enableBridge, disableBridge } = require('./patch.cjs');

const prefix = 'codexPromptOptimizer';
const active = new Map();
const pendingHistory = new Map();
let historyWrite = Promise.resolve();
const composers = new Map();
let activeComposer;
let statusBar;
let settingsButton;
let openSettings;
let codexAgent;
const effortLabels = { auto: '按模型默认', none: '不额外思考', minimal: '少量思考', low: '简单思考', medium: '适中思考', high: '深入思考', xhigh: '更深入思考', max: '最高强度思考' };
const sourceLabels = { choose: '还没选择 AI', codex: '已登录的 Codex', claude: '已登录的 Claude Code', deepseek: 'DeepSeek', anthropic: 'Claude API', 'openai-compatible': '自定义 API' };

async function executableFor(kind) {
  const config = vscode.workspace.getConfiguration(prefix);
  const override = config.get(`${kind}Executable`);
  const codexExtension = vscode.extensions.getExtension('openai.chatgpt');
  const filename = process.platform === 'win32' ? `${kind}.exe` : kind;
  const candidates = override ? [override] : [
    ...(kind === 'codex' ? [vscode.workspace.getConfiguration('chatgpt').get('cliExecutable'), codexExtension && path.join(codexExtension.extensionPath, 'bin', 'windows-x86_64', 'codex.exe')] : []),
    path.join(os.homedir(), '.local', 'bin', filename),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, filename)),
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch {}
  }
  throw new Error(`未找到 ${kind === 'codex' ? 'Codex' : 'Claude Code'}。请安装对应官方客户端，或在扩展设置中指定可执行文件路径。`);
}

async function getCodex(context) {
  const executable = await executableFor('codex');
  if (!codexAgent || codexAgent.executable !== executable) {
    codexAgent?.dispose();
    codexAgent = new CodexAgent(executable, path.join(context.globalStorageUri.fsPath, 'codex-workspace'));
  }
  return codexAgent;
}

async function readLocalImage(localPath, hostId) {
  if (hostId !== 'local') throw new Error('远程会话的本地图片尚未接通，请先使用文本优化或附加本机图片。');
  if (typeof localPath !== 'string' || !path.isAbsolute(localPath) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\])/i.test(localPath))) {
    throw new Error('当前图片不是可读取的本机绝对路径。');
  }
  if (!/\.(png|jpe?g|gif|webp)$/i.test(localPath)) throw new Error('只支持 PNG、JPEG、GIF 或 WebP 图片。');
  const handle = await fs.open(localPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) throw new Error('图片不是普通文件或超过 5 MB。');
    // 使用文件头判断格式，不依赖文件扩展名读取其他类型的内容。
    const buffer = Buffer.alloc(stat.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const chunk = await handle.read(buffer, read, buffer.length - read, null);
      if (!chunk.bytesRead) break;
      read += chunk.bytesRead;
    }
    if (read !== stat.size) throw new Error('图片文件在读取期间发生变化，请重试。');
    const bytes = buffer.subarray(0, read);
    let type;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) type = 'jpeg';
    else if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) type = 'gif';
    else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') type = 'webp';
    if (!type || bytes.length > 5 * 1024 * 1024) throw new Error('图片格式不正确或文件大小发生变化。');
    return `data:image/${type};base64,${bytes.toString('base64')}`;
  } finally { await handle.close(); }
}

function settings() {
  const config = vscode.workspace.getConfiguration(prefix);
  const values = Object.fromEntries([
    'provider', 'apiBaseUrl', 'model', 'contextEnabled', 'includeImages', 'supportsImages',
    'maxContextChars', 'recentTurns', 'timeoutSeconds', 'historyEnabled',
    'uiMode', 'codexExecutable', 'claudeExecutable',
    'reasoningEffort', 'autoApply',
  ].map(key => [key, config.get(key)]));
  for (const key of ['contextEnabled', 'includeImages', 'supportsImages', 'historyEnabled', 'autoApply']) values[key] = values[key] === true;
  if (typeof values.reasoningEffort !== 'string' || !values.reasoningEffort) values.reasoningEffort = 'auto';
  for (const [key, minimum, maximum, fallback] of [['maxContextChars', 1000, 100000, 24000], ['recentTurns', 1, 30, 8], ['timeoutSeconds', 5, 300, 90]]) {
    values[key] = Number.isFinite(values[key]) ? Math.max(minimum, Math.min(maximum, Math.floor(values[key]))) : fallback;
  }
  return values;
}

function configId(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function secretId(config) {
  return `${prefix}.key.${createHash('sha256').update(`${config.provider}|${endpointFor(config)}`).digest('hex')}`;
}

async function configure(context) {
  const current = settings();
  const source = await vscode.window.showQuickPick([
    { label: '$(account) 使用已登录的 Codex', value: 'codex', description: '沿用 Codex 的账号，不用再填密钥' },
    { label: '$(account) 使用已登录的 Claude Code', value: 'claude', description: '沿用 Claude Code 的账号和模型服务' },
    { label: '$(key) 使用自己的模型服务（API）', value: 'api', description: '例如 DeepSeek，需填写服务地址和密钥' },
  ], { title: '让哪个 AI 帮你优化提示词？', ignoreFocusOut: true });
  if (!source) return;
  const next = { ...current, provider: source.value };
  let key;
  let selectedModel;
  if (source.value === 'codex') {
    const catalog = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '读取 Codex 当前账号和模型目录' }, async () => (await getCodex(context)).catalog());
    const selected = await vscode.window.showQuickPick(catalog.models.map(model => ({
      label: model.displayName || model.model, description: model.model,
      detail: `${catalog.account}${model.model === catalog.configuredModel ? ' · 当前环境模型' : ''}${model.inputModalities?.includes('image') ? ' · 支持图片' : ''}`, model,
    })), { title: '选择 Codex 提供的模型', ignoreFocusOut: true, matchOnDescription: true });
    if (!selected) return;
    next.model = selected.model.model;
    selectedModel = selected.model;
    next.supportsImages = selected.model.inputModalities?.includes('image') === true;
  } else if (source.value === 'claude') {
    const executable = await executableFor('claude');
    const cwd = path.join(context.globalStorageUri.fsPath, 'claude-workspace');
    const models = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '读取 Claude Code 的账号和模型能力' }, async () => {
      await claudeAccount(executable, cwd);
      return claudeModels(executable, cwd, true);
    });
    const selected = await vscode.window.showQuickPick([
      { label: '跟随 Claude Code 当前模型', value: '', description: '保留当前账号、环境变量和用户配置的选择' },
      ...models.map(model => ({ label: model.displayName || model.value, value: model.value, description: model.resolvedModel || model.value, model })),
      { label: '手动指定模型 ID', value: null },
    ], { title: '选择 Claude Code 模型（以账号实际权限为准）', ignoreFocusOut: true });
    if (!selected) return;
    next.model = selected.value;
    selectedModel = selected.model;
    if (next.model === null) {
      next.model = await vscode.window.showInputBox({ title: 'Claude Code 模型 ID', ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : '请填写模型 ID。' });
      if (!next.model) return;
      next.model = next.model.trim();
    }
  } else {
    const provider = await vscode.window.showQuickPick([
      { label: 'DeepSeek', value: 'deepseek', base: 'https://api.deepseek.com' },
      { label: 'Claude Messages API', value: 'anthropic', base: 'https://api.anthropic.com/v1' },
      { label: 'OpenAI 兼容 API', value: 'openai-compatible', base: '' },
    ], { title: '选择 API 服务商', ignoreFocusOut: true });
    if (!provider) return;
    next.provider = provider.value;
    next.apiBaseUrl = await vscode.window.showInputBox({
      title: 'API 基础地址', value: current.provider === provider.value ? current.apiBaseUrl : provider.base, ignoreFocusOut: true,
      validateInput: value => { try { endpointFor({ ...next, apiBaseUrl: value }); } catch (error) { return error.message; } },
    });
    if (!next.apiBaseUrl) return;
    next.apiBaseUrl = next.apiBaseUrl.trim();
    next.model = await vscode.window.showInputBox({
      title: '模型 ID', prompt: '填写此服务商为你的账号提供的模型 ID。', ignoreFocusOut: true,
      value: current.provider === provider.value ? current.model : '', validateInput: value => value.trim() ? undefined : '请填写模型 ID。',
    });
    if (!next.model) return;
    next.model = next.model.trim();
    const existing = await context.secrets.get(secretId(next));
    key = await vscode.window.showInputBox({
      title: 'API Key', password: true, ignoreFocusOut: true,
      prompt: existing ? '留空沿用此地址已保存的 API Key。' : '密钥保存在 VS Code SecretStorage 中。',
      validateInput: value => existing || value.trim() ? undefined : '请填写 API Key。',
    });
    if (key === undefined) return;
  }
  if (source.value !== 'codex') {
    const capabilities = await vscode.window.showQuickPick([
      { label: '能，优化时一起看图', description: '所选模型可以理解截图、界面图等图片内容', value: true },
      { label: '不能，只处理文字', description: '不发送图片，图片仍留在原聊天里', value: false },
    ], { title: '你选的这个模型能看图片吗？', ignoreFocusOut: true });
    if (!capabilities) return;
    next.supportsImages = capabilities.value;
  }
  const effort = await pickEffort(context, next, selectedModel, true);
  if (effort === undefined) return;
  next.reasoningEffort = effort;
  const useContext = await vscode.window.showQuickPick([
    { label: '结合前面的聊天一起优化', description: '适合接着当前话题提要求，能理解“这个”“继续”指什么', value: true },
    { label: '只优化输入框里的这段文字', description: '适合与前面聊天无关的新需求，不参考聊天记录', value: false },
  ], { title: '要参考前面的聊天吗？', ignoreFocusOut: true });
  if (!useContext) return;
  next.includeImages = next.supportsImages;
  next.contextEnabled = useContext.value;
  if (key?.trim()) await context.secrets.store(secretId(next), key.trim());
  const config = vscode.workspace.getConfiguration(prefix);
  for (const name of ['provider', 'apiBaseUrl', 'model', 'supportsImages', 'includeImages', 'contextEnabled', 'reasoningEffort']) {
    await config.update(name, next[name], vscode.ConfigurationTarget.Global);
  }
  vscode.window.showInformationMessage(`提示词优化已选择 ${next.provider === 'codex' ? 'Codex' : next.provider === 'claude' ? 'Claude Code' : next.provider} · ${next.model || '跟随当前模型'}。`);
}

async function pickEffort(context, config, knownModel, skipUnavailable = false) {
  let levels = [];
  let explanation = '这个连接没有提供可选的思考档位，保持现有调用方式。';
  if (config.provider === 'codex') {
    const agent = await getCodex(context);
    const model = knownModel ?? (agent.models.length ? agent.models : (await agent.catalog()).models).find(item => item.model === config.model);
    levels = (model?.supportedReasoningEfforts ?? []).map(item => item.reasoningEffort);
    explanation = '使用这个模型推荐的思考程度。';
  } else if (config.provider === 'claude' && config.model) {
    const models = knownModel ? [knownModel] : await claudeModels(await executableFor('claude'), path.join(context.globalStorageUri.fsPath, 'claude-workspace'));
    const model = knownModel ?? models.find(item => item.value === config.model) ?? models.find(item => item.resolvedModel === config.model);
    levels = model?.supportedEffortLevels ?? [];
    explanation = '沿用 Claude Code 的思考设置；具体档位由当前模型和账号规则决定。';
  } else if (config.provider === 'claude') explanation = '正在跟随 Claude Code 当前模型。要单独调整思考程度，请先选择一个具体模型。';
  if (!levels.length && skipUnavailable) return 'auto';
  const choice = await vscode.window.showQuickPick([
    { label: config.provider === 'claude' ? '跟随 Claude Code 当前设置' : config.provider === 'codex' ? effortLabels.auto : '保持当前调用方式', value: 'auto', detail: explanation },
    ...[...new Set(levels)].map(value => ({ label: effortLabels[value] || value, value, description: value,
      detail: ['none', 'minimal', 'low'].includes(value) ? '适合日常改写，通常等待较短。' : ['xhigh', 'max'].includes(value) ? '适合复杂要求，通常等待更久。' : '用于需要梳理多个条件和步骤的需求。',
    })),
  ], { title: '让 AI 想多深入？', placeHolder: `当前：${effortLabels[config.reasoningEffort] || effortLabels.auto}`, ignoreFocusOut: true });
  return choice?.value;
}

function effortLabelFor(config) {
  if (config.provider === 'deepseek') return '快速改写（关闭思考）';
  if (['anthropic', 'openai-compatible'].includes(config.provider)) return '由模型服务决定';
  if (config.provider === 'claude' && config.reasoningEffort === 'auto') return '跟随 Claude Code 当前设置';
  return effortLabels[config.reasoningEffort] || config.reasoningEffort;
}

function settingsState() {
  const config = settings();
  const fields = Object.fromEntries(['contextEnabled', 'includeImages', 'supportsImages', 'autoApply', 'historyEnabled', 'uiMode', 'recentTurns', 'timeoutSeconds'].map(name => [name, config[name]]));
  return { ...fields, configurationId: configId(config), modelLabel: `${sourceLabels[config.provider] || config.provider} · ${config.model || (config.provider === 'claude' ? '跟随当前模型' : '点击右侧选择模型')}`, effortLabel: effortLabelFor(config) };
}

async function saveOption(name, value, expectedId) {
  const config = settings();
  if (expectedId !== configId(config)) throw new Error('设置刚刚发生了变化，页面已刷新，请再选择一次。');
  if (['contextEnabled', 'includeImages', 'autoApply', 'historyEnabled'].includes(name)) {
    if (typeof value !== 'boolean') throw new Error('这个选项需要选择开启或关闭。');
    if (name === 'includeImages' && value && !config.supportsImages) throw new Error('请先选择能看图的模型。');
  } else if (name === 'uiMode') {
    if (!['native', 'inline'].includes(value)) throw new Error('请选择按钮放置位置。');
  } else if (['recentTurns', 'timeoutSeconds'].includes(name)) {
    const [minimum, maximum] = name === 'recentTurns' ? [1, 30] : [5, 300];
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`请填写 ${minimum} 到 ${maximum} 之间的整数。`);
  } else throw new Error('不能通过此页面修改这个选项。');
  if (config[name] !== value) await vscode.workspace.getConfiguration(prefix).update(name, value, vscode.ConfigurationTarget.Global);
}

async function showHistory(context) {
  const history = context.globalState.get('optimizationHistory', []);
  if (!history.length) { vscode.window.showInformationMessage('暂无提示词优化记录。'); return; }
  const selected = await vscode.window.showQuickPick(history.map(item => ({
    label: new Date(item.createdAt).toLocaleString(),
    description: item.model,
    detail: item.original.replace(/\s+/g, ' ').slice(0, 100),
    item,
  })), { title: '提示词优化历史', matchOnDescription: true, matchOnDetail: true });
  if (!selected) return;
  const item = selected.item;
  const document = await vscode.workspace.openTextDocument({
    language: 'markdown',
    content: `# 提示词优化记录\n\n时间：${item.createdAt}\n模型：${item.model}\n模型请求：${item.modelMs} ms\n\n## 原始输入\n\n${item.original}\n\n## 优化结果\n\n${item.result}\n`,
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function bridgeRequest(context, output, request, sender) {
  if (request?.version !== 2 || typeof request.requestId !== 'string' || request.requestId.length > 100) {
    throw new Error('优化器刚更新，请保存工作并重新加载 VS Code 窗口。');
  }
  let config = settings();
  switch (request.action) {
    case 'register':
      if (typeof sender !== 'function' || typeof request.bindingId !== 'string' || request.bindingId.length > 100) throw new Error('请重新加载窗口以启用新版界面桥接。');
      composers.set(request.bindingId, sender);
      if (request.focused) activeComposer = request.bindingId;
      while (composers.size > 32) composers.delete(composers.keys().next().value);
      statusBar.show();
      settingsButton.show();
      return { uiMode: config.uiMode };
    case 'focus':
      if (composers.has(request.bindingId)) activeComposer = request.bindingId;
      return { ok: true };
    case 'unregister':
      composers.delete(request.bindingId);
      if (activeComposer === request.bindingId) activeComposer = null;
      if (!composers.size) { statusBar.hide(); settingsButton.hide(); }
      return { ok: true };
    case 'status':
      if (request.bindingId === activeComposer && typeof request.text === 'string') {
        statusBar.text = '$(sparkle) ' + request.text.slice(0, 90);
      }
      return { ok: true };
    case 'notify':
      if (typeof request.text === 'string') vscode.window.showErrorMessage(request.text.slice(0, 1000));
      return { ok: true };
    case 'options': {
      if (config.provider === 'choose') {
        await configure(context);
        config = settings();
        if (config.provider === 'choose') throw new Error('已取消选择智能体。');
      }
      return { ...config, model: config.provider === 'claude' && !config.model ? 'Claude Code 当前模型' : config.model, configurationId: configId(config) };
    }
    case 'configure':
      openSettings();
      return { ok: true };
    case 'history':
      await showHistory(context);
      return { ok: true };
    case 'cancel':
      active.get(request.runId)?.abort();
      return { ok: true };
    case 'image':
      if (!config.includeImages || !config.supportsImages || request.configurationId !== configId(config)) throw new Error('图片设置已变化，请重新优化。');
      return readLocalImage(request.localPath, request.hostId);
    case 'record': {
      const record = pendingHistory.get(request.runId);
      pendingHistory.delete(request.runId);
      if (record && config.historyEnabled) {
        historyWrite = historyWrite.catch(() => {}).then(async () => {
          const previous = context.globalState.get('optimizationHistory', []);
          await context.globalState.update('optimizationHistory', [record, ...previous].slice(0, 50));
        });
        await historyWrite;
      }
      return { ok: true };
    }
    case 'optimize': {
      if (request.configurationId !== configId(config)) throw new Error('模型设置已变化，请重新点击优化。');
      if (active.size >= 4 || active.has(request.requestId)) throw new Error('已有优化请求正在处理。');
      const abort = new AbortController();
      active.set(request.requestId, abort);
      let timeout;
      let timeoutExpired = false;
      let rejectCancelled;
      try {
        const input = {
          draft: request.draft,
          context: config.contextEnabled ? request.context : [],
          images: config.includeImages ? request.images : [],
          draftImageCount: config.includeImages ? request.draftImageCount : 0,
          revision: request.revision,
        };
        const cancelled = new Promise((resolve, reject) => {
          rejectCancelled = () => reject(new Error(timeoutExpired ? '优化请求超时，草稿未替换。' : '已取消优化。'));
          abort.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        timeout = setTimeout(() => { timeoutExpired = true; abort.abort(); }, config.timeoutSeconds * 1000);
        const operation = (async () => {
          if (config.provider === 'codex') return (await getCodex(context)).optimize(input, config, abort.signal);
          if (config.provider === 'claude') return optimizeClaude(await executableFor('claude'), path.join(context.globalStorageUri.fsPath, 'claude-workspace'), input, config, abort.signal);
          const key = await context.secrets.get(secretId(config));
          if (abort.signal.aborted) throw new Error('已取消优化。');
          return optimize(input, config, key, abort.signal);
        })();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `提示词优化 · ${config.provider}`, cancellable: true }, async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try { return await Promise.race([operation, cancelled]); }
          finally { cancellation.dispose(); }
        });
        if (config.historyEnabled) {
          pendingHistory.set(request.requestId, {
            id: randomUUID(), createdAt: new Date().toISOString(), original: input.draft, result: result.text,
            model: result.model, modelMs: result.modelMs,
          });
          while (pendingHistory.size > 20) pendingHistory.delete(pendingHistory.keys().next().value);
        }
        output.appendLine(`optimize modelMs=${result.modelMs} inputChars=${input.draft.length} outputChars=${result.text.length} images=${input.images.length} contextMessages=${input.context.length}`);
        return { ...result, effortLabel: effortLabelFor(config), runId: request.requestId };
      } finally { clearTimeout(timeout); if (rejectCancelled) abort.signal.removeEventListener('abort', rejectCancelled); active.delete(request.requestId); }
    }
    default: throw new Error('不支持此桥接操作。');
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Codex Prompt Optimizer');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.name = 'Codex 提示词优化';
  statusBar.text = '$(sparkle) 优化提示词';
  statusBar.tooltip = '优化最近聚焦的 Codex 草稿（Ctrl+Alt+O）；恢复：Ctrl+Alt+Z';
  statusBar.command = `${prefix}.optimize`;
  settingsButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  settingsButton.name = '提示词优化设置';
  settingsButton.text = '$(gear)';
  settingsButton.tooltip = '提示词优化设置：模型、思考程度、参考聊天、应用方式';
  settingsButton.command = `${prefix}.settings`;
  openSettings = createSettings(context, {
    state: settingsState, configure: () => configure(context), history: () => showHistory(context), save: saveOption,
    effort: async () => {
      const config = settings();
      if (config.provider === 'choose') { await configure(context); return; }
      const value = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '选择思考程度' }, () => pickEffort(context, config));
      if (value !== undefined && value !== config.reasoningEffort) {
        if (configId(config) !== configId(settings())) throw new Error('模型设置已变化，请重新选择思考程度。');
        await vscode.workspace.getConfiguration(prefix).update('reasoningEffort', value, vscode.ConfigurationTarget.Global);
      }
    },
  });
  const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(`${prefix}.${name}`, async (...args) => {
    try { return await handler(...args); }
    catch (error) { vscode.window.showErrorMessage(error.message || '提示词优化操作失败。'); }
  }));
  register('configure', () => configure(context));
  register('settings', () => openSettings());
  register('history', () => showHistory(context));
  const invoke = async action => {
    const sender = composers.get(activeComposer);
    if (!sender) { vscode.window.showInformationMessage('请先点击一次目标 Codex 输入框，再使用优化或恢复。'); return; }
    await sender({ type: 'cpo:command', bindingId: activeComposer, action });
  };
  register('optimize', () => invoke('optimize'));
  register('undo', () => invoke('undo'));
  register('enableBridge', async () => {
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!codex) throw new Error('未找到官方 Codex 扩展。');
    await enableBridge(codex.extensionPath, context.globalStorageUri.fsPath);
    vscode.window.showInformationMessage('输入框按钮已启用。请保存工作后手动重新加载 VS Code 窗口。');
  });
  register('disableBridge', async () => {
    await disableBridge(context.globalStorageUri.fsPath);
    vscode.window.showInformationMessage('输入框按钮已移除。请保存工作后手动重新加载 VS Code 窗口。');
  });
  // 桥接调用返回明确错误，不能被普通命令的提示处理吞掉。
  const handleBridgeRequest = async (request, sender) => {
    try { return { ok: true, value: await bridgeRequest(context, output, request, sender) }; }
    catch (error) { return { ok: false, error: error.message || '提示词优化失败。' }; }
  };
  context.subscriptions.push(vscode.commands.registerCommand(`${prefix}.bridgeRequest`, request => handleBridgeRequest(request)), statusBar, settingsButton, output, {
    dispose() { for (const abort of active.values()) abort.abort(); codexAgent?.dispose(); active.clear(); pendingHistory.clear(); composers.clear(); activeComposer = null; },
  });
  return { handleBridgeRequest };
}

module.exports = { activate };
