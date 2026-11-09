#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { home, readJson, writeJson, runFile, request } = require('./store.cjs');
const { Panel, display } = require('./panel.cjs');

(async () => {
  const id = process.env.CPO_RUN_ID;
  const run = await readJson(runFile(id));
  if (!run || run.id !== id) throw new Error('优化入口已失效，请重新运行 start。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const panel = new Panel(run);
  let result;
  try {
    // 直接回填时也接管等待期间的按键，避免排队的 Enter 回到主聊天后提交草稿。
    panel.start();
    const status = await request(run, { action: 'status' }, 10000, controller.signal);
    if (status.editorProtocol !== 3) throw new Error('增强入口已更新，请退出当前增强入口后重新启动一次。');
    const direct = status.autoApply;
    result = await request(run, { action: 'review', filename: process.argv[2], direct }, 0, controller.signal, event => panel.receive(event));
  } finally { panel.close(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  if (result && (!result.applied || panel.screenOpened)) process.stdout.write(display(result.message) + '\n');
})().catch(async error => {
  process.stderr.write(error.message + '\n');
  try { await writeJson(path.join(home, 'errors', process.env.CPO_RUN_ID + '.json'), { at: new Date().toISOString(), message: error.message }); } catch {}
  process.exitCode = 1;
});
