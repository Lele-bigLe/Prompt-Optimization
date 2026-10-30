'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');

function createSettings(context, handlers) {
  let panel;
  context.subscriptions.push({ dispose: () => panel?.dispose() });
  return () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('codexPromptOptimizer.settings', '提示词优化设置', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    const current = panel;
    let running;
    current.onDidDispose(() => { running?.abort(); if (panel === current) panel = null; });
    current.webview.onDidReceiveMessage(async message => {
      const templateActions = ['saveTemplate','useTemplate','copyTemplate','removeTemplate','importTemplates','exportTemplate'];
      const actions = ['ready', 'reload', 'reloadTemplates', 'configure', 'save', 'history', 'advanced', 'bridge', 'saveConnection', 'activateConnection', 'removeConnection', 'clearKey', 'models', 'test', 'balance', ...templateActions];
      if (message?.action === 'cancel') { running?.abort(); return; }
      if (!message || !actions.includes(message.action) || running) return;
      const controller = new AbortController();
      running = controller;
      let result = {};
      let error;
      try {
        if (message.action === 'configure') {
          const id = await handlers.configure(message.id, controller.signal);
          result = id ? { selectedId: id, notice: '已保存并启用所选账号和模型。' } : { notice: '已取消选择，连接未更改。' };
        } else if (message.action === 'save') {
          await handlers.save(message.name, message.value, message.configurationId);
          result.notice = message.name === 'uiMode' ? '已保存。入口位置将在重新加载 VS Code 后改变。' : '已保存，下次优化时使用。';
        } else if (message.action === 'history') await handlers.history();
        else if (message.action === 'advanced') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-codex-tools.codex-prompt-optimizer-native');
        else if (message.action === 'bridge') {
          if (typeof message.enabled !== 'boolean') throw new Error('请选择启用或停用接入。');
          result.notice = await handlers.bridge(message.enabled);
        } else if (message.action === 'reload') result = { selectedId: message.id || null, notice: '已重新读取连接，未保存的表单改动已放弃。' };
        else if (message.action === 'reloadTemplates') result = { templateSelectedId:message.id || null, notice:'已重新读取模板，未保存的模板改动已放弃。' };
        else if (templateActions.includes(message.action)) result = await handlers.template(message.action, message, controller.signal);
        else if (message.action !== 'ready') result = await handlers.connection(message.action, message, controller.signal);
      } catch (failure) { error = failure.message || '操作没有完成，请重试。'; }
      let state;
      try { state = await handlers.state(); }
      catch (failure) { error = failure.message || '无法读取设置。'; }
      if (running === controller) running = null;
      if (panel === current) await current.webview.postMessage({ action: message.action, state, ...result, error });
    });
    current.webview.html = settingsHtml(randomBytes(16).toString('hex'));
  };
}

function settingsHtml(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>提示词优化设置</title><style nonce="${nonce}">
body{font:var(--vscode-font-size,13px)/1.6 var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;box-sizing:border-box}
main{max-width:800px;margin:auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 14px}p{margin:5px 0;color:var(--vscode-descriptionForeground)}section{padding:22px 0;border-bottom:1px solid var(--vscode-widget-border,#7775)}
.row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:14px 0}.row>div{flex:1;min-width:0}.value{font-weight:600;overflow-wrap:anywhere}.field{display:flex;gap:10px;align-items:flex-start;margin:16px 0}.field input{margin-top:5px;accent-color:var(--vscode-button-background)}.field label{flex:1}
.form-row{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;align-items:start;margin:16px 0}.form-row>label{padding-top:5px}.form-row input:not([type=checkbox]),.form-row select{width:100%;box-sizing:border-box}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
button,select,input,textarea{font:inherit;border:1px solid var(--vscode-input-border,transparent);border-radius:5px;padding:6px 10px}button{cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}button.primary:hover{background:var(--vscode-button-hoverBackground)}button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.5;cursor:default}
textarea{box-sizing:border-box;width:100%;resize:vertical;min-height:110px;line-height:1.6;background:var(--vscode-input-background);color:var(--vscode-input-foreground)}textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}
button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}select,input{background:var(--vscode-input-background);color:var(--vscode-input-foreground)}input[type=checkbox]{padding:0}input[type=number]{width:80px}fieldset{border:0;margin:0;padding:0;min-width:0}#notice{min-height:24px;margin:12px 0;overflow-wrap:anywhere}.error{color:var(--vscode-errorForeground)}small{color:var(--vscode-descriptionForeground)}details{margin:16px 0}summary{cursor:pointer}#savedConnections{min-width:0;flex:1}.result{overflow-wrap:anywhere;margin:8px 0;color:var(--vscode-descriptionForeground)}[hidden]{display:none!important}
@media(max-width:540px){body{padding:16px}.row{align-items:stretch;flex-direction:column;gap:8px}.form-row{grid-template-columns:1fr;gap:4px}.form-row>label{padding:0}}
</style></head><body><main>
<h1>提示词优化设置</h1><p>选好一个连接，再回到聊天输入框优化。这里的配置只影响提示词优化器。</p>
<div id="notice" role="status" aria-live="polite">正在读取设置…</div><button id="cancelRequest" type="button" hidden>取消请求</button>
<fieldset id="controls" disabled>
<section><h2>用哪个 AI</h2><p class="value" id="activeModel"></p><p id="activeEffort"></p>
<div class="row"><label for="savedConnections">已保存的连接</label><select id="savedConnections" aria-label="已保存的连接"></select></div>
<div class="actions"><button id="useConnection" type="button">使用此连接</button><button id="newConnection" type="button">新建 API 连接</button><button id="configure" type="button">使用已登录账号</button></div>
<p>已登录账号支持 Codex 和 Claude Code，无需填写密钥。自己的模型服务在下面配置。</p>
<div class="form-row"><label for="connectionName">连接名称</label><input id="connectionName" type="text" maxlength="80" placeholder="例如：日常改写、复杂需求"></div>
<div class="form-row"><label for="provider">连接类型</label><select id="provider"><option value="deepseek">DeepSeek API</option><option value="anthropic">Claude Messages API</option><option value="openai-compatible">OpenAI 兼容 API / 中转服务</option><option value="codex" disabled>已登录的 Codex</option><option value="claude" disabled>已登录的 Claude Code</option></select></div>
<div id="apiFields">
<div class="form-row"><label for="apiBaseUrl">API 地址</label><div><input id="apiBaseUrl" type="url" maxlength="2000" placeholder="例如：https://api.deepseek.com"><p>通常填写服务商提供的基础地址；需要 /v1 时请保留。更换地址后需重新填写密钥。</p></div></div>
<div class="form-row"><label for="apiKey">API 密钥</label><div><input id="apiKey" type="password" autocomplete="off" maxlength="8192" placeholder="填写 API Key"><p id="keyHint"></p><button id="clearKey" type="button">清除已保存密钥</button></div></div>
<div class="actions"><button id="loadModels" type="button">获取 / 刷新模型</button></div>
</div>
<div class="form-row"><label for="model">模型</label><div><input id="model" type="text" list="modelChoices" maxlength="200" placeholder="获取模型后搜索选择，也可直接填写模型 ID"><datalist id="modelChoices"></datalist><p id="modelHint"></p></div></div>
<div class="form-row"><label for="reasoningEffort">思考程度</label><div><select id="reasoningEffort"></select><p id="effortHint"></p></div></div>
<div class="field"><input id="supportsImages" type="checkbox"><label for="supportsImages">这个模型能看图片<p id="capabilityHint">服务没有提供能力信息时，请按服务商说明确认。</p></label></div>
<details id="compatibilityOptions"><summary>接口兼容选项（通常不用改）</summary><div class="form-row"><label for="tokenLimitParameter">输出上限参数</label><div><select id="tokenLimitParameter"><option value="max_tokens">max_tokens（多数兼容服务）</option><option value="max_completion_tokens">max_completion_tokens（OpenAI 新式推理接口）</option></select><p>只有服务商要求另一种格式时才调整；测试调用与实际优化使用相同格式。</p></div></div></details>
<div class="actions"><button id="saveConnection" type="button" class="primary">保存并使用</button><button id="discardChanges" type="button">放弃修改并重新读取</button><button id="removeConnection" type="button">删除此连接</button></div>
<p id="draftHint">连接配置需点击“保存并使用”；下方优化偏好会自动保存。</p>
<div id="apiChecks"><div class="actions"><button id="testConnection" type="button">测试模型调用（可能产生费用）</button><button id="balance" type="button">查询余额</button></div><p>测试使用一条独立短消息，不读取聊天、草稿或图片；获取模型成功不代表所选模型一定可调用。</p><p class="result" id="testResult" role="status"></p><p class="result" id="balanceResult" role="status"></p></div>
</section>
<section><h2>怎样优化</h2><p class="value" id="activeTemplate"></p><p>模板决定改写的格式和重点，可以配合任意模型连接使用。默认“基础优化”尽量少改；“需求拆解”会整理目标、范围、约束与验收。</p>
<div class="form-row"><label for="templates">优化模板</label><select id="templates"></select></div>
<div class="actions"><button id="useTemplate" type="button">使用此模板</button><button id="copyTemplate" type="button">复制为自定义</button><button id="newTemplate" type="button">新建模板</button></div>
<details id="templateEditor"><summary>查看 / 编辑模板内容</summary>
<div class="form-row"><label for="templateName">模板名称</label><input id="templateName" type="text" maxlength="80"></div>
<div class="form-row"><label for="templateDescription">用途说明</label><input id="templateDescription" type="text" maxlength="300"></div>
<div class="form-row"><label for="templateCategory">分组</label><input id="templateCategory" type="text" maxlength="40"></div>
<div class="form-row"><label for="templateSystem">优化规则</label><textarea id="templateSystem" maxlength="20000"></textarea></div>
<div class="form-row"><label for="templateUser">用户模板</label><div><textarea id="templateUser" maxlength="20000"></textarea><p>支持 {{originalPrompt}} 和 {{自定义变量}}。原文按 JSON 字符串填入；未写原文占位符时会自动附加原文。基本的保留原意、只改写规则始终保留。</p></div></div>
</details>
<div id="templateVariables"></div><p id="templateHint"></p>
<div class="actions"><button id="saveTemplate" type="button" class="primary">保存并使用模板</button><button id="reloadTemplates" type="button">放弃模板修改并重新读取</button><button id="removeTemplate" type="button">删除自定义模板</button></div>
<div class="actions"><button id="importTemplates" type="button">导入模板 JSON</button><button id="exportTemplate" type="button">导出当前模板</button></div><p>导入支持上游的模板包及模板数组，不覆盖已有模板；导出不含变量值、模型连接和密钥。</p>
</section>
<section><h2>优化时参考什么</h2>
<div class="field"><input id="contextEnabled" type="checkbox"><label for="contextEnabled">参考前面的聊天<p>结合当前窗口最近几轮聊天理解“这个”“继续”。关闭后只优化输入框里的文字。</p></label></div>
<div class="field"><input id="includeImages" type="checkbox"><label for="includeImages">让 AI 一起看图片<p id="imageHelp"></p></label></div>
<div class="row"><label for="recentTurns">参考最近几轮聊天<br><small>一问一答算一轮；轮数越多，发送的内容也越多。</small></label><input id="recentTurns" type="number" min="1" max="30" step="1"></div>
</section>
<section><h2>拿到结果后怎么用</h2>
<div class="field"><input id="autoApply" type="checkbox"><label for="autoApply">优化完直接填回输入框<p>开启后省去预览，仍可一键恢复。关闭时先看预览，可补充要求继续优化。都不会自动发送消息。</p></label></div>
<div class="field"><input id="historyEnabled" type="checkbox"><label for="historyEnabled">保存优化记录<p>在本机保存最近 50 条已应用的原文和结果，不保存图片。</p></label></div>
</section>
<section><h2>入口和等待时间</h2>
<div class="row"><label for="uiMode">优化按钮放在哪里<br><small>底部状态栏对聊天窗口影响较小；修改后需重新加载 VS Code。</small></label><select id="uiMode"><option value="native">VS Code 底部状态栏</option><option value="inline">聊天输入框里</option></select></div>
<div class="row"><label for="timeoutSeconds">最多等模型多少秒<br><small>超时后停止等待，原输入保留。</small></label><input id="timeoutSeconds" type="number" min="5" max="300" step="1"></div>
<details><summary>高级：Codex 接入与更多设置</summary><p id="bridgeStatus"></p><p>启用会备份并修改已适配的 Codex 文件；停用会按备份恢复。操作后请保存工作并手动重新加载窗口。</p><div class="actions"><button id="enableBridge" type="button">启用 Codex 接入</button><button id="disableBridge" type="button">停用并恢复 Codex 文件</button><button id="advanced" type="button">更多 VS Code 设置</button></div></details>
</section>
<div class="actions"><button id="history" type="button">查看优化记录</button></div><p>使用：先点聊天输入框，再按 Ctrl+Alt+O 优化；Ctrl+Alt+Z 恢复上一次原文。</p>
</fieldset></main><script nonce="${nonce}">
const api = acquireVsCodeApi();
const $ = id => document.getElementById(id);
const labels = { auto:'按默认方式', none:'不额外思考', minimal:'少量思考', low:'简单思考', medium:'适中思考', high:'深入思考', xhigh:'更深入思考', max:'最高强度思考' };
const manualLevels = { deepseek:['none','low','high','max'], anthropic:['none','low','medium','high','xhigh','max'], 'openai-compatible':['none','minimal','low','medium','high','xhigh','max'] };
const apiProviders = Object.keys(manualLevels);
let state;
let selectedId = '';
let draftRevision;
let models = [];
let dirty = false;
let busy = false;
let templateId = '';
let templateRevision;
let templateDirty = false;
let templateValues = new Map();
function savedTemplate() { return state?.templates.find(item => item.id === templateId); }
function templateForm() { return { id:templateId || undefined, name:$('templateName').value, description:$('templateDescription').value, category:$('templateCategory').value, systemPrompt:$('templateSystem').value, userTemplate:$('templateUser').value, variables:Object.fromEntries(templateValues) }; }
function templateChanged() { templateDirty = true; $('templateHint').textContent = '模板或变量有未保存改动，点击“保存并使用模板”后生效。'; templateButtons(); }
function templateButtons() {
  const item = savedTemplate();
  $('saveTemplate').disabled = item?.isBuiltin === true;
  $('useTemplate').disabled = !item;
  $('copyTemplate').disabled = !item || templateDirty;
  $('removeTemplate').disabled = !item || item.isBuiltin || templateDirty;
  $('exportTemplate').disabled = !item || templateDirty;
}
function renderTemplateVariables() {
  const names = [...new Set([...($('templateSystem').value + String.fromCharCode(10) + $('templateUser').value).matchAll(new RegExp(state.templateVariablePattern,'g'))].map(match => match[1]).filter(name => name !== 'originalPrompt'))];
  const container = $('templateVariables');
  container.replaceChildren();
  for (const name of names.slice(0,20)) {
    const row = document.createElement('div'); row.className = 'form-row';
    const label = document.createElement('label'); label.textContent = '变量：' + name;
    const input = document.createElement('input'); input.type = 'text'; input.maxLength = 4000; input.value = templateValues.get(name) || '';
    input.id = 'templateVariable' + container.childElementCount; label.htmlFor = input.id;
    input.addEventListener('input', () => { templateValues.set(name,input.value); templateChanged(); });
    row.append(label,input); container.append(row);
  }
  if (names.length) { const help = document.createElement('p'); help.textContent = names.length > 20 ? '变量超过 20 个，请删除多余占位符。' : '请填写这些变量。变量会保存在本机，并随提示词交给优化模型；这里不要填写 API 密钥。'; container.append(help); }
}
function loadTemplate(id) {
  templateId = state.templates.some(item => item.id === id) ? id : '';
  const item = savedTemplate();
  $('templates').value = templateId;
  for (const [field,key] of [['templateName','name'],['templateDescription','description'],['templateCategory','category'],['templateSystem','systemPrompt'],['templateUser','userTemplate']]) {
    $(field).value = item?.[key] || (key === 'category' ? '自定义' : key === 'userTemplate' ? '原始草稿（JSON 字符串）：' + String.fromCharCode(10) + '{{originalPrompt}}' : '');
    $(field).readOnly = item?.isBuiltin === true;
  }
  templateValues = new Map(Object.entries(item?.variables || {}));
  templateRevision = state.templatesRevision;
  templateDirty = false;
  $('templateHint').textContent = (item?.description ? item.description + '。' : '') + (item?.isBuiltin ? '内置模板只读，点击“复制为自定义”后可以修改。' : '模板需点击“保存并使用模板”后才生效。');
  $('templateEditor').open = !item?.isBuiltin;
  renderTemplateVariables(); templateButtons();
}
function cleanTemplate() { if (!templateDirty) return true; notice('模板有未保存改动，请先保存，或放弃模板修改后重新读取。',true); return false; }
function saved() { return state?.connections.find(item => item.id === selectedId); }
function isApi() { return apiProviders.includes($('provider').value); }
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
function form() { return { id:selectedId || undefined, name:$('connectionName').value, provider:$('provider').value, apiBaseUrl:$('apiBaseUrl').value, apiKey:$('apiKey').value, model:$('model').value.trim(), reasoningEffort:$('reasoningEffort').value, supportsImages:$('supportsImages').checked, tokenLimitParameter:$('tokenLimitParameter').value }; }
function send(action, extra = {}) {
  if (busy) return;
  busy = true;
  $('controls').disabled = true;
  $('cancelRequest').hidden = !['models','test','balance'].includes(action);
  notice(({ models:'正在获取模型列表…', test:'正在使用当前表单配置测试模型调用…', balance:'正在查询此连接的余额…', configure:'请在弹出的选项中选择已登录账号和模型…' })[action] || '正在处理…');
  api.postMessage({ action, ...extra });
}
function changed() {
  dirty = true;
  $('draftHint').textContent = '有未保存的连接改动。点击“保存并使用”后才影响实际优化。';
  $('testResult').textContent = '';
  $('balanceResult').textContent = '';
  renderAvailability();
}
function metadata() {
  const data = form();
  return models.find(item => item.id === data.model) || (saved()?.provider === data.provider && saved()?.apiBaseUrl === data.apiBaseUrl && saved()?.model === data.model ? saved().modelMetadata : undefined);
}
function renderCapabilities(effort) {
  const info = metadata();
  const known = Array.isArray(info?.levels);
  const levels = known ? info.levels : manualLevels[$('provider').value] || [];
  const select = $('reasoningEffort');
  const current = effort || select.value || 'auto';
  select.replaceChildren(new Option($('provider').value === 'deepseek' ? '默认：快速改写（关闭思考）' : '跟随模型或服务默认', 'auto'));
  for (const level of levels) select.add(new Option(labels[level] || level, level));
  if (current !== 'auto' && !levels.includes(current)) {
    const option = new Option((labels[current] || current) + '（当前目录未确认，请重选）', current);
    option.disabled = true;
    select.add(option);
  }
  select.value = current;
  $('effortHint').textContent = known ? '档位来自此模型的能力目录；更深入的思考通常等待更久。' : isApi() ? '服务未提供可识别的思考能力信息。以下是按接口协议手动设置的档位，不保证当前模型全部支持；不确定时保持默认并测试。' : '当前连接未保存思考能力目录；可点“使用已登录账号”重新选择并读取。';
  const imageKnown = typeof info?.supportsImages === 'boolean';
  $('supportsImages').disabled = imageKnown;
  if (imageKnown) $('supportsImages').checked = info.supportsImages;
  $('capabilityHint').textContent = imageKnown ? (info.supportsImages ? '模型能力目录确认支持图片。' : '模型能力目录未提供图片支持。') : '能力未知；请按服务商说明手动确认，勾选后才会向此模型发送图片。';
  $('modelHint').textContent = isApi() ? (models.length ? '已获取 ' + models.length + ' 个模型，可输入名称搜索；也可手动填写 ID。' : '可点击获取模型；接口不开放列表时，直接填写服务商提供的模型 ID。') : '模型由官方客户端提供；更改模型请点“使用已登录账号”。';
}
function renderAvailability() {
  const native = !isApi();
  $('apiFields').hidden = native;
  $('apiChecks').hidden = native;
  $('compatibilityOptions').hidden = $('provider').value !== 'openai-compatible';
  $('provider').disabled = native;
  $('model').readOnly = native;
  $('useConnection').disabled = !selectedId || dirty;
  $('removeConnection').disabled = !selectedId || dirty;
  $('clearKey').disabled = !saved()?.hasKey || dirty;
  let canBalance = false;
  try { const url = new URL($('apiBaseUrl').value); canBalance = $('provider').value === 'deepseek' && url.origin === 'https://api.deepseek.com'; } catch {}
  $('balance').disabled = !canBalance;
  if (!canBalance) $('balanceResult').textContent = '此服务暂不支持余额查询；目前仅接入 DeepSeek 官方接口。';
}
function loadForm(id) {
  selectedId = state.connections.some(item => item.id === id) ? id : '';
  const profile = saved();
  $('savedConnections').value = selectedId;
  $('connectionName').value = profile?.name || '';
  $('provider').value = profile?.provider || 'deepseek';
  $('apiBaseUrl').value = profile?.apiBaseUrl || (profile ? '' : 'https://api.deepseek.com');
  $('model').value = profile?.model || '';
  $('apiKey').value = '';
  $('keyHint').textContent = profile?.hasKey ? '此地址已有密钥，留空可继续使用。密钥保存在 VS Code 安全存储中，不会回填显示。' : '请填写此服务的 API 密钥；保存后仅显示是否已配置。';
  $('tokenLimitParameter').value = profile?.tokenLimitParameter || 'max_tokens';
  $('supportsImages').checked = profile?.supportsImages === true;
  models = [];
  $('modelChoices').replaceChildren();
  dirty = false;
  draftRevision = state.connectionsRevision;
  $('draftHint').textContent = '连接配置需点击“保存并使用”；下方优化偏好会自动保存。';
  $('testResult').textContent = '';
  $('balanceResult').textContent = '';
  renderCapabilities(profile?.reasoningEffort || 'auto');
  renderAvailability();
}
function cleanDraft() {
  if (!dirty) return true;
  notice('有未保存的连接改动。请先保存，或点击“放弃修改并重新读取”。', true);
  return false;
}
window.addEventListener('message', event => {
  const reply = event.data;
  if (!reply || typeof reply.action !== 'string') return;
  busy = false;
  $('cancelRequest').hidden = true;
  if (!reply.state) { notice(reply.error || '无法读取设置，请关闭后重新打开。', true); return; }
  const first = !state;
  state = reply.state;
  $('controls').disabled = false;
  $('activeModel').textContent = '正在使用：' + state.modelLabel;
  $('activeEffort').textContent = '思考程度：' + state.effortLabel;
  const picker = $('savedConnections');
  picker.replaceChildren(new Option('新建 API 连接…', ''));
  for (const item of state.connections) picker.add(new Option(item.name + (item.id === state.activeConnectionId ? '（正在使用）' : ''), item.id));
  picker.value = selectedId;
  if (first || Object.prototype.hasOwnProperty.call(reply, 'selectedId')) loadForm(reply.selectedId === null ? '' : reply.selectedId || state.activeConnectionId || '');
  const templatePicker = $('templates');
  templatePicker.replaceChildren(new Option('新建自定义模板…',''));
  for (const item of state.templates) templatePicker.add(new Option((item.category || '自定义') + ' · ' + item.name + (item.id === state.activeTemplateId ? '（正在使用）' : ''),item.id));
  templatePicker.value = templateId;
  $('activeTemplate').textContent = '正在使用：' + (state.templates.find(item => item.id === state.activeTemplateId)?.name || '');
  if (first || Object.prototype.hasOwnProperty.call(reply,'templateSelectedId')) loadTemplate(reply.templateSelectedId || state.activeTemplateId);
  if (reply.models) {
    models = reply.models;
    $('modelChoices').replaceChildren(...models.map(item => new Option(item.name, item.id)));
    renderCapabilities();
  }
  if (reply.test) $('testResult').textContent = (reply.test.truncated ? '模型已响应，测试输出达到上限' : '模型调用成功') + ' · ' + reply.test.model + ' · ' + (reply.test.modelMs / 1000).toFixed(1) + ' 秒';
  if (reply.balance) $('balanceResult').textContent = reply.balance.balances.map(item => item.currency + ' ' + item.total).join('；') + (reply.balance.available ? '' : ' · 服务返回余额不足') + ' · 查询于 ' + new Date(reply.balance.checkedAt).toLocaleString();
  if (reply.error && ['test','balance'].includes(reply.action)) $(reply.action === 'test' ? 'testResult' : 'balanceResult').textContent = reply.error;
  for (const name of ['contextEnabled','autoApply','historyEnabled']) $(name).checked = state[name];
  $('includeImages').checked = state.includeImages;
  $('includeImages').disabled = !state.supportsImages;
  $('imageHelp').textContent = state.supportsImages ? '将可读取的图片交给当前启用的模型；关闭后，原聊天附件仍保留。' : '当前启用的连接按纯文字处理，不发送图片；原聊天附件仍保留。';
  for (const name of ['recentTurns','timeoutSeconds','uiMode']) $(name).value = state[name];
  $('bridgeStatus').textContent = state.bridgeStatus;
  $('enableBridge').disabled = !state.canEnable;
  $('disableBridge').disabled = !state.canDisable;
  renderAvailability();
  notice(reply.error || reply.notice || '选择连接后可配置；优化偏好更改后会自动保存。', Boolean(reply.error));
});
$('savedConnections').addEventListener('change', () => { if (cleanDraft()) loadForm($('savedConnections').value); else $('savedConnections').value = selectedId; });
$('newConnection').addEventListener('click', () => { if (cleanDraft()) loadForm(''); });
$('templates').addEventListener('change', () => { if (cleanTemplate()) loadTemplate($('templates').value); else $('templates').value = templateId; });
$('newTemplate').addEventListener('click', () => { if (cleanTemplate()) loadTemplate(''); });
for (const id of ['templateName','templateDescription','templateCategory','templateSystem','templateUser']) $(id).addEventListener('input', () => { templateChanged(); if (id === 'templateSystem' || id === 'templateUser') renderTemplateVariables(); });
$('saveTemplate').addEventListener('click', () => send('saveTemplate', { template:templateForm(), templatesRevision:templateRevision }));
$('useTemplate').addEventListener('click', () => { if (templateDirty && !savedTemplate()?.isBuiltin) { notice('请先保存模板和变量修改，再启用。',true); return; } send('useTemplate', { id:templateId, variables:Object.fromEntries(templateValues), templatesRevision:templateRevision }); });
for (const action of ['copyTemplate','removeTemplate','importTemplates','exportTemplate']) $(action).addEventListener('click', () => { if (cleanTemplate()) send(action, { id:templateId, templatesRevision:templateRevision }); });
$('reloadTemplates').addEventListener('click', () => send('reloadTemplates', { id:templateId }));
$('discardChanges').addEventListener('click', () => send('reload', { id:selectedId }));
$('configure').addEventListener('click', () => { if (cleanDraft()) send('configure', { id:selectedId || undefined }); });
for (const [id, action] of [['useConnection','activateConnection'],['removeConnection','removeConnection'],['clearKey','clearKey']]) $(id).addEventListener('click', () => send(action, { id:selectedId, connectionsRevision:draftRevision }));
for (const [id, action] of [['saveConnection','saveConnection'],['loadModels','models'],['testConnection','test'],['balance','balance']]) $(id).addEventListener('click', () => send(action, { form:form(), connectionsRevision:draftRevision }));
$('cancelRequest').addEventListener('click', () => { api.postMessage({ action:'cancel' }); notice('正在取消请求…'); });
$('provider').addEventListener('change', () => {
  $('apiBaseUrl').value = ({ deepseek:'https://api.deepseek.com', anthropic:'https://api.anthropic.com/v1', 'openai-compatible':'' })[$('provider').value];
  $('apiKey').value = '';
  $('model').value = '';
  $('keyHint').textContent = '请填写此服务的 API 密钥；更换服务类型后不会沿用旧密钥。';
  $('supportsImages').checked = false;
  models = [];
  $('modelChoices').replaceChildren();
  renderCapabilities('auto');
  changed();
});
for (const id of ['apiBaseUrl','apiKey']) $(id).addEventListener('input', () => {
  if (id === 'apiBaseUrl') $('apiKey').value = '';
  models = [];
  $('modelChoices').replaceChildren();
  $('keyHint').textContent = '更换地址或服务类型后需重新填写密钥；输入的密钥不会自动保存。';
  renderCapabilities(id === 'apiBaseUrl' ? 'auto' : undefined);
  changed();
});
$('model').addEventListener('input', () => { $('supportsImages').checked = false; renderCapabilities('auto'); changed(); });
for (const id of ['connectionName','reasoningEffort','supportsImages','tokenLimitParameter']) $(id).addEventListener('change', changed);
for (const action of ['history','advanced']) $(action).addEventListener('click', () => send(action));
$('enableBridge').addEventListener('click', () => send('bridge', { enabled:true }));
$('disableBridge').addEventListener('click', () => send('bridge', { enabled:false }));
for (const name of ['contextEnabled','includeImages','autoApply','historyEnabled','recentTurns','timeoutSeconds','uiMode']) $(name).addEventListener('change', () => send('save', { name, value:$(name).type === 'checkbox' ? $(name).checked : $(name).type === 'number' ? Number($(name).value) : $(name).value, configurationId:state.configurationId }));
send('ready');
</script></body></html>`;
}

module.exports = { createSettings };
