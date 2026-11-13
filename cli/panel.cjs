'use strict';

const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');
const { request, selectedConnection, validateConfig } = require('./store.cjs');
const { randomUUID } = require('node:crypto');
const { providers, efforts: apiEfforts } = require('../core/api.cjs');
const providerNames = { codex: '已登录的 Codex', claude: '已登录的 Claude Code', deepseek: 'DeepSeek', anthropic: 'Claude API', 'openai-compatible': 'OpenAI 兼容 API' };
const { builtins } = require('../core/templates.cjs');

// 显示文本不解释模型输出中的终端控制序列，写回仍使用服务端保存的原文。
const display = text => stripVTControlCharacters(String(text ?? '')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const effortName = value => ({ auto: '模型默认', none: '不额外思考', minimal: '很少思考', low: '简单思考', medium: '适中思考', high: '深入思考', xhigh: '更深入思考', max: '最大思考程度', ultra: '最高思考程度' })[value] || value;
const configSummary = config => { const profile = selectedConnection(config); return `供应商：${profile.name} · ${providerNames[profile.provider]}\n模板：${builtins.find(item => item.id === config.template)?.name || config.template} · ${profile.model || '跟随客户端模型'} · ${effortName(profile.reasoningEffort)}\n${config.contextEnabled ? `参考最近 ${config.recentTurns} 轮聊天，最多 ${config.maxContextChars} 字` : '仅使用当前草稿'} · ${config.autoApply ? '直接回填' : '先预览'}`; };
const apiBillingUrl = 'https://platform.openai.com/settings/organization/billing/overview';

function openApiBilling() {
  return new Promise((resolve, reject) => {
    const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', apiBillingUrl], { stdio: 'ignore', windowsHide: true });
    child.once('error', () => reject(new Error(`无法打开浏览器，请访问 ${apiBillingUrl}`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 按终端单元格换行，避免中文和 emoji 把固定操作栏挤出屏幕。
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
function cells(text) {
  return [...segmenter.segment(text)].map(({ segment }) => {
    const point = segment.codePointAt(0);
    const wide = /\p{Emoji_Presentation}|\uFE0F/u.test(segment) || point >= 0x1100 && (
      point <= 0x115f || point >= 0x2329 && point <= 0x232a || point >= 0x2e80 && point <= 0xa4cf ||
      point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff ||
      point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 ||
      point >= 0xffe0 && point <= 0xffe6 || point >= 0x20000 && point <= 0x3fffd);
    return { text: segment, width: /^\p{Mark}+$/u.test(segment) ? 0 : wide ? 2 : 1 };
  });
}
function linesFor(text, width) {
  return display(text).replace(/\r/g, '').replace(/\t/g, '  ').split('\n').flatMap(line => {
    const lines = [];
    let current = '', used = 0;
    for (const cell of cells(line)) {
      if (used + cell.width > width && current) { lines.push(current); current = ''; used = 0; }
      current += cell.text; used += cell.width;
    }
    lines.push(current);
    return lines;
  });
}
const textWidth = text => cells(text).reduce((width, cell) => width + cell.width, 0);

class Panel {
  constructor(run) {
    this.run = run;
    this.busy = true;
    this.stream = '';
    this.pageSize = 1;
    this.maxOffset = 0;
    this.view = { title: '提示词优化', text: '正在连接…', footer: 'Esc 取消', offset: 0 };
    this.onKey = (text, key) => { this.key(text, key).catch(error => this.fail(error)); };
    this.onResize = () => this.render();
  }

  start() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('预览面板需要交互式终端，请在正常 Codex 终端中按 Ctrl+G。');
    this.inputStarted = true;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', this.onKey);
    process.stdout.on('resize', this.onResize);
    // 先只接管按键；直接回填不打开面板，也不绘制生成进度。
    process.stdout.write('\x1b[?2004h');
  }

  openScreen() {
    if (this.screenOpened || this.closed) return;
    this.screenOpened = true;
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  }

  show(title, text, footer, follow = false) {
    this.view = { title, text, footer, offset: 0, follow };
    this.render();
  }

  render() {
    if (this.closed || !this.screenOpened || !this.inputStarted) return;
    clearTimeout(this.renderTimer);
    this.renderTimer = null;
    const width = Math.max(1, (process.stdout.columns || 80) - 1);
    const rows = process.stdout.rows || 24;
    if (width < 24 || rows < 8) {
      const message = linesFor('请放大终端窗口\nEsc 取消', width).slice(0, rows);
      process.stdout.write('\x1b[?25l\x1b[H' + message.map(line => line + '\x1b[K').join('\r\n') + '\x1b[J');
      return;
    }
    const view = this.view;
    if (view.wrappedText !== view.text || view.width !== width) {
      view.lines = linesFor(view.text, width); view.wrappedText = view.text; view.width = width;
    }
    const footer = linesFor(this.input?.error || view.footer, width);
    // 预留标题、滚动位置及输入行，正文独立滚动。
    const height = Math.max(1, rows - 3 - footer.length - (this.input ? 1 : 0));
    const maximum = Math.max(0, view.lines.length - height);
    view.offset = view.follow ? maximum : Math.max(0, Math.min(view.offset, maximum));
    this.pageSize = height;
    this.maxOffset = maximum;
    const body = view.lines.slice(view.offset, view.offset + height);
    while (body.length < height) body.push('');
    const position = maximum ? `${view.offset + 1}–${Math.min(view.offset + height, view.lines.length)}/${view.lines.length}  ↑↓ 滚动 · PgUp/PgDn 翻页` : '';
    const output = [linesFor(view.title, width)[0], '', ...body, linesFor(position, width)[0], ...footer];
    let cursor = 0;
    if (this.input) {
      const input = this.input;
      const prefix = linesFor(input.prompt, Math.max(2, Math.floor(width / 2)))[0];
      let start = input.cursor;
      let before = '';
      const available = width - textWidth(prefix);
      while (start > 0 && textWidth(input.value[start - 1] + before) < available) before = input.value[--start] + before;
      output.push(prefix + linesFor(input.value.slice(start).join(''), Math.max(1, available))[0]);
      cursor = textWidth(prefix + before) + 1;
    }
    process.stdout.write('\x1b[?25l\x1b[H' + output.map(line => line + '\x1b[K').join('\r\n') + '\x1b[J');
    if (this.input) process.stdout.write(`\x1b[${output.length};${cursor}H\x1b[?25h`);
  }

  scroll(key) {
    const steps = { up: -1, down: 1, pageup: -this.pageSize, pagedown: this.pageSize, home: -Infinity, end: Infinity };
    if (!Object.hasOwn(steps, key.name)) return false;
    this.view.offset = Math.max(0, Math.min(this.maxOffset, this.view.offset + steps[key.name]));
    this.view.follow = key.name === 'end';
    this.render();
    return true;
  }

  receive(event) {
    if (event.type === 'opened') {
      this.reviewId = event.reviewId; this.original = event.original; this.state = event; this.direct = event.direct;
      if (!event.direct) this.openScreen();
      this.show('提示词优化', configSummary(event.config), 'S 设置  Esc 取消');
    }
    if (event.type === 'progress') {
      this.busy = true;
      this.stream = '';
      this.progress = event.message.split('\n')[0];
      this.show(event.generating ? '正在生成' : '提示词优化', this.progress, 'S 设置并停止生成  Esc 取消', true);
    }
    if (event.type === 'text') {
      if (this.direct) return;
      if (event.reset) this.stream = '';
      if (this.stream.length + event.text.length <= 100000) {
        this.stream += event.text;
        this.view.text = this.progress + '\n\n' + this.stream;
        if (!this.renderTimer) this.renderTimer = setTimeout(() => { this.renderTimer = null; this.render(); }, 40);
      }
    }
    if (event.type === 'ready') {
      // 生成中主动按 S，才从直接回填切入设置面板。
      this.openScreen();
      this.direct = false;
      this.state = event;
      this.notice = event.error || event.message || '';
      this.stream = '';
      this.busy = false;
      if (event.options) {
        this.busy = true;
        this.settings(event).catch(error => this.fail(error));
      } else this.menu();
    }
  }

  menu(original = false) {
    const state = this.state || {};
    const text = original ? this.original : state.candidate || (state.empty ? '返回 Codex 填写草稿。' : '尚无完整结果，请重新优化或调整设置。');
    const info = !original && state.candidate ? `${state.templateName || ''} · ${state.model || ''}${state.modelMs == null ? '' : ' · ' + (state.modelMs / 1000).toFixed(1) + ' 秒'}\n原文 ${this.original.length} 字 → 结果 ${state.candidate.length} 字\n\n` : '';
    const footer = state.empty ? 'S 设置  Esc 返回 Codex' : (state.candidate ? 'A 应用  R 继续优化  ' : '') + 'O 重新生成  U 恢复\nV 原文  ' + (state.candidate ? 'P 结果  ' : '') + 'S 设置  Esc 返回';
    this.show(original ? '原始输入' : '优化结果', (this.notice ? this.notice + '\n\n' : '') + info + text, footer);
  }

  async choose(choice, extra = {}) {
    if (this.closed) return;
    this.busy = true;
    try {
      await request(this.run, { action: 'review-action', reviewId: this.reviewId, revision: this.state.revision, choice, ...extra });
    } catch (error) { this.fail(error); }
  }

  async key(text, key = {}) {
    if (this.closed) return;
    if (key.sequence === '\x1b[200~') { this.pasting = true; return; }
    if (key.sequence === '\x1b[201~') { this.pasting = false; return; }
    if (this.pasting) {
      if (this.input && text) this.insert(text.replace(/[\r\n]+/g, ' '));
      return;
    }
    const escape = key.name === 'escape' || (key.ctrl && key.name === 'c');
    if (this.input) {
      const input = this.input;
      input.error = '';
      if (escape || key.name === 'return' || key.name === 'enter') {
        this.input = null;
        input.resolve(escape ? null : input.value.join(''));
        this.render();
      } else if (this.scroll(key)) return;
      else if (key.name === 'left') { input.cursor = Math.max(0, input.cursor - 1); this.render(); }
      else if (key.name === 'right') { input.cursor = Math.min(input.value.length, input.cursor + 1); this.render(); }
      else if (key.name === 'backspace') { if (input.cursor) input.value.splice(--input.cursor, 1); this.render(); }
      else if (key.name === 'delete') { input.value.splice(input.cursor, 1); this.render(); }
      else if (key.ctrl && key.name === 'u') { input.value = []; input.cursor = 0; this.render(); }
      else if (!key.ctrl && !key.meta && text) this.insert(text);
      return;
    }
    if (this.scroll(key)) return;
    if (this.busy) {
      if (!key.ctrl && !key.meta && text?.toLowerCase() === 's' && this.reviewId && !this.state?.options) return this.choose('settings');
      if (escape) {
        const view = this.view;
        const result = await request(this.run, { action: 'cancel' });
        if (this.view === view) { view.text = result.message; this.render(); }
      }
      return;
    }
    if (escape) return this.choose('discard');
    if (key.ctrl || key.meta || !text || text.length !== 1) return;
    if (this.state.empty && text.toLowerCase() !== 's') return;
    switch (text.toLowerCase()) {
      case 'a': if (this.state.candidate) return this.choose('apply'); break;
      case 'u': return this.choose('restore');
      case 'o': return this.choose('optimize');
      case 's': return this.choose('settings');
      case 'v': this.menu(true); break;
      case 'p': if (this.state.candidate) this.menu(); break;
      case 'r': {
        if (!this.state.candidate) return;
        this.busy = true;
        this.show('继续优化', this.state.candidate, 'Enter 继续（留空为继续改善）  Esc 返回');
        const instructions = await this.ask('修改要求：');
        if (this.closed) return;
        if (instructions === null) { this.busy = false; this.menu(); return; }
        if (instructions.length > 4000) throw new Error('修改要求不能超过 4000 字。');
        return this.choose('continue', { instructions });
      }
    }
  }

  insert(text) {
    const value = cells(display(text).replace(/[\r\n\t]/g, ' ')).map(cell => cell.text);
    if (this.input.value.join('').length + value.join('').length > 4000) {
      this.input.error = '输入最多 4000 字，请缩短内容。Esc 返回';
      this.render();
      return;
    }
    this.input.error = '';
    this.input.value.splice(this.input.cursor, 0, ...value);
    this.input.cursor += value.length;
    this.render();
  }

  ask(prompt, initial = '') {
    const value = cells(display(initial)).map(cell => cell.text);
    return new Promise(resolve => { this.input = { prompt, value, cursor: value.length, resolve }; this.render(); });
  }

  async connections(config) {
    const choice = await this.select('供应商连接', [
      { id: '', name: '默认 Codex' }, ...config.connections.map(item => ({ id: item.id, name: item.name, description: providerNames[item.provider] + ' · ' + (item.model || '客户端默认') })),
      { id: 'new', name: '新增连接' }, ...(config.connection ? [{ id: 'edit', name: '编辑当前连接' }] : []),
    ], config.connection);
    if (!['new', 'edit'].includes(choice)) { config.connection = choice; return; }
    const profile = choice === 'edit' ? { ...selectedConnection(config) } : { id: randomUUID(), name: '', provider: 'codex', model: '', reasoningEffort: 'auto' };
    const previousModel = profile.model;
    this.show('供应商连接', '', 'Enter 确认  Esc 放弃');
    const name = await this.ask('连接名称：', profile.name);
    if (name === null || this.closed) return;
    profile.name = name.trim();
    const provider = await this.select('供应商类型', Object.entries(providerNames).map(([id, name]) => ({ id, name })), profile.provider);
    if (provider !== profile.provider) { profile.model = ''; profile.reasoningEffort = 'auto'; delete profile.apiBaseUrl; delete profile.apiKeyEnv; delete profile.executable; }
    profile.provider = provider;
    const fields = provider === 'claude' ? [['executable', 'Claude Code .exe 路径：', '']]
      : providers.includes(provider) ? [
        ['apiBaseUrl', 'API 地址：', provider === 'deepseek' ? 'https://api.deepseek.com' : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1'],
        ['apiKeyEnv', '密钥环境变量名：', provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'],
        ['model', '模型 ID：', ''],
      ] : [];
    for (const [key, label, fallback] of fields) {
      this.show('供应商连接', key === 'apiKeyEnv' ? '只填写变量名，不填写 API Key；环境变量需在启动入口前设置。' : '', 'Enter 确认  Esc 放弃');
      const value = await this.ask(label, profile[key] || fallback);
      if (value === null || this.closed) return;
      profile[key] = value.trim();
    }
    if (provider === 'openai-compatible') profile.tokenLimitParameter = await this.select('输出长度参数', [{ id: 'max_tokens', name: 'max_tokens' }, { id: 'max_completion_tokens', name: 'max_completion_tokens' }], profile.tokenLimitParameter || 'max_tokens');
    if (profile.model !== previousModel) profile.reasoningEffort = 'auto';
    const connections = config.connections.filter(item => item.id !== profile.id).concat(profile);
    Object.assign(config, validateConfig({ ...config, connections, connection: profile.id }));
  }

  async select(title, options, current) {
    const text = options.map((item, index) => `${index + 1}. ${item.name}${item.id === current ? '（当前）' : ''}${item.description ? '\n   ' + item.description : ''}`).join('\n\n');
    this.show(title, text, 'Enter 确认序号（留空保持）  Esc 返回');
    while (true) {
      const answer = await this.ask('序号：');
      if (this.closed) return current;
      if (answer === null || !answer.trim()) return current;
      const index = Number(answer.trim()) - 1;
      if (Number.isInteger(index) && options[index]) return options[index].id;
      this.view.footer = '序号不在列表中，请重新输入。Enter 确认  Esc 返回';
    }
  }

  async settings(event) {
    const config = JSON.parse(JSON.stringify(event.options.draftConfig || event.config));
    config.connections ||= []; config.connection ||= '';
    const { templates } = event.options;
    let catalog;
    let notice = event.error || (this.restartRequired ? '设置可保存；优化草稿前请退出并用 codex resume 重启入口。' : '');
    while (!this.closed) {
      const profile = config.connections.find(item => item.id === config.connection) || config;
      const provider = profile.provider || 'codex';
      const dirty = JSON.stringify(config) !== JSON.stringify(event.config);
      const text = [
        `1  模板       ${templates.find(item => item.id === config.template)?.name || config.template}`,
        `2  模型       ${profile.model || '跟随客户端模型'}`,
        `3  思考程度   ${effortName(profile.reasoningEffort)}`,
        `4  参考聊天   ${config.contextEnabled ? '开启' : '关闭'}`,
        `5  应用方式   ${config.autoApply ? '直接回填' : '先预览'}`,
        '6  API 余额（官方账单页）',
        `7  供应商     ${selectedConnection(config).name}`,
      ].join('\n\n');
      this.show(`优化设置${dirty ? ' · 未保存' : ''}`, (notice ? notice + '\n\n' : '') + text, '输入序号调整  Enter 保存并返回  Esc 放弃');
      notice = '';
      const choice = await this.ask('序号：');
      if (this.closed) return;
      if (choice === null) return this.choose(event.empty ? 'discard' : 'back');
      if (!choice.trim()) return this.choose(dirty ? 'configure' : 'back', dirty ? { config } : {});
      if (choice.trim() === '7') {
        if (this.restartRequired) { notice = '供应商切换需要先退出并重新启动优化入口。'; continue; }
        try { await this.connections(config); } catch (error) { notice = error.message; }
        catalog = null;
        continue;
      }
      if (providers.includes(provider) && ['2', '3'].includes(choice.trim())) {
        if (choice.trim() === '2') {
          this.show('API 模型', '', 'Enter 确认  Esc 返回');
          const model = await this.ask('模型 ID：', profile.model);
          if (model !== null && model.trim() !== profile.model) { profile.model = model.trim(); profile.reasoningEffort = 'auto'; }
        } else profile.reasoningEffort = await this.select('API 思考程度（需服务商支持）', ['auto', ...apiEfforts.filter(id => provider === 'anthropic' ? id !== 'minimal' : provider === 'deepseek' ? ['none', 'low', 'high', 'max'].includes(id) : true)].map(id => ({ id, name: effortName(id) })), profile.reasoningEffort);
        continue;
      }
      if (choice.trim() === '6') {
        try { await openApiBilling(); notice = '已请求打开官方 API 账单页。'; }
        catch (error) { notice = error.message; }
        continue;
      }
      if (['2', '3'].includes(choice.trim()) && !catalog) {
        this.show('选择模型', '正在读取模型目录…', 'Esc 取消');
        try { catalog = await request(this.run, { action: 'review-models', reviewId: this.reviewId, config }, 0); }
        catch (error) { notice = error.message; continue; }
        if (this.closed) return;
      }
      if (choice.trim() === '1') {
        config.template = await this.select('选择优化模板', templates, config.template);
      } else if (choice.trim() === '2') {
        const model = await this.select('选择优化模型', [{ id: '', name: `跟随客户端（${catalog.effectiveModel || providerNames[provider]}）` }, ...catalog.models.map(item => ({ id: item.model, name: item.model }))], profile.model);
        if (model !== profile.model) { profile.model = model; profile.reasoningEffort = 'auto'; }
      } else if (choice.trim() === '3') {
        const model = catalog.models.find(item => item.model === (profile.model || catalog.effectiveModel));
        const efforts = model?.supportedReasoningEfforts.map(item => item.reasoningEffort) || [];
        profile.reasoningEffort = await this.select('选择思考程度', ['auto', ...efforts.filter(item => item !== 'auto')].map(id => ({ id, name: effortName(id) })), profile.reasoningEffort);
      } else if (choice.trim() === '4') config.contextEnabled = await this.select('参考聊天', [
        { id: true, name: '开启', description: `参考最近 ${config.recentTurns} 轮，最多 ${config.maxContextChars} 字。` },
        { id: false, name: '关闭', description: '仅优化当前草稿。' },
      ], config.contextEnabled);
      else if (choice.trim() === '5') config.autoApply = !config.autoApply;
      else notice = '请输入 1–7，或按 Enter 保存。';
    }
  }

  fail(error) {
    if (this.closed) return;
    this.busy = false;
    this.notice = error.message;
    this.menu();
  }

  close() {
    this.closed = true;
    clearTimeout(this.renderTimer);
    this.input?.resolve(null);
    this.input = null;
    process.stdin.removeListener('keypress', this.onKey);
    process.stdout.removeListener('resize', this.onResize);
    if (this.inputStarted) {
      try {
        process.stdout.write('\x1b[?2004l\x1b[?25h' + (this.screenOpened ? '\x1b[?1049l' : ''));
      } finally {
        // Codex 交接编辑器时保持 raw；Node 初始 isRaw=false 不是系统模式快照。
        // 不据此切回行输入，停止并释放本进程的读取，由 Codex 恢复其终端模式。
        process.stdin.pause();
        process.stdin.destroy();
      }
    }
  }
}

module.exports = { Panel, display, configSummary, apiBillingUrl, openApiBilling };
