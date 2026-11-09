'use strict';

const vscode = require('vscode');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { optimize, endpointFor, prepareInput } = require('../core/optimizer.cjs');
const { providers, efforts, listModels, completion, getBalance } = require('../core/api.cjs');
const { CodexAgent } = require('../core/codex.cjs');
const { claudeAccount, claudeModels, optimizeClaude } = require('../core/claude.cjs');
const { createSettings } = require('./settings.cjs');
const { enableBridge, disableBridge, readState } = require('./patch.cjs');
const { createConnections } = require('./connections.cjs');
const { createTemplates } = require('./templates.cjs');
const { variablePattern } = require('../core/templates.cjs');
const compatibility = require('./compatibility.json');

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
let connections;
let templates;
let entryConfig;
let entryMessage = '';
let reloadRequired = false;
const apiCatalogs = new Map();
const optimizationSessions = new Map();
const effortLabels = { auto: '按模型默认', none: '不额外思考', minimal: '少量思考', low: '简单思考', medium: '适中思考', high: '深入思考', xhigh: '更深入思考', max: '最高强度思考', ultra: '极高强度思考' };
const sourceLabels = { choose: '还没选择 AI', codex: '已登录的 Codex', claude: '已登录的 Claude Code', deepseek: 'DeepSeek', anthropic: 'Claude API', 'openai-compatible': '自定义 API' };

function renderEntry(config) {
  if (config) entryConfig = config;
  if (!statusBar) return;
  const connected = composers.size > 0;
  const hint = reloadRequired ? '需重新加载' : !connected ? '未连接' : !composers.has(activeComposer) ? '请点选输入框' : '';
  statusBar.text = '$(sparkle) 优化提示词' + (hint ? ` · ${hint}` : '');
  statusBar.command = !connected || reloadRequired ? `${prefix}.settings` : `${prefix}.optimize`;
  statusBar.tooltip = [
    hint || '已连接当前 Codex 输入框',
    entryConfig ? entryConfig.provider === 'choose' ? '请先在优化设置中选择模型连接' : `优化模型：${sourceLabels[entryConfig.provider] || entryConfig.provider} · ${entryConfig.model || '客户端当前模型'}` : '正在读取优化模型设置',
    entryConfig ? `思考程度：${effortLabelFor(entryConfig)}` : '',
    entryMessage,
    connected && !reloadRequired ? 'Ctrl+Alt+O 优化；Ctrl+Alt+Z 恢复原文' : '点击查看连接状态和恢复入口',
  ].filter(Boolean).join('\n');
  statusBar.show();
}

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

function legacySettings() {
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

async function settings(store, templateSnapshot) {
  const values = legacySettings();
  const [saved, templateState] = await Promise.all([store || connections.read(), templateSnapshot || templates.read()]);
  const profile = saved.items.find(item => item.id === saved.activeId);
  return { ...values, provider: 'choose', model: '', supportsImages: false, reasoningEffort: 'auto',
    ...(profile || {}), connectionId: profile?.id || null, includeImages: values.includeImages && profile?.supportsImages === true, template:templates.active(templateState) };
}

function configId(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

function secretId(config) {
  return `${prefix}.key.${createHash('sha256').update(`${config.provider}|${endpointFor(config)}`).digest('hex')}`;
}

async function configure(context, profileId, signal, reuseSource = false) {
  const store = await connections.read();
  const selectedProfile = store.items.find(item => item.id === profileId);
  const current = { ...await settings(store), ...selectedProfile };
  const source = reuseSource && ['codex', 'claude'].includes(selectedProfile?.provider) ? { value: selectedProfile.provider } : await vscode.window.showQuickPick([
    { label: '$(account) 使用已登录的 Codex', value: 'codex', description: '沿用 Codex 的账号，不用再填密钥' },
    { label: '$(account) 使用已登录的 Claude Code', value: 'claude', description: '沿用 Claude Code 的账号和模型服务' },
  ], { title: '让哪个 AI 帮你优化提示词？', ignoreFocusOut: true });
  if (!source) return;
  const next = { ...current, provider: source.value };
  let selectedModel;
  if (source.value === 'codex') {
    const catalog = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '读取 Codex 当前账号和模型目录' }, async () => (await getCodex(context)).catalog());
    if (signal?.aborted) throw new Error('已取消选择。');
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
    if (signal?.aborted) throw new Error('已取消选择。');
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
  if (signal?.aborted) throw new Error('已取消选择。');
  const levels = next.provider === 'codex' ? selectedModel?.supportedReasoningEfforts?.map(item => item.reasoningEffort) : selectedModel?.supportedEffortLevels;
  return connections.save({
    id: selectedProfile?.provider === next.provider ? selectedProfile.id : undefined,
    name: selectedProfile?.provider === next.provider ? selectedProfile.name : `${sourceLabels[next.provider]} · ${next.model || '当前模型'}`.slice(0, 80),
    provider: next.provider, apiBaseUrl: '', model: next.model, reasoningEffort: next.reasoningEffort, supportsImages: next.supportsImages,
    modelMetadata: { id: next.model, levels: levels || null, supportsImages: next.provider === 'codex' ? next.supportsImages : null },
  }, undefined, store.revision);
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
      detail: ['none', 'minimal', 'low'].includes(value) ? '适合日常改写，通常等待较短。' : ['xhigh', 'max', 'ultra'].includes(value) ? '适合复杂要求，通常等待更久。' : '用于需要梳理多个条件和步骤的需求。',
    })),
  ], { title: '让 AI 想多深入？', placeHolder: `当前：${effortLabels[config.reasoningEffort] || effortLabels.auto}`, ignoreFocusOut: true });
  return choice?.value;
}

function effortLabelFor(config) {
  if (config.provider === 'deepseek' && config.reasoningEffort === 'auto') return '快速改写（默认关闭思考）';
  if (['anthropic', 'openai-compatible'].includes(config.provider) && config.reasoningEffort === 'auto') return '由模型服务决定';
  if (config.provider === 'claude' && config.reasoningEffort === 'auto') return '跟随 Claude Code 当前设置';
  return effortLabels[config.reasoningEffort] || config.reasoningEffort;
}

async function settingsState() {
  const [store, templateState] = await Promise.all([connections.read(), templates.read()]);
  const config = await settings(store, templateState);
  const fields = Object.fromEntries(['contextEnabled', 'includeImages', 'supportsImages', 'autoApply', 'historyEnabled', 'uiMode', 'recentTurns', 'maxContextChars', 'timeoutSeconds'].map(name => [name, config[name]]));
  const items = await Promise.all(store.items.map(async item => ({ ...item, hasKey: providers.includes(item.provider) && Boolean(await connections.key(item)) })));
  const codex = vscode.extensions.getExtension('openai.chatgpt');
  const compatible = codex?.packageJSON.version === compatibility.extensionVersion;
  let bridge;
  let bridgeStatus;
  let bridgeLabel;
  try {
    bridge = await readState(connections.storage);
    bridgeLabel = !bridge?.enabled ? '未连接' : composers.size ? '已连接' : '等待输入框';
    bridgeStatus = !bridge?.enabled ? '点击“连接 Codex 输入框”，完成后保存草稿并手动重新加载窗口。' : composers.size ? '当前窗口的输入框已连接，可以优化草稿。' : '连接文件已就绪。请打开 Codex 聊天并点击输入框；若刚连接，请先重新加载窗口。';
    if (bridge?.enabled && bridge.bridgeHash !== createHash('sha256').update(await fs.readFile(path.join(__dirname,'bridge.mjs'))).digest('hex')) {
      bridgeLabel = '需要更新连接';
      bridgeStatus = '请先断开并恢复原文件，再重新连接，最后保存草稿并手动重新加载窗口。';
    }
    if (reloadRequired) { bridgeLabel = '需重新加载'; bridgeStatus = '连接文件已改变。请保存草稿后执行“Developer: Reload Window”，再打开 Codex 输入框。'; }
  } catch { bridgeLabel = '状态读取失败'; bridgeStatus = '无法读取连接状态，请检查扩展存储中的 bridge-state.json。'; }
  if (!codex) { bridgeLabel = '未找到 Codex'; bridgeStatus = '请先安装官方 Codex 扩展；仍可在这里配置优化模型。'; }
  else if (!compatible) { bridgeLabel = '版本未适配'; bridgeStatus = `当前 Codex ${codex.packageJSON.version} 尚未适配，支持版本为 ${compatibility.extensionVersion}。`; }
  renderEntry(config);
  return { ...fields, configurationId: configId(config), modelLabel: `${sourceLabels[config.provider] || config.provider} · ${config.model || (config.provider === 'claude' ? '跟随当前模型' : '请添加或选择连接')}`, effortLabel: effortLabelFor(config),
    connections: items, connectionsRevision: store.revision, activeConnectionId: store.activeId, bridgeStatus, bridgeLabel,
    templates:templates.all(templateState), templatesRevision:templateState.revision, activeTemplateId:templateState.activeId, templateVariablePattern:variablePattern,
    canEnable: compatible && bridge !== undefined && !bridge?.enabled, canDisable: bridge?.enabled === true };
}

async function saveOption(name, value, expectedId) {
  const config = await settings();
  if (expectedId !== configId(config)) throw new Error('设置刚刚发生了变化，页面已刷新，请再选择一次。');
  if (['contextEnabled', 'includeImages', 'autoApply', 'historyEnabled'].includes(name)) {
    if (typeof value !== 'boolean') throw new Error('这个选项需要选择开启或关闭。');
    if (name === 'includeImages' && value && !config.supportsImages) throw new Error('请先选择能看图的模型。');
  } else if (name === 'uiMode') {
    if (!['native', 'inline'].includes(value)) throw new Error('请选择按钮放置位置。');
  } else if (['recentTurns', 'maxContextChars', 'timeoutSeconds'].includes(name)) {
    const [minimum, maximum] = name === 'recentTurns' ? [1, 30] : name === 'maxContextChars' ? [1000, 100000] : [5, 300];
    if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`请填写 ${minimum} 到 ${maximum} 之间的整数。`);
  } else throw new Error('不能通过此页面修改这个选项。');
  if (config[name] !== value) await vscode.workspace.getConfiguration(prefix).update(name, value, vscode.ConfigurationTarget.Global);
}

function catalogId(config, key) {
  return createHash('sha256').update(`${config.provider}|${endpointFor(config)}|${key}`).digest('hex');
}

function validateEffort(profile) {
  if (typeof profile.reasoningEffort !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(profile.reasoningEffort)) throw new Error('请选择有效的思考程度。');
  if (profile.reasoningEffort === 'auto') return;
  const known = profile.modelMetadata?.id === profile.model && Array.isArray(profile.modelMetadata?.levels);
  const levels = known ? profile.modelMetadata.levels : providers.includes(profile.provider) ? efforts : [];
  if (!levels.includes(profile.reasoningEffort)) throw new Error(known ? '所选模型不提供这个思考档位，请重新选择。' : '当前连接尚未确认这个思考档位，请重新选择模型读取能力目录，或使用默认档位。');
}

async function connectionDraft(form, requireModel = true) {
  if (!form || typeof form !== 'object') throw new Error('连接信息不完整，请重新填写。');
  const store = await connections.read();
  const previous = store.items.find(item => item.id === form.id);
  if (form.id && !previous) throw new Error('此连接已被删除，请重新选择。');
  if (![...providers, 'codex', 'claude'].includes(form.provider)) throw new Error('请选择连接类型。');
  const text = (value, maximum, label) => {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new Error(`${label}格式不正确。`);
    return value.trim();
  };
  const profile = { id: previous?.id, name: text(form.name, 80, '连接名称'), provider: form.provider,
    apiBaseUrl: text(form.apiBaseUrl || '', 2000, 'API 地址'), model: text(form.model || '', 200, '模型 ID'),
    reasoningEffort: form.reasoningEffort, supportsImages: form.supportsImages === true,
    tokenLimitParameter: form.tokenLimitParameter === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens' };
  if (requireModel && !profile.model && profile.provider !== 'claude') throw new Error('请选择或填写模型 ID。');
  let key;
  let sameEndpoint = false;
  if (providers.includes(profile.provider)) {
    endpointFor(profile);
    try { sameEndpoint = previous?.provider === profile.provider && String(endpointFor(previous)) === String(endpointFor(profile)); } catch {}
    const entered = text(form.apiKey || '', 8192, 'API 密钥');
    key = entered || (sameEndpoint ? await connections.key(previous) : undefined);
    if (!key) throw new Error(sameEndpoint ? '此连接没有已保存的密钥，请填写 API 密钥。' : '请填写此地址的 API 密钥；更换地址或服务类型后不会沿用旧密钥。');
    profile.modelMetadata = apiCatalogs.get(catalogId(profile, key))?.find(item => item.id === profile.model)
      || (sameEndpoint && previous.model === profile.model ? previous.modelMetadata : undefined);
  } else {
    if (!previous || previous.provider !== profile.provider || previous.model !== profile.model) throw new Error('请通过“使用已登录账号”选择客户端和模型。');
    profile.apiBaseUrl = '';
    profile.modelMetadata = previous.modelMetadata;
  }
  if (profile.modelMetadata?.id === profile.model) {
    if (typeof profile.modelMetadata.supportsImages === 'boolean') profile.supportsImages = profile.modelMetadata.supportsImages;
  }
  if (requireModel) validateEffort(profile);
  return { profile, key, enteredKey: typeof form.apiKey === 'string' && form.apiKey.trim() ? key : undefined };
}

async function connectionAction(action, message, signal) {
  if (action === 'saveEffort') {
    const store = await connections.read();
    const previous = store.items.find(item => item.id === message.id && item.id === store.activeId);
    if (!previous || store.revision !== message.connectionsRevision) throw new Error('正在使用的连接已变化，请确认当前模型后再调整思考程度。');
    const profile = { ...previous, reasoningEffort: message.value };
    validateEffort(profile);
    await connections.save(profile, undefined, store.revision);
    return { notice: '思考程度已自动保存，下次优化时使用。' };
  }
  if (['activateConnection', 'removeConnection', 'clearKey'].includes(action)) {
    const store = await connections.read();
    const profile = store.items.find(item => item.id === message.id);
    if (!profile) throw new Error('请先选择一组已保存的连接。');
    if (action === 'activateConnection') {
      await connections.activate(profile.id, message.connectionsRevision);
      return { selectedId: profile.id, notice: `正在使用 ${profile.name}。` };
    }
    const deleting = action === 'removeConnection';
    const answer = await vscode.window.showWarningMessage(deleting ? `删除连接“${profile.name}”及其已保存密钥？` : `清除“${profile.name}”已保存的 API 密钥？`, { modal: true }, deleting ? '删除连接' : '清除密钥');
    if (!answer) return { notice: '已取消，连接未更改。' };
    if (deleting) await connections.remove(profile.id, message.connectionsRevision);
    else await connections.clearKey(profile.id, message.connectionsRevision);
    return { selectedId: deleting ? null : profile.id, notice: deleting ? '连接已删除。请重新选择要使用的连接。' : '密钥已清除；使用此 API 前需要重新填写。' };
  }
  const { profile, key, enteredKey } = await connectionDraft(message.form, !['models', 'balance'].includes(action));
  if (action === 'saveConnection') {
    if (!profile.name) throw new Error('请给这组连接起一个名字。');
    const id = await connections.save(profile, enteredKey, message.connectionsRevision);
    return { selectedId: id, notice: '已保存并启用此连接，下次优化时使用。' };
  }
  if (!providers.includes(profile.provider)) throw new Error('此操作适用于 API 连接；已登录账号请通过官方客户端管理。');
  if (action === 'models') {
    const models = await listModels(profile, key, signal);
    apiCatalogs.set(catalogId(profile, key), models);
    while (apiCatalogs.size > 8) apiCatalogs.delete(apiCatalogs.keys().next().value);
    return { models, notice: models.length ? `已获取 ${models.length} 个模型；模型可用性请另点“测试模型调用”确认。` : '服务返回了空模型列表；仍可手动填写模型 ID。' };
  }
  if (action === 'test') {
    const result = await completion({ system: 'This is a connection test. Reply only OK.', text: 'Reply OK.' }, { ...profile, timeoutSeconds: legacySettings().timeoutSeconds }, key, signal, 2048);
    if (!result.truncated && (typeof result.text !== 'string' || !result.text.trim())) throw new Error('模型未返回有效回复，不能确认此连接可用于优化。');
    return { test: { model: result.model, modelMs: result.modelMs, truncated: result.truncated }, notice: result.truncated ? '模型已响应，但测试达到输出上限；可降低思考程度后再试。' : '所选模型已成功返回回复。此测试未读取聊天、草稿或图片。' };
  }
  if (action === 'balance') return { balance: await getBalance(profile, key, signal), notice: '余额已更新；此结果属于正在编辑的连接。' };
  throw new Error('不支持此连接操作。');
}

async function changeBridge(context, enabled) {
  if (enabled) {
    const codex = vscode.extensions.getExtension('openai.chatgpt');
    if (!codex) throw new Error('未找到官方 Codex 扩展。');
    await enableBridge(codex.extensionPath, context.globalStorageUri.fsPath);
  } else await disableBridge(context.globalStorageUri.fsPath);
  reloadRequired = true;
  renderEntry();
  return enabled ? '已准备连接输入框。请保存草稿后手动重新加载 VS Code 窗口。' : '已断开连接并恢复原文件。请保存草稿后手动重新加载 VS Code 窗口。';
}

async function templateAction(action, message, signal) {
  if (action === 'saveTemplate') return { templateSelectedId:await templates.save(message.template, message.templatesRevision), notice:'模板和变量已保存并启用。' };
  if (action === 'useTemplate') return { templateSelectedId:await templates.activate(message.id, message.variables, message.templatesRevision), notice:'已切换优化模板，下次优化时使用。' };
  if (action === 'copyTemplate') return { templateSelectedId:await templates.copy(message.id, message.templatesRevision), notice:'已复制为自定义模板，可编辑后保存；当前使用的模板未改变。' };
  const store = await templates.read();
  const selected = templates.all(store).find(item => item.id === message.id);
  if (action === 'removeTemplate') {
    if (!selected || selected.isBuiltin) throw new Error('只能删除已保存的自定义模板。');
    if (!await vscode.window.showWarningMessage(`删除模板“${selected.name}”？`, { modal:true }, '删除模板')) return { notice:'已取消删除。' };
    await templates.remove(selected.id, message.templatesRevision);
    return { templateSelectedId:null, notice:store.activeId === selected.id ? '模板已删除，已切回基础优化。' : '模板已删除。' };
  }
  if (action === 'importTemplates') {
    const files = await vscode.window.showOpenDialog({ title:'导入优化模板', canSelectMany:false, filters:{ 'JSON 模板':['json'] } });
    if (!files?.length || signal?.aborted) return { notice:'已取消导入。' };
    const bytes = await vscode.workspace.fs.readFile(files[0]);
    if (bytes.length > 5 * 1024 * 1024) throw new Error('模板文件超过 5 MB，请缩小后再导入。');
    let payload;
    try { payload = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')); } catch { throw new Error('模板 JSON 无法解析，请检查文件格式。'); }
    if (signal?.aborted) throw new Error('已取消导入。');
    const imported = await templates.import(payload, message.templatesRevision);
    return { templateSelectedId:imported.id, notice:`已导入 ${imported.count} 个自定义模板，未覆盖已有模板。填写所需变量后可启用。` };
  }
  if (action === 'exportTemplate') {
    if (!selected) throw new Error('请先选择一个已保存的模板。');
    const destination = await vscode.window.showSaveDialog({ title:'导出当前优化模板', defaultUri:vscode.Uri.file(path.join(os.homedir(), 'prompt-templates.json')), filters:{ 'JSON 模板':['json'] } });
    if (!destination || signal?.aborted) return { notice:'已取消导出。' };
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(templates.export(selected), null, 2), 'utf8'));
    return { notice:'模板已导出；导出文件不包含你填写的变量值、模型连接或密钥。' };
  }
  throw new Error('不支持此模板操作。');
}

function resetBackend(session) {
  if (session.provider === 'codex') codexAgent?.releaseSession(session.backend);
  else if (session.provider === 'claude') session.backend.process?.stop();
  session.backend = {};
}

function releaseSession(id) {
  const session = optimizationSessions.get(id);
  if (!session) return;
  optimizationSessions.delete(id);
  session.closed = true;
  clearTimeout(session.timer);
  active.get(session.requestId)?.abort();
  resetBackend(session);
}

function optimizationSession(request, config) {
  if (typeof request.sessionId !== 'string' || !/^[a-f\d-]{36}$/.test(request.sessionId) || !composers.has(request.bindingId) || typeof request.sourceIdentity !== 'string' || request.sourceIdentity.length > 2000) throw new Error('优化会话信息不完整，请重新点击优化。');
  let session = optimizationSessions.get(request.sessionId);
  if (!session) {
    if (request.revision || request.generation !== 0) throw new Error('本次优化会话已结束或闲置超时，请关闭预览后重新优化。');
    if (optimizationSessions.size >= 8) {
      const idle = [...optimizationSessions.values()].find(item => !item.running);
      if (!idle) throw new Error('已有多个优化会话正在处理，请稍后重试。');
      releaseSession(idle.id);
    }
    const input = { draft:request.draft, context:config.contextEnabled ? request.context : [], images:config.includeImages ? request.images : [], draftImageCount:config.includeImages ? request.draftImageCount : 0 };
    prepareInput(input, config);
    session = { id:request.sessionId, bindingId:request.bindingId, sourceIdentity:request.sourceIdentity, configurationId:request.configurationId, provider:config.provider, input, backend:{}, generation:0 };
    optimizationSessions.set(session.id, session);
  }
  if (session.bindingId !== request.bindingId || session.sourceIdentity !== request.sourceIdentity || session.configurationId !== request.configurationId) throw new Error('当前输入框、模板或连接已变化，请重新优化。');
  if (session.running || session.generation !== request.generation) throw new Error('本次优化结果已变化，请等待当前请求完成或重新优化。');
  if (session.generation > 0 && !request.revision) throw new Error('请通过“继续优化”提交修改要求。');
  clearTimeout(session.timer);
  session.running = true;
  session.requestId = request.requestId;
  return session;
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
  if (request?.version !== 3 || typeof request.requestId !== 'string' || request.requestId.length > 100) {
    throw new Error('优化器连接协议已更新。请在优化设置顶部先断开连接，再重新连接，并手动重新加载窗口。');
  }
  let config = ['options', 'image', 'optimize'].includes(request.action) ? await settings() : legacySettings();
  if (['options', 'image', 'optimize'].includes(request.action)) renderEntry(config);
  switch (request.action) {
    case 'register':
      if (typeof sender !== 'function' || typeof request.bindingId !== 'string' || request.bindingId.length > 100) throw new Error('请重新加载窗口以启用新版界面桥接。');
      composers.set(request.bindingId, sender);
      if (request.focused) activeComposer = request.bindingId;
      while (composers.size > 32) composers.delete(composers.keys().next().value);
      entryMessage = '';
      renderEntry();
      return { uiMode: config.uiMode };
    case 'focus':
      if (composers.has(request.bindingId)) activeComposer = request.bindingId;
      entryMessage = '';
      renderEntry();
      return { ok: true };
    case 'unregister':
      for (const session of optimizationSessions.values()) if (session.bindingId === request.bindingId) releaseSession(session.id);
      composers.delete(request.bindingId);
      if (activeComposer === request.bindingId) activeComposer = null;
      entryMessage = '';
      renderEntry();
      return { ok: true };
    case 'status':
      if (request.bindingId === activeComposer && typeof request.text === 'string') {
        entryMessage = request.text.slice(0, 90);
        renderEntry();
      }
      return { ok: true };
    case 'notify':
      if (typeof request.text === 'string') vscode.window.showErrorMessage(request.text.slice(0, 1000));
      return { ok: true };
    case 'options': {
      if (config.provider === 'choose') {
        openSettings();
        throw new Error('请先在优化设置中添加并启用一组连接，然后重新点击优化。');
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
    case 'release':
      if (optimizationSessions.get(request.sessionId)?.bindingId === request.bindingId) releaseSession(request.sessionId);
      return { ok:true };
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
      if (request.configurationId !== configId(config)) {
        if (optimizationSessions.get(request.sessionId)?.bindingId === request.bindingId) releaseSession(request.sessionId);
        throw new Error('模型、模板或优化偏好已变化，请重新点击优化。');
      }
      if (active.size >= 4 || active.has(request.requestId)) throw new Error('已有优化请求正在处理。');
      const session = optimizationSession(request, config);
      const abort = new AbortController();
      active.set(request.requestId, abort);
      let timeout;
      let timeoutExpired = false;
      let rejectCancelled;
      try {
        const input = { ...session.input, revision:request.revision };
        const cancelled = new Promise((resolve, reject) => {
          rejectCancelled = () => reject(new Error(timeoutExpired ? '优化请求超时，草稿未替换。' : '已取消优化。'));
          abort.signal.addEventListener('abort', rejectCancelled, { once: true });
        });
        timeout = setTimeout(() => { timeoutExpired = true; abort.abort(); }, config.timeoutSeconds * 1000);
        const operation = (async () => {
          if (config.provider === 'codex') return (await getCodex(context)).optimize(input, config, abort.signal, session.backend);
          if (config.provider === 'claude') return optimizeClaude(await executableFor('claude'), path.join(context.globalStorageUri.fsPath, 'claude-workspace'), input, config, abort.signal, session.backend);
          const key = await connections.key(config);
          if (abort.signal.aborted) throw new Error('已取消优化。');
          return optimize(input, config, key, abort.signal, session.backend);
        })();
        const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `提示词优化 · ${config.provider}`, cancellable: true }, async (progress, token) => {
          const cancellation = token.onCancellationRequested(() => abort.abort());
          try { return await Promise.race([operation, cancelled]); }
          finally { cancellation.dispose(); }
        });
        if (configId(config) !== configId(await settings())) throw new Error('优化期间连接、模板或偏好已变化，结果未应用，请重新优化。');
        if (config.historyEnabled) {
          pendingHistory.set(request.requestId, {
            id: randomUUID(), createdAt: new Date().toISOString(), original: input.draft, result: result.text,
            model: result.model, modelMs: result.modelMs,
          });
          while (pendingHistory.size > 20) pendingHistory.delete(pendingHistory.keys().next().value);
        }
        output.appendLine(`optimize modelMs=${result.modelMs} inputChars=${input.draft.length} outputChars=${result.text.length} images=${input.images.length} contextMessages=${input.context.length}`);
        session.generation++;
        return { ...result, generation:session.generation, effortLabel: effortLabelFor(config), runId: request.requestId };
      } catch (error) { resetBackend(session); throw error; }
      finally {
        clearTimeout(timeout); if (rejectCancelled) abort.signal.removeEventListener('abort', rejectCancelled); active.delete(request.requestId);
        session.running = false;
        if (!session.closed) session.timer = setTimeout(() => releaseSession(session.id), 5 * 60 * 1000);
      }
    }
    default: throw new Error('不支持此桥接操作。');
  }
}

function activate(context) {
  connections = createConnections(context, legacySettings, secretId);
  templates = createTemplates(context);
  const output = vscode.window.createOutputChannel('Codex Prompt Optimizer');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusBar.name = 'Codex 提示词优化';
  statusBar.text = '$(sparkle) 优化提示词';
  settingsButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 49);
  settingsButton.name = '提示词优化菜单';
  settingsButton.text = '$(ellipsis) 优化菜单';
  settingsButton.tooltip = '设置、恢复原文、优化记录';
  settingsButton.command = `${prefix}.menu`;
  settingsButton.show();
  openSettings = createSettings(context, {
    state: settingsState, configure: (id, signal, reuseSource) => configure(context, id, signal, reuseSource), history: () => showHistory(context), save: saveOption,
    connection: connectionAction, template:templateAction, bridge: enabled => changeBridge(context, enabled),
  });
  const register = (name, handler) => context.subscriptions.push(vscode.commands.registerCommand(`${prefix}.${name}`, async (...args) => {
    try { return await handler(...args); }
    catch (error) { vscode.window.showErrorMessage(error.message || '提示词优化操作失败。'); }
  }));
  register('configure', () => openSettings());
  register('settings', () => openSettings());
  register('history', () => showHistory(context));
  const invoke = async action => {
    if (reloadRequired || !composers.size) { openSettings(); return; }
    const sender = composers.get(activeComposer);
    if (!sender) { vscode.window.showInformationMessage('请先点击一次目标 Codex 输入框，再使用优化或恢复。'); return; }
    await sender({ type: 'cpo:command', bindingId: activeComposer, action });
  };
  register('optimize', () => invoke('optimize'));
  register('undo', () => invoke('undo'));
  register('menu', async () => {
    const config = await settings();
    renderEntry(config);
    const choice = await vscode.window.showQuickPick([
      { label: '$(gear) 打开优化设置', action: 'settings', description: '连接状态、模型、思考程度和模板' },
      { label: '$(discard) 恢复原文', action: 'undo', description: '恢复当前输入框上一次优化前的草稿' },
      { label: '$(history) 查看优化记录', action: 'history', description: '查看本机最近已应用的优化' },
    ], { title: '提示词优化', placeHolder: `${sourceLabels[config.provider] || config.provider} · ${config.model || '请先选择模型'} · ${effortLabelFor(config)}` });
    if (choice?.action === 'settings') openSettings();
    else if (choice?.action === 'undo') await invoke('undo');
    else if (choice?.action === 'history') await showHistory(context);
  });
  register('enableBridge', async () => {
    vscode.window.showInformationMessage(await changeBridge(context, true));
  });
  register('disableBridge', async () => {
    vscode.window.showInformationMessage(await changeBridge(context, false));
  });
  // 桥接调用返回明确错误，不能被普通命令的提示处理吞掉。
  const handleBridgeRequest = async (request, sender) => {
    try { return { ok: true, value: await bridgeRequest(context, output, request, sender) }; }
    catch (error) { return { ok: false, error: error.message || '提示词优化失败。' }; }
  };
  context.subscriptions.push(vscode.commands.registerCommand(`${prefix}.bridgeRequest`, request => handleBridgeRequest(request)), statusBar, settingsButton, output, {
    dispose() { for (const session of optimizationSessions.values()) releaseSession(session.id); for (const abort of active.values()) abort.abort(); codexAgent?.dispose(); active.clear(); pendingHistory.clear(); composers.clear(); activeComposer = null; statusBar = null; settingsButton = null; },
  });
  renderEntry();
  // 只异步读取本机偏好，不在启动时启动模型服务或获取远程目录。
  settings().then(renderEntry).catch(error => {
    if (!statusBar) return;
    entryMessage = '模型设置读取失败，请打开优化设置检查。';
    output.appendLine(error.message || entryMessage);
    renderEntry();
  });
  return { handleBridgeRequest };
}

module.exports = { activate };
