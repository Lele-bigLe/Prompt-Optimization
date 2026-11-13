#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
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
    // 保留旧入口的空输入设置；新增供应商配置需要重新启动后加载。
    let legacySettings = false;
    if ([3, 4].includes(status.editorProtocol)) {
      const stat = await fs.stat(process.argv[2]);
      legacySettings = stat.isFile() && stat.size <= 400000 && !(await fs.readFile(process.argv[2], 'utf8')).trim();
    }
    if (status.editorProtocol !== 5 && !legacySettings) {
      throw new Error('优化器仍在运行旧版本。请先保存未发送草稿，退出该 Codex 窗口后用 codex resume 恢复原会话。');
    }
    panel.restartRequired = legacySettings;
    const direct = legacySettings ? false : status.autoApply;
    result = await request(run, { action: 'review', filename: process.argv[2], direct }, 0, controller.signal, event => panel.receive(event));
  } catch (error) {
    if (panel.inputStarted && !controller.signal.aborted) {
      panel.openScreen();
      panel.show('提示词优化未完成', error.message, 'Enter / Esc 返回');
      await panel.ask('');
    }
    throw error;
  } finally { panel.close(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
  if (result && (!result.applied || panel.screenOpened)) process.stdout.write(display(result.message) + '\n');
})().catch(async error => {
  process.stderr.write(error.message + '\n');
  try { await writeJson(path.join(home, 'errors', process.env.CPO_RUN_ID + '.json'), { at: new Date().toISOString(), message: error.message }); } catch {}
  process.exitCode = 1;
});
