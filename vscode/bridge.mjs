import { c as hostApi, s as initializeHostApi, a as decodeHostMessage, o as initializeDecoder } from './message-bus-4113ba7287d7.js';
import { d as materializeTurn, y as transcriptTurnReferences } from './pending-worktree-state-e8591cea6502.js';
import { v as composerImages } from './composer-view-state-7eda9b57445b.js';

const pending = new Map();
const bindings = new Map();
window.addEventListener('message', event => {
  try {
    initializeDecoder();
    const message = decodeHostMessage(event);
    if (message?.type === 'cpo:command') {
      const binding = bindings.get(message.bindingId);
      if (message.action === 'optimize') binding?.optimize();
      else if (message.action === 'undo') binding?.undo();
      return;
    }
    if (message?.type !== 'cpo:response') return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.payload?.ok) request.resolve(message.payload.value);
    else request.reject(new Error(message.payload?.error || '提示词优化扩展未返回结果。'));
  } catch { /* 其他 Codex 消息继续由原消息总线处理。 */ }
});

function request(action, payload = {}, timeoutMs = 60000, id = crypto.randomUUID()) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('输入框桥接响应超时。')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      initializeHostApi();
      hostApi.postMessage({ type: 'cpo:request', id, payload: { version: 2, requestId: id, action, ...payload } });
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error('无法连接提示词优化扩展。'));
    }
  });
}

export function readImages(scope) {
  return scope.get(composerImages) ?? [];
}

export function readTurns(scope, target, limit) {
  const references = scope.get(transcriptTurnReferences, target);
  if (references == null) return null;
  const turns = references.slice(-limit).map(reference => materializeTurn(scope, reference));
  if (turns.some(turn => turn == null)) throw new Error('当前会话的近期历史尚未加载完成，请稍后重试。');
  return turns;
}

function collectMessages(turns) {
  const messages = [];
  function addUser(content) {
    if (!Array.isArray(content)) return;
    const text = content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    const imageRefs = content.flatMap(item => item.type === 'image' && typeof item.url === 'string'
      ? [{ src: item.url }]
      : item.type === 'localImage' && typeof item.path === 'string' ? [{ localPath: item.path }] : []);
    if (text || imageRefs.length) messages.push({ role: 'user', text, imageRefs });
  }
  for (const turn of turns) {
    const items = (turn.items ?? []).filter(Boolean);
    if (!items.some(item => item.type === 'userMessage')) addUser(turn.params?.input);
    for (const item of items) {
      if (item.type === 'userMessage') addUser(item.content);
      else if (item.type === 'steeringUserMessage') addUser(item.input);
      else if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        messages.push({ role: 'assistant', text: item.text, imageRefs: [] });
      }
    }
  }
  return messages;
}

function contextWithinBudget(messages, budget) {
  const selected = messages.map(message => ({ ...message }));
  const size = () => JSON.stringify(selected.map(({ role, text, imageRefs, truncated }) => ({ role, text, imageNumbers: imageRefs.map(() => 8), omittedImages: imageRefs.length, truncated: truncated === true }))).length;
  while (selected.length > 1 && size() > budget) selected.shift();
  while (selected.length && size() > budget) {
    const last = selected[0];
    if (!last.text.length) throw new Error('当前会话的图片记录超过上下文预算。');
    last.text = last.text.slice(Math.max(1, Math.ceil(last.text.length / 4)));
    last.truncated = true;
  }
  return selected;
}

async function imageData(image, identity, options, abortSignal) {
  if (image.src?.startsWith('data:image/')) return image.src;
  const localPath = image.localPath || (/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(image.src ?? '') ? image.src : null);
  if (localPath) return request('image', { localPath, hostId: image.hostId ?? identity.hostId, configurationId: options.configurationId });
  if (typeof image.src !== 'string' || !/^(blob:|https:|vscode-webview:)/.test(image.src)) throw new Error('有图片尚未就绪或没有可读取的图片地址。');
  try {
    const response = await fetch(image.src, { signal: abortSignal, credentials: 'omit', redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw new Error();
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 5 * 1024 * 1024) throw new Error();
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const blob = new Blob(chunks, { type: response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream' });
    return await new Promise((resolve, reject) => {
      const file = new FileReader();
      file.onload = () => resolve(file.result);
      file.onerror = reject;
      file.readAsDataURL(blob);
    });
  } catch { throw new Error('图片读取失败或超过 5 MB；草稿与附件均未替换。'); }
}

function sameImages(left, right) {
  return left.length === right.length && left.every((image, index) => image === right[index]);
}

function protectedNodes(document) {
  const nodes = [];
  document.descendants(node => {
    if (node.isAtom && !node.isText && !['hard_break', 'hardBreak'].includes(node.type.name)) nodes.push(node.toJSON());
  });
  return JSON.stringify(nodes);
}

function addStyles() {
  if (document.getElementById('cpo-styles')) return;
  const style = document.createElement('style');
  style.id = 'cpo-styles';
  style.textContent = `
    .cpo-controls{display:flex;align-items:center;gap:5px;padding:4px 0;font:12px var(--vscode-font-family,sans-serif);flex-wrap:wrap}
    .cpo-controls button,.cpo-preview button{cursor:pointer;border:1px solid var(--vscode-widget-border,#687478);border-radius:7px;padding:3px 8px;min-width:27px;min-height:26px;background:var(--vscode-button-secondaryBackground,#35464b);color:var(--vscode-button-secondaryForeground,#fff);font:inherit}
    .cpo-controls button:first-child,.cpo-preview .cpo-apply{background:var(--vscode-button-background,#147a94);color:var(--vscode-button-foreground,#fff);font-weight:600}
    .cpo-controls button:hover,.cpo-preview button:hover{filter:brightness(1.15)}
    .cpo-controls button:focus-visible,.cpo-preview button:focus-visible{outline:2px solid var(--vscode-focusBorder,#80d8ee);outline-offset:2px}
    .cpo-controls button:disabled{opacity:.45;cursor:default}
    .cpo-status{font-size:11px;color:var(--vscode-descriptionForeground,#b4c2c7);overflow-wrap:anywhere;flex:1;min-width:80px}
    .cpo-preview{width:min(850px,90vw);max-height:85vh;overflow:auto;padding:18px;background:var(--vscode-editor-background,#152d32);color:var(--vscode-editor-foreground,#e1eaed);border:1px solid var(--vscode-widget-border,#687478);border-radius:12px;font:13px var(--vscode-font-family,sans-serif)}
    .cpo-preview::backdrop{background:#0008}.cpo-preview h2{font-size:16px;margin:0 0 10px}.cpo-preview p{font-size:12px;margin:0 0 12px;overflow-wrap:anywhere}
    .cpo-columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}.cpo-columns label{display:flex;flex-direction:column;gap:6px}
    .cpo-preview textarea{box-sizing:border-box;resize:vertical;width:100%;min-height:280px;padding:10px;border:1px solid var(--vscode-input-border,#53666c);border-radius:6px;background:var(--vscode-input-background,#102429);color:var(--vscode-input-foreground,#fff);font:13px/1.6 var(--vscode-font-family,sans-serif)}
    .cpo-preview footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px;position:sticky;bottom:-18px;padding:12px 0;background:var(--vscode-editor-background,#152d32);z-index:1}
    .cpo-preview .cpo-guidance{min-height:64px;margin-top:6px}.cpo-refinement{display:block;margin-top:14px}.cpo-preview .cpo-error{color:var(--vscode-errorForeground,#f88);margin-top:8px}.cpo-preview button:disabled{opacity:.45;cursor:default}
    @media(max-width:600px){.cpo-columns{grid-template-columns:1fr}.cpo-preview textarea{min-height:150px}}
  `;
  document.head.append(style);
}

function button(label, title, handler) {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  element.title = title;
  element.setAttribute('aria-label', title);
  element.addEventListener('click', handler);
  return element;
}

function preview(original, initialResult, describe, owner, refine) {
  addStyles();
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'cpo-preview';
    dialog.setAttribute('aria-label', '提示词优化预览');
    const title = document.createElement('h2');
    title.textContent = '提示词优化';
    const information = document.createElement('p');
    let result = initialResult;
    let busy = false;
    information.textContent = describe(result);
    const columns = document.createElement('div');
    columns.className = 'cpo-columns';
    let resultArea;
    for (const [caption, content] of [['原始输入', original], ['优化结果', result.text]]) {
      const label = document.createElement('label');
      label.textContent = caption;
      const area = document.createElement('textarea');
      area.readOnly = true;
      area.value = content;
      if (caption === '优化结果') resultArea = area;
      label.append(area);
      columns.append(label);
    }
    const footer = document.createElement('footer');
    const refinement = document.createElement('label');
    refinement.className = 'cpo-refinement';
    refinement.textContent = '想怎么再改？（选填）';
    const instructions = document.createElement('textarea');
    instructions.className = 'cpo-guidance';
    instructions.maxLength = 4000;
    instructions.placeholder = '例如：再简短一点；按目标、步骤、验收条件组织。留空则在上一版基础上再优化一次。';
    refinement.append(instructions);
    const errorMessage = document.createElement('p');
    errorMessage.className = 'cpo-error';
    errorMessage.setAttribute('role', 'alert');
    const cancel = button('保留原文', '关闭预览并保留原文', () => dialog.close('cancel'));
    const apply = button('应用到输入框', '只替换草稿文字，不发送消息', () => dialog.close('apply'));
    const again = button('继续优化', '按填写的要求，修改当前这一版', async () => {
      if (busy) return;
      busy = true;
      apply.disabled = again.disabled = instructions.disabled = true;
      again.textContent = '正在优化…';
      errorMessage.textContent = '';
      try {
        const next = await refine(result, instructions.value.trim());
        if (!dialog.isConnected) return;
        result = next;
        resultArea.value = next.text;
        information.textContent = describe(next);
        instructions.value = '';
      } catch (error) {
        if (dialog.isConnected) errorMessage.textContent = `${error.message || '继续优化失败'} 上一版仍在，可以应用或重试。`;
      } finally {
        busy = false;
        apply.disabled = again.disabled = instructions.disabled = false;
        again.textContent = '继续优化';
      }
    });
    apply.className = 'cpo-apply';
    footer.append(cancel, again, apply);
    dialog.append(title, information, columns, refinement, errorMessage, footer);
    dialog.addEventListener('close', () => {
      if (busy && owner.running) {
        owner.running.cancelled = true;
        owner.running.abort.abort();
        request('cancel', { runId: owner.running.id }).catch(() => {});
      }
      owner.dialog = null;
      dialog.remove();
      resolve(dialog.returnValue === 'apply' ? result : null);
    }, { once: true });
    document.body.append(dialog);
    owner.dialog = dialog;
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') event.preventDefault();
    });
    dialog.showModal();
  });
}

export function bindComposer(binding) {
  const controller = binding.controller;
  const view = controller?.view;
  if (!view || typeof controller.getPersistedText !== 'function' || typeof controller.restoreText !== 'function') return;
  const owner = { disposed: false, running: null, dialog: null, id: crypto.randomUUID() };
  const history = [];
  let observer;
  let controls;
  let frame;

  function setStatus(text) {
    if (controls) controls.status.textContent = text;
    request('status', { bindingId: owner.id, text }).catch(() => {});
  }

  function setBusy(busy) {
    if (!controls) return;
    controls.optimize.textContent = busy ? '■' : '✦';
    controls.optimize.title = busy ? '取消优化' : '优化提示词';
    controls.optimize.setAttribute('aria-label', controls.optimize.title);
    if (busy) controls.bar.setAttribute('aria-busy', 'true');
    else controls.bar.removeAttribute('aria-busy');
    controls.undo.disabled = busy || history.length === 0;
  }

  function capture() {
    const identity = binding.identity();
    if (!['local', 'new'].includes(identity.scopeKind)) throw new Error('此版本暂仅适配 Codex 本地会话输入框。');
    if (view.isDestroyed || !view.dom.isConnected) throw new Error('当前输入框已关闭。');
    if (view.composing) throw new Error('请先完成当前输入法输入，再点击优化。');
    return {
      identity: JSON.stringify(identity), source: identity, document: view.state.doc,
      selection: view.state.selection.getBookmark(), images: binding.images().slice(), text: controller.getPersistedText(),
    };
  }

  function ensure(snapshot, expectedDocument = snapshot.document) {
    if (owner.disposed || view.isDestroyed || !view.dom.isConnected || JSON.stringify(binding.identity()) !== snapshot.identity) throw new Error('当前会话或输入框已经切换，未替换草稿。');
    if (!view.state.doc.eq(expectedDocument) || !sameImages(binding.images(), snapshot.images)) throw new Error('草稿或附件已变化，未替换；请重新优化。');
  }

  function restore(snapshot) {
    const transaction = view.state.tr.replaceWith(0, view.state.doc.content.size, snapshot.document.content);
    transaction.setSelection(snapshot.selection.resolve(transaction.doc));
    view.dispatch(transaction);
    controller.focus();
  }

  function undoClick() {
    try {
      if (view.composing) throw new Error('请先完成当前输入法输入，再恢复原文。');
      if (owner.running) throw new Error('请先取消或完成当前优化。');
      const entry = history.at(-1);
      if (!entry) { setStatus('暂无可恢复的优化'); return; }
      ensure(entry.before, entry.after);
      restore(entry.before);
      history.pop();
      if (controls) controls.undo.disabled = history.length === 0;
      setStatus('已恢复原文，附件保留');
    } catch (error) {
      setStatus(error.message);
      if (!controls) request('notify', { text: error.message }).catch(() => {});
    }
  }

  async function optimizeClick() {
    if (owner.running) {
      owner.running.cancelled = true;
      owner.running.abort.abort();
      owner.dialog?.close('cancel');
      request('cancel', { runId: owner.running.id }).catch(() => {});
      return;
    }
    const run = { id: crypto.randomUUID(), cancelled: false, abort: new AbortController() };
    owner.running = run;
    setBusy(true);
    setStatus('读取草稿…');
    try {
      const options = await request('options', {}, 600000);
      const snapshot = capture();
      if (!snapshot.text.trim()) throw new Error('请先填写提示词。');
      if (!options.model) throw new Error('请打开提示词优化设置，选择用哪个 AI 和模型。');
      const started = performance.now();
      let messages = [];
      if (options.contextEnabled) {
        const turns = binding.turns(options.recentTurns);
        if (snapshot.source.threadId && turns == null) throw new Error('当前会话历史尚未加载，请稍后重试。');
        messages = contextWithinBudget(collectMessages(turns ?? []), options.maxContextChars);
      }
      const imageRefs = options.includeImages ? snapshot.images.map(image => ({ src: image.src, localPath: image.localPath, hostId: snapshot.source.imageHostId })) : [];
      const draftImageCount = imageRefs.length;
      const context = messages.map(message => {
        const imageNumbers = options.includeImages ? message.imageRefs.map(image => { imageRefs.push(image); return imageRefs.length; }) : [];
        return { role: message.role, text: message.text, imageNumbers, omittedImages: options.includeImages ? 0 : message.imageRefs.length, truncated: message.truncated === true };
      });
      if (imageRefs.length > 8) throw new Error('草稿与近期对话合计超过 8 张图片，请减少对话轮数或关闭发送图片。');
      if (imageRefs.length && !options.supportsImages) throw new Error('当前模型未启用图片能力。请配置支持图片的模型，或在设置中关闭发送图片。');
      const images = [];
      for (const image of imageRefs) {
        if (run.cancelled) throw new Error('已取消优化。');
        images.push(await imageData(image, snapshot.source, options, run.abort.signal));
      }
      ensure(snapshot);
      if (run.cancelled) throw new Error('已取消优化。');
      const captureMs = Math.round(performance.now() - started);
      const getResult = async revision => {
        ensure(snapshot);
        if (run.cancelled) throw new Error('已取消优化。');
        run.id = crypto.randomUUID();
        setStatus(`正在优化 · ${options.model}`);
        const result = await request('optimize', {
          configurationId: options.configurationId, draft: snapshot.text, context, images, draftImageCount, revision,
        }, (options.timeoutSeconds + 15) * 1000, run.id);
        if (run.cancelled) throw new Error('已取消优化。');
        ensure(snapshot);
        setStatus('结果已准备好');
        return result;
      };
      let result = await getResult();
      const scope = options.contextEnabled ? `参考前面 ${context.length} 条聊天` : '只看这段输入';
      const imageSummary = options.includeImages ? `图片 ${images.length} 张` : '图片未发送，附件保留';
      const describe = value => `${value.model} · ${value.effortLabel || '模型默认'} · ${scope} · ${imageSummary} · 读取 ${captureMs} ms · 优化 ${(value.modelMs / 1000).toFixed(1)} 秒`;
      if (!options.autoApply) {
        setStatus('可以应用，也可以继续优化');
        result = await preview(snapshot.text, result, describe, owner, (previous, instructions) => getResult({ previousPrompt: previous.text, instructions }));
        if (!result) { setStatus('已保留原文'); return; }
      }
      ensure(snapshot);
      if (run.cancelled) throw new Error('已取消优化。');
      if (result.text !== snapshot.text) {
        try {
          controller.restoreText(result.text);
          if (!sameImages(binding.images(), snapshot.images) || protectedNodes(view.state.doc) !== protectedNodes(snapshot.document)) throw new Error('原有引用或附件发生变化。');
        } catch {
          if (owner.disposed || view.isDestroyed || JSON.stringify(binding.identity()) !== snapshot.identity) throw new Error('会话在写回期间发生变化，请检查原会话的草稿。');
          restore(snapshot);
          if (!view.state.doc.eq(snapshot.document)) throw new Error('写回失败，请检查输入框中的草稿。');
          throw new Error('写回未能保留原稿结构，已恢复原文。');
        }
        history.push({ before: snapshot, after: view.state.doc });
        if (history.length > 10) history.shift();
        controller.focus();
      }
      setStatus(`已应用 · 模型 ${(result.modelMs / 1000).toFixed(1)} 秒`);
      try { await request('record', { runId: result.runId }); }
      catch { setStatus('已应用，历史记录保存失败'); }
    } catch (error) {
      if (!owner.disposed) {
        setStatus(error.message || '优化失败，草稿未替换。');
        if (!controls) request('notify', { text: error.message || '优化失败，草稿未替换。' }).catch(() => {});
      }
    } finally {
      owner.running = null;
      if (!owner.disposed) setBusy(false);
    }
  }

  function mount() {
    if (owner.disposed || !view.dom.isConnected || view.isDestroyed) return false;
    addStyles();
    const bar = document.createElement('div');
    bar.className = 'cpo-controls';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '提示词优化');
    const status = document.createElement('span');
    status.className = 'cpo-status';
    status.setAttribute('role', 'status');
    const optimize = button('✦', '优化提示词', optimizeClick);
    const undo = button('↶', '恢复上一次优化前的草稿', undoClick);
    undo.disabled = true;
    const historyButton = button('◷', '历史回顾', () => request('history', {}, 600000).catch(error => { status.textContent = error.message; }));
    const configure = button('⚙', '提示词优化设置', () => request('configure', {}, 600000).catch(error => { status.textContent = error.message; }));
    bar.append(optimize, undo, historyButton, configure, status);
    view.dom.after(bar);
    controls = { bar, optimize, undo, status };
    return true;
  }

  const focus = () => request('focus', { bindingId: owner.id }).catch(() => {});
  const keydown = event => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== 'o' && key !== 'z') return;
    event.preventDefault();
    event.stopPropagation();
    if (key === 'o') optimizeClick();
    else undoClick();
  };
  bindings.set(owner.id, { optimize: optimizeClick, undo: undoClick });
  view.dom.addEventListener('focusin', focus);
  view.dom.addEventListener('keydown', keydown);
  request('register', { bindingId: owner.id, focused: view.hasFocus() }).then(options => {
    if (owner.disposed) { request('unregister', { bindingId: owner.id }).catch(() => {}); return; }
    if (view.hasFocus()) focus();
    // 原生模式不插入任何常驻 DOM，也不建立布局/变更观察器。
    if (options.uiMode !== 'inline') return;
    frame = requestAnimationFrame(() => {
      if (!mount()) {
        observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
        observer.observe(document.body, { childList: true, subtree: true });
      }
    });
  }).catch(error => { if (!owner.disposed) request('notify', { text: error.message }).catch(() => {}); });
  return () => {
    owner.disposed = true;
    bindings.delete(owner.id);
    view.dom.removeEventListener('focusin', focus);
    view.dom.removeEventListener('keydown', keydown);
    if (frame !== undefined) cancelAnimationFrame(frame);
    observer?.disconnect();
    request('unregister', { bindingId: owner.id }).catch(() => {});
    if (owner.running) {
      owner.running.cancelled = true;
      owner.running.abort.abort();
      request('cancel', { runId: owner.running.id }).catch(() => {});
    }
    owner.dialog?.close('cancel');
    controls?.bar.remove();
    history.length = 0;
  };
}
