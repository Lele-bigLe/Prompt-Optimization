'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { CodexAgent } = require('../core/codex.cjs');
const { builtins } = require('../core/templates.cjs');
const { home, writeJson, validateConfig } = require('./store.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const markers = value => value.match(/\[Image #\d+\]/g) || [];

class Runtime {
  constructor(bridge, executable, config, runId) {
    this.bridge = bridge; this.config = config; this.runId = runId;
    this.agent = new CodexAgent(executable, path.join(home, 'optimizer-workspace'));
    this.entries = new Map();
    this.bridge.on('changed', () => {
      if (this.review?.settingsOnly) return;
      this.job?.abort(); this.review?.controller.abort();
    });
  }

  status() {
    return { id: this.runId, editorProtocol: 4, autoApply: this.config.autoApply, cwd: this.bridge.binding?.cwd || null, threadId: this.bridge.binding?.id || null, busy: Boolean(this.job), reviewing: Boolean(this.review), model: this.config.model || this.bridge.binding?.model || '按 Codex 当前配置', reasoningEffort: this.config.reasoningEffort, template: this.config.template, pendingAction: this.next?.action || 'optimize' };
  }

  queue(action, instructions = '') {
    const binding = action === 'settings' ? null : this.bridge.current();
    if (this.review) throw new Error('预览面板已打开，请直接在面板中继续优化或恢复原文。');
    if (!['undo', 'continue', 'settings'].includes(action)) throw new Error('不支持的操作。');
    if (typeof instructions !== 'string' || instructions.length > 4000) throw new Error('修改要求不能超过 4000 字。');
    if (action !== 'settings' && !this.entries.has(binding.id)) throw new Error('这个对话在本次入口中还没有可继续或恢复的优化。');
    this.next = { action, instructions, threadId: binding?.id, generation: binding?.generation };
    return { message: `已准备${action === 'settings' ? '打开设置（保留草稿）' : action === 'undo' ? '恢复原文' : '继续优化'}，请回到对应 Codex 按 Ctrl+G。`, ...this.status() };
  }

  async context(binding, signal) {
    if (!this.config.contextEnabled) return { messages: [], digest: hash('context-disabled') };
    if (binding.empty) return { messages: [], digest: hash(JSON.stringify([])) };
    let page;
    try {
      page = await this.bridge.rpc('thread/turns/list', { threadId: binding.id, limit: this.config.recentTurns, sortDirection: 'desc', itemsView: 'full' }, signal);
    } catch (error) {
      if (error.code !== -32601) throw error;
      // 已加载的存储实现可能不支持分页；独立连接按同一 ID 读取持久化历史，不 resume。
      await this.agent.connect();
      if (signal?.aborted) throw error;
      const metadata = await this.agent.rpc('thread/read', { threadId: binding.id, includeTurns: false });
      if (metadata.thread?.id !== binding.id) throw error;
      if (metadata.thread.historyMode === 'legacy') {
        const result = await this.agent.rpc('thread/read', { threadId: binding.id, includeTurns: true });
        if (result.thread?.id !== binding.id || !Array.isArray(result.thread.turns)) throw error;
        page = { data: result.thread.turns.slice(-this.config.recentTurns).reverse() };
      } else {
        page = await this.agent.rpc('thread/turns/list', { threadId: binding.id, limit: this.config.recentTurns, sortDirection: 'desc', itemsView: 'full' });
      }
      if (signal?.aborted) throw error;
    }
    if (!Array.isArray(page.data)) throw new Error('当前 Codex 未返回可用聊天记录，请检查 CLI 版本。');
    const messages = [];
    for (const turn of [...page.data].reverse()) {
      if (!Array.isArray(turn.items)) throw new Error('聊天记录未包含完整消息，未修改草稿。');
      for (const item of turn.items) {
        let text;
        let role;
        if (item.type === 'userMessage') {
          role = 'user';
          text = (item.content || []).map(part => part.type === 'text' ? part.text : ['image', 'localImage'].includes(part.type) ? '[对话中有图片，本次未读取原图]' : '').filter(Boolean).join('\n');
        } else if (item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')) { role = 'assistant'; text = item.text; }
        if (typeof text === 'string' && text.trim()) messages.push({ role, text });
      }
    }
    // 先为用户要求预留一半预算，再填助手回复；输出仍保持原先的时间顺序。
    let remaining = this.config.maxContextChars;
    const selected = new Map();
    for (const [role, budget] of [['user', Math.floor(remaining / 2)], ['assistant', remaining], ['user', remaining]]) {
      let available = Math.min(budget, remaining);
      for (let index = messages.length - 1; index >= 0 && available > 0; index--) {
        const message = messages[index];
        if (message.role !== role) continue;
        const retained = selected.get(index)?.text || '';
        const count = Math.min(message.text.length - retained.length, available);
        if (count <= 0) continue;
        selected.set(index, { role, text: message.text.slice(-(retained.length + count)) });
        available -= count; remaining -= count;
      }
    }
    const bounded = [...selected].sort(([a], [b]) => a - b).map(([, message]) => message);
    return { messages: bounded, digest: hash(JSON.stringify(bounded)) };
  }

  async draftFile(filename) {
    const root = await fs.realpath(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'editor'));
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.extname(filename).toLowerCase() !== '.md') throw new Error('只接受 Codex 原生编辑器创建的草稿文件。');
    const actual = await fs.realpath(filename);
    const relative = path.relative(root, actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('草稿不在 Codex 的临时编辑目录内。');
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > 400000) throw new Error('草稿文件不正确或超过大小限制。');
    const draft = await fs.readFile(actual, 'utf8');
    if (draft.length > 100000) throw new Error('草稿超过单次 100000 字的限制。');
    return { filename: actual, draft };
  }

  catalog() {
    return this.agent.models.length ? Promise.resolve({ models: this.agent.models, configuredModel: this.agent.configuredModel }) : this.agent.catalog();
  }

  async modelOptions(reviewId) {
    const work = this.review;
    if (!work || work.id !== reviewId || !work.waiter || this.job) throw new Error('面板状态已变化，请重新打开设置。');
    const catalog = await this.runJob(work, () => this.catalog());
    return { models: catalog.models, effectiveModel: work.binding?.model || this.bridge.binding?.model || catalog.configuredModel || catalog.models.find(item => item.isDefault)?.model };
  }

  assertCurrent(work) {
    if (work.controller.signal.aborted || !work.settingsOnly && this.bridge.current().generation !== work.binding.generation) throw new Error('预览已结束或当前对话发生变化，请重新按 Ctrl+G。');
  }

  async runJob(work, execute) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    controller.signal.addEventListener('abort', () => this.agent.dispose(), { once: true });
    work.controller.signal.addEventListener('abort', abort, { once: true });
    this.job = controller;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.config.timeoutSeconds * 1000);
    try {
      this.assertCurrent(work);
      const result = await execute(controller);
      if (controller.signal.aborted) throw new Error('优化已取消或超时。');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw Object.assign(new Error(timedOut ? '优化超时；草稿未改动。' : '优化已取消；草稿未改动。'), { code: timedOut ? 'TIMEOUT' : 'CANCELLED' });
      throw error;
    } finally { clearTimeout(timer); work.controller.signal.removeEventListener('abort', abort); this.job = null; }
  }

  async generate(work, continuing, instructions, notify) {
    let session;
    try {
      return await this.runJob(work, async controller => {
        this.assertCurrent(work);
        notify({ type: 'progress', message: this.config.contextEnabled ? '正在读取参考聊天…' : '仅使用当前草稿…' });
        const context = await this.context(work.binding, controller.signal);
        if (controller.signal.aborted) throw new Error('优化已取消或超时。');
        notify({ type: 'progress', message: '正在准备优化模型…' });
        const catalog = await this.catalog();
        if (controller.signal.aborted) throw new Error('优化已取消或超时。');
        const modelId = this.config.model || work.binding.model || catalog.configuredModel || catalog.models.find(model => model.isDefault)?.model;
        const model = catalog.models.find(item => item.model === modelId);
        if (!model) throw new Error('未找到可用优化模型，请在面板设置中选择模型。');
        const template = builtins.find(item => item.id === this.config.template);
        if (!template) throw new Error('优化模板不存在，请在面板设置中重新选择。');
        const fingerprint = hash(JSON.stringify({ ...this.config, autoApply: undefined, model: modelId }));
        const previous = work.entry;
        const reused = continuing && previous && previous.contextHash === context.digest && previous.configHash === fingerprint;
        if (previous && !reused) this.agent.releaseSession(previous.session);
        session = reused ? previous.session : {};
        const input = { draft: work.original, context: context.messages, images: [], draftImageCount: 0,
          ...(continuing && previous ? { revision: { previousPrompt: previous.candidate, instructions } } : {}),
        };
        const configuredTemplate = { ...template, systemPrompt: template.systemPrompt + '\n草稿中的 [Image #数字] 是原生附件占位，必须原样保留，不能新增、删除或改编号。本次未提供原图，不要声称理解了图片内容。' };
        notify({ type: 'progress', generating: true, message: `正在优化 · ${modelId} · ${template.name} · 参考 ${context.messages.length} 条消息\nS 设置并停止本次生成  Esc 取消` });
        const result = await this.agent.optimize(input, { ...this.config, provider: 'codex', model: modelId, supportsImages: false, template: configuredTemplate }, controller.signal, session,
          chunk => { if (!controller.signal.aborted) notify({ type: 'text', ...chunk }); });
        if (JSON.stringify(markers(result.text)) !== JSON.stringify(markers(work.draft))) throw new Error('模型改变了图片附件占位，请重试。');
        if ((await this.context(work.binding, controller.signal)).digest !== context.digest) throw new Error('优化期间参考聊天发生变化，请返回后重新打开面板。');
        this.assertCurrent(work);
        if (controller.signal.aborted) throw new Error('优化已取消或超时。');
        if (await fs.readFile(work.filename, 'utf8') !== work.draft) throw new Error('优化期间草稿文件发生变化，没有覆盖。');
        work.entry = { original: work.original, candidate: result.text, templateName: template.name, contextHash: context.digest, configHash: fingerprint, session, model: modelId, modelMs: result.modelMs, sessionReused: result.sessionReused, updatedAt: new Date().toISOString() };
      });
    } catch (error) {
      if (session) this.agent.releaseSession(session);
      throw error;
    }
  }

  async apply(work, restore) {
    // 取消订阅后收不到完整生命周期通知，写回前再次只读核对原对话状态。
    await this.bridge.currentReady();
    this.assertCurrent(work);
    if (!restore && !work.entry) throw new Error('还没有可应用的优化结果。');
    const text = restore ? work.original : work.entry.candidate;
    if (!restore && text !== work.draft && (await this.context(work.binding, work.controller.signal)).digest !== work.entry.contextHash) throw new Error('参考聊天或上下文设置已变化，请重新优化后再应用。');
    if (await fs.readFile(work.filename, 'utf8') !== work.draft) throw new Error('草稿已经改变，没有覆盖。');
    const backups = Object.fromEntries([...this.entries].map(([id, value]) => [id, { original: value.original, candidate: value.candidate, model: value.model, updatedAt: value.updatedAt }]));
    backups[work.binding.id] = restore ? { original: work.original, candidate: work.draft, restoredTo: text, updatedAt: new Date().toISOString() }
      : { original: work.original, candidate: text, model: work.entry.model, updatedAt: work.entry.updatedAt };
    await writeJson(path.join(home, 'backups', this.runId + '.json'), backups);
    this.assertCurrent(work);
    if (await fs.readFile(work.filename, 'utf8') !== work.draft) throw new Error('写回前草稿发生变化，没有覆盖。');
    const temporary = work.filename + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
      this.assertCurrent(work);
      if (await fs.readFile(work.filename, 'utf8') !== work.draft) throw new Error('写回前草稿发生变化，没有覆盖。');
      await fs.rename(temporary, work.filename);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    const old = this.entries.get(work.binding.id);
    if (old && old.session !== work.entry?.session) this.agent.releaseSession(old.session);
    this.entries.delete(work.binding.id);
    if (restore) { if (work.entry) this.agent.releaseSession(work.entry.session); }
    else {
      this.entries.set(work.binding.id, work.entry); work.retained = true;
      if (this.entries.size > 8) { const id = this.entries.keys().next().value; this.agent.releaseSession(this.entries.get(id).session); this.entries.delete(id); }
    }
    return { applied: true, restored: restore, imageCount: markers(text).length, message: restore ? '已恢复原文，尚未发送。' : '已填回草稿，尚未发送。' };
  }

  action(message) {
    const work = this.review;
    if (!work || work.id !== message.reviewId || work.revision !== message.revision) throw new Error('预览已更新，请使用当前面板。');
    this.assertCurrent(work);
    if (message.choice === 'settings' && this.job && !work.waiter) {
      work.interrupt = 'settings';
      this.job.abort();
      return { accepted: true };
    }
    if (this.job) throw new Error('正在读取模型目录，请稍候或按 Esc 取消。');
    if (!work.waiter) throw new Error('正在处理，请等待完成；生成期间可按 Esc 取消。');
    if (!['optimize', 'continue', 'apply', 'restore', 'discard', 'settings', 'configure', 'back'].includes(message.choice)) throw new Error('不支持的面板操作。');
    if (!work.draft.trim() && !['discard', 'settings', 'configure', 'back'].includes(message.choice)) throw new Error('输入框为空，请先返回 Codex 填写需要优化的草稿。');
    if (message.choice === 'continue' && !work.entry) throw new Error('请先生成一版优化结果。');
    if (message.choice === 'continue' && (typeof message.instructions !== 'string' || message.instructions.length > 4000)) throw new Error('修改要求不能超过 4000 字。');
    const accept = work.waiter; work.waiter = null; accept(message);
    return { accepted: true };
  }

  async configure(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('优化设置不正确。');
    const next = validateConfig({ ...this.config, model: config.model, reasoningEffort: config.reasoningEffort, template: config.template, contextEnabled: config.contextEnabled, autoApply: config.autoApply });
    if (next.model !== this.config.model || next.reasoningEffort !== this.config.reasoningEffort) {
      const catalog = await this.runJob(this.review, () => this.catalog());
      const modelId = next.model || this.review.binding?.model || this.bridge.binding?.model || catalog.configuredModel || catalog.models.find(item => item.isDefault)?.model;
      const model = catalog.models.find(item => item.model === modelId);
      if (!model) throw new Error('请选择模型目录中可用的模型。');
      if (next.reasoningEffort !== 'auto' && !model.supportedReasoningEfforts.some(item => item.reasoningEffort === next.reasoningEffort)) throw new Error('当前模型不支持这个思考程度。');
    }
    if (!builtins.some(item => item.id === next.template)) throw new Error('所选模板不存在。');
    await writeJson(path.join(home, 'config.json'), next);
    this.config = next;
  }

  async openReview(filename, signal, notify, direct = false) {
    if (this.review) throw new Error('这个入口已有预览面板，请先关闭原面板。');
    // 先占用编辑入口并读取草稿；空草稿的设置不依赖聊天已经建立。
    const work = { id: randomUUID(), settingsOnly: true, revision: 0, controller: new AbortController() };
    this.review = work;
    const abort = () => { work.controller.abort(); this.job?.abort(); work.waiter?.({ choice: 'discard' }); work.waiter = null; };
    signal.addEventListener('abort', abort, { once: true });
    const changed = () => { work.waiter?.({ choice: 'discard' }); work.waiter = null; };
    work.controller.signal.addEventListener('abort', changed, { once: true });
    try {
      if (signal.aborted) abort();
      Object.assign(work, await this.draftFile(filename));
      const empty = !work.draft.trim();
      const binding = empty ? null : await this.bridge.currentReady();
      work.binding = binding;
      work.settingsOnly = empty;
      this.assertCurrent(work);
      const pending = empty ? null : this.next; this.next = null;
      if (pending && pending.action !== 'settings' && (pending.threadId !== binding?.id || pending.generation !== binding?.generation)) throw new Error('准备操作后对话已变化，请重新选择操作。');
      const previous = binding ? this.entries.get(binding.id) : null;
      if (pending && pending.action !== 'settings' && (!previous || previous.candidate !== work.draft)) throw new Error('草稿已经改变，请直接在预览面板中重新优化。');
      work.previous = previous;
      work.entry = previous?.candidate === work.draft ? previous : null;
      work.original = work.entry?.original || work.draft;
      direct = direct && !empty && pending?.action !== 'settings';
      notify({ type: 'opened', reviewId: work.id, revision: 0, draft: work.draft, original: work.original, empty, direct, config: this.config });
      const initial = empty || pending?.action === 'settings' ? 'settings' : work.entry ? (direct ? 'continue' : 'back') : 'optimize';
      let action = pending?.action === 'undo' ? { choice: 'restore' }
        : pending?.action === 'continue' ? { choice: 'continue', instructions: pending.instructions }
          : { choice: initial };
      while (true) {
        this.assertCurrent(work);
        let error;
        let message;
        let options;
        try {
          if (action.choice === 'discard') return { applied: false, message: '已返回 Codex，草稿未改动。' };
          if (['optimize', 'continue'].includes(action.choice)) await this.generate(work, action.choice === 'continue', action.instructions || '', notify);
          if (action.choice === 'apply' || action.choice === 'restore' || direct) {
            this.writing = true;
            try { return await this.apply(work, action.choice === 'restore'); }
            finally { this.writing = false; }
          }
          if (action.choice === 'settings') {
            options = { templates: builtins.map(({ id, name, description }) => ({ id, name, description })) };
          }
          if (action.choice === 'configure') { await this.configure(action.config); message = '已保存；应用方式在下次 Ctrl+G 生效，其余设置用于下次优化。'; }
        } catch (failure) {
          if (work.controller.signal.aborted) throw failure;
          if (work.interrupt === 'settings') {
            notify({ type: 'progress', message: '已停止生成；未完成片段不可应用，草稿未改动。' });
            work.interrupt = null; direct = false; action = { choice: 'settings' }; continue;
          }
          error = failure.message;
          if (action.choice === 'configure') options = { templates: builtins.map(({ id, name, description }) => ({ id, name, description })), draftConfig: action.config };
          await writeJson(path.join(home, 'errors', this.runId + '.json'), { at: new Date().toISOString(), message: error });
          if (direct && failure.code === 'CANCELLED') return { applied: false, cancelled: true, message: '已取消优化，草稿未改动。' };
          if (direct) throw failure;
        }
        this.assertCurrent(work);
        const waiting = new Promise(resolve => { work.waiter = resolve; });
        notify({ type: 'ready', reviewId: work.id, revision: ++work.revision, candidate: work.entry?.candidate || null, model: work.entry?.model,
          templateName: work.entry?.templateName, modelMs: work.entry?.modelMs, sessionReused: work.entry?.sessionReused, empty: !work.draft.trim(), config: this.config, error, message, options });
        action = await waiting;
      }
    } finally {
      signal.removeEventListener('abort', abort); work.controller.signal.removeEventListener('abort', changed);
      if (!work.retained && work.entry && work.entry !== work.previous) this.agent.releaseSession(work.entry.session);
      if (this.review === work) this.review = null;
    }
  }

  cancel() {
    if (this.writing) return { message: '结果已经开始写回，请等待草稿显示后再按 Ctrl+G 恢复原文。' };
    if (this.review && !this.review.waiter && !this.job) return { message: '正在处理面板操作，请稍候。' };
    if (this.job) this.job.abort(); else this.next = null;
    return { message: '已请求取消；尚未写回的草稿保留。' };
  }

  dispose() { this.review?.controller.abort(); this.job?.abort(); this.agent.dispose(); }
}

module.exports = { Runtime };
