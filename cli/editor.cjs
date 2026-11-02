#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { home, readJson, writeJson, runFile, request } = require('./store.cjs');

(async () => {
  const id = process.env.CPO_RUN_ID;
  const run = await readJson(runFile(id));
  if (!run || run.id !== id) throw new Error('优化入口已失效，请重新运行 start。');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    await request(run, { action: 'edit', filename: process.argv[2] }, 360000, controller.signal);
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
})().catch(async error => {
  // 不往主 TUI 插入优化对话；错误可在另一个终端用 last-error 查看。
  try { await writeJson(path.join(home, 'errors', process.env.CPO_RUN_ID + '.json'), { at: new Date().toISOString(), message: error.message }); } catch {}
  process.exitCode = 1;
});
