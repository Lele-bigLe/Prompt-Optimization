'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');

function createSettings(context, handlers) {
  let panel;
  context.subscriptions.push({ dispose: () => panel?.dispose() });
  return () => {
    if (panel) { panel.reveal(); return; }
    panel = vscode.window.createWebviewPanel('codexPromptOptimizer.settings', '提示词优化设置', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
    const current = panel;
    current.onDidDispose(() => { if (panel === current) panel = null; });
    current.webview.onDidReceiveMessage(async message => {
      if (!message || !['ready', 'configure', 'effort', 'save', 'history', 'advanced'].includes(message.action)) return;
      let error;
      let notice = '';
      try {
        if (message.action === 'configure') await handlers.configure();
        else if (message.action === 'effort') await handlers.effort();
        else if (message.action === 'save') {
          await handlers.save(message.name, message.value, message.configurationId);
          notice = message.name === 'uiMode' ? '已保存。入口位置将在重新加载 VS Code 后改变。' : '已保存，下次优化时使用。';
        } else if (message.action === 'history') await handlers.history();
        else if (message.action === 'advanced') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:local-codex-tools.codex-prompt-optimizer-native');
      } catch (failure) { error = failure.message || '设置没有保存，请重试。'; }
      if (panel === current) await current.webview.postMessage({ state: handlers.state(), error, notice });
    });
    current.webview.html = settingsHtml(randomBytes(16).toString('hex'));
  };
}

function settingsHtml(nonce) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>提示词优化设置</title><style nonce="${nonce}">
body{font:var(--vscode-font-size,13px)/1.6 var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;box-sizing:border-box}
main{max-width:760px;margin:auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:0 0 16px}p{margin:4px 0;color:var(--vscode-descriptionForeground)}section{padding:20px 0;border-bottom:1px solid var(--vscode-widget-border, #7775)}
.row{display:flex;align-items:center;justify-content:space-between;gap:18px;margin:16px 0}.row>div{flex:1}.value{font-weight:600;margin:4px 0}.field{display:flex;gap:10px;align-items:flex-start;margin:18px 0}.field input{margin-top:5px;accent-color:var(--vscode-button-background)}.field label{flex:1}.field p{font-weight:normal}
button,select,input[type=number]{font:inherit;border:1px solid var(--vscode-input-border,transparent);border-radius:5px;padding:6px 10px}button{cursor:pointer;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:disabled,input:disabled{opacity:.5;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:2px}select,input[type=number]{background:var(--vscode-input-background);color:var(--vscode-input-foreground)}input[type=number]{width:80px}fieldset{border:0;margin:0;padding:0;min-width:0}#notice{min-height:24px;margin:12px 0}#notice.error{color:var(--vscode-errorForeground)}.links{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}small{color:var(--vscode-descriptionForeground)}
@media(max-width:500px){body{padding:16px}.row{align-items:flex-start;flex-direction:column;gap:8px}}
</style></head><body><main>
<h1>提示词优化设置</h1><p>让 AI 把你的需求写得更清楚。这里的选择只影响提示词优化器。</p>
<div id="notice" role="status">正在读取设置…</div><fieldset id="controls" disabled>
<section><h2>用哪个 AI</h2>
<div class="row"><div><span>优化用的账号和模型</span><div class="value" id="model"></div><p>可以使用已登录的 Codex、Claude Code，也可以填写自己的模型服务。</p></div><button type="button" data-action="configure">更换 AI 和模型</button></div>
<div class="row"><div><span>思考程度</span><div class="value" id="effort"></div><p>思考越深入，通常等待越久。调整时只会显示当前模型提供的档位。</p></div><button type="button" data-action="effort">调整思考程度</button></div>
</section>
<section><h2>优化时参考什么</h2>
<div class="field"><input id="contextEnabled" type="checkbox"><label for="contextEnabled">参考前面的聊天<p>开启后，结合当前窗口最近几轮聊天理解“这个”“继续”等说法。关闭后，只看输入框里的这段文字。</p></label></div>
<div class="field"><input id="includeImages" type="checkbox"><label for="includeImages">让 AI 一起看图片<p id="imageHelp">把输入框和参考聊天中的图片一起交给模型。关闭后，图片仍留在原聊天中。</p></label></div>
<div class="row"><label for="recentTurns">参考最近几轮聊天<br><small>一问一答算一轮；轮数越多，内容也越多。</small></label><input id="recentTurns" type="number" min="1" max="30" step="1"></div>
</section>
<section><h2>拿到结果后怎么用</h2>
<div class="field"><input id="autoApply" type="checkbox"><label for="autoApply">优化完直接填回输入框<p>开启后省去预览，可以一键恢复，再次点击优化可再改一版。关闭时先看预览，可补充要求继续优化。都不会自动发送消息。</p></label></div>
<div class="field"><input id="historyEnabled" type="checkbox"><label for="historyEnabled">保存优化记录<p>在本机保存最近 50 条已应用的原文和结果，方便回看；不保存图片。</p></label></div>
</section>
<section><h2>入口和等待时间</h2>
<div class="row"><label for="uiMode">优化按钮放在哪里<br><small>底部状态栏对聊天窗口影响较小；修改后需重新加载 VS Code。</small></label><select id="uiMode"><option value="native">VS Code 底部状态栏</option><option value="inline">聊天输入框里</option></select></div>
<div class="row"><label for="timeoutSeconds">最多等模型多少秒<br><small>超过这个时间会停止等待，原输入保留。</small></label><input id="timeoutSeconds" type="number" min="5" max="300" step="1"></div>
</section>
<div class="links"><button type="button" data-action="history">查看优化记录</button><button type="button" data-action="advanced">更多连接设置</button></div>
<p>使用：先点聊天输入框，再按 Ctrl+Alt+O 优化；Ctrl+Alt+Z 恢复上一次原文。</p>
</fieldset></main><script nonce="${nonce}">
const api = acquireVsCodeApi();
const controls = document.getElementById('controls');
const notice = document.getElementById('notice');
let state;
function send(action, extra = {}) {
  controls.disabled = true;
  notice.className = '';
  notice.textContent = action === 'effort' ? '正在读取当前模型支持的思考程度…' : action === 'configure' ? '请在弹出的选项中选择账号和模型…' : '正在处理…';
  api.postMessage({ action, ...extra });
}
window.addEventListener('message', event => {
  const reply = event.data;
  if (!reply?.state) return;
  state = reply.state;
  document.getElementById('model').textContent = state.modelLabel;
  document.getElementById('effort').textContent = state.effortLabel;
  for (const name of ['contextEnabled','autoApply','historyEnabled']) document.getElementById(name).checked = state[name];
  const images = document.getElementById('includeImages');
  images.checked = state.supportsImages && state.includeImages;
  images.disabled = !state.supportsImages;
  document.getElementById('imageHelp').textContent = state.supportsImages ? '把输入框和参考聊天中的图片一起交给模型。关闭后，图片仍留在原聊天中。' : '当前按纯文字模型连接，不发送图片；原附件保留。可在“更换 AI 和模型”中选择能看图的模型。';
  for (const name of ['recentTurns','timeoutSeconds','uiMode']) document.getElementById(name).value = state[name];
  notice.className = reply.error ? 'error' : '';
  notice.textContent = reply.error || reply.notice || '更改选项后会自动保存。';
  controls.disabled = false;
});
for (const element of document.querySelectorAll('[data-action]')) element.addEventListener('click', () => send(element.dataset.action));
for (const name of ['contextEnabled','includeImages','autoApply','historyEnabled','recentTurns','timeoutSeconds','uiMode']) {
  const element = document.getElementById(name);
  element.addEventListener('change', () => {
    const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? Number(element.value) : element.value;
    send('save', { name, value, configurationId: state.configurationId });
  });
}
send('ready');
</script></body></html>`;
}

module.exports = { createSettings };
