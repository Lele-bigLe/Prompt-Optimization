'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const compatibility = require('./compatibility.json');

const bridgePath = 'webview/assets/cpo-bridge.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let changing = false;

async function withBridgeLock(storage, action) {
  if (changing) throw new Error('正在更新输入框按钮，请稍后重试。');
  changing = true;
  let lock;
  const lockPath = path.join(storage, 'bridge.lock');
  try {
    await fs.mkdir(storage, { recursive: true });
    try { lock = await fs.open(lockPath, 'wx'); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`另一个窗口正在更新桥接，或上次操作异常中断。请检查 ${lockPath}。`);
      throw error;
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    try { if (lock) { await lock.close(); await fs.unlink(lockPath); } }
    finally { changing = false; }
  }
}

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Codex 文件结构不匹配，未应用桥接。');
  return source.replace(anchor, replacement);
}

function patchedSource(relativePath, source) {
  if (relativePath === 'out/extension.js') {
    const anchor = 'let a=e.onDidReceiveMessage(l=>{if(s.markMessageReceived(),';
    const forwarder = 'let a=e.onDidReceiveMessage(l=>{if(l?.type==="cpo:request"){s.markMessageReceived();void Promise.resolve().then(()=>{let p=require("vscode").extensions.getExtension("local-codex-tools.codex-prompt-optimizer-native");if(!p)throw Error("Prompt optimizer unavailable");return p.activate()}).then(api=>api.handleBridgeRequest(l.payload,message=>this.postMessageToWebview(e,message))).then(payload=>this.postMessageToWebview(e,{type:"cpo:response",id:l.id,payload}),()=>this.postMessageToWebview(e,{type:"cpo:response",id:l.id,payload:{ok:false,error:"提示词优化扩展不可用，请检查是否已安装并启用。"}}));return}if(s.markMessageReceived(),';
    return replaceOnce(source, anchor, forwarder);
  }
  const anchor = 'let ky;return t[1366]';
  // 使用当前 composer 的作用域和编辑器控制器；不从全局“最近窗口”猜会话。
  // 状态在 bridge 模块独立导入，避免被 composer 内同名的压缩局部变量遮蔽。
  const hook = '(0,CZ.useLayoutEffect)(()=>__cpoBind({controller:Q,identity:()=>({threadId:vv(J),hostId:J.get(tc,vv(J)),imageHostId:kt.hostId,scopeKind:J.value.kind,routeKey:xt.key}),images:()=>__cpoImages(J),turns:limit=>{let threadId=vv(J);return threadId==null?[]:__cpoTurns(J,{hostId:J.get(tc,threadId),threadId},limit)}}),[Q,J,X,yt,xt.key,kt.hostId]);';
  return 'import{bindComposer as __cpoBind,readTurns as __cpoTurns,readImages as __cpoImages}from"./cpo-bridge.mjs";\n' + replaceOnce(source, anchor, hook + anchor);
}

async function prepareFiles(extensionRoot) {
  const files = [];
  for (const [relativePath, expectedHash] of Object.entries(compatibility.files)) {
    const original = await fs.readFile(path.join(extensionRoot, relativePath));
    if (digest(original) !== expectedHash) throw new Error('Codex 源文件校验不匹配，未修改扩展。');
    files.push({ path: relativePath, original, patched: Buffer.from(patchedSource(relativePath, original.toString('utf8'))) });
  }
  return files;
}

async function readState(storage) {
  try { return JSON.parse(await fs.readFile(path.join(storage, 'bridge-state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writeAtomic(filename, contents) {
  const temporary = `${filename}.cpo-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: 'wx' });
    await fs.rename(temporary, filename);
  } finally {
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function enableBridge(extensionRoot, storage) {
  return withBridgeLock(storage, async () => {
    const version = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8')).version;
    if (version !== compatibility.extensionVersion) throw new Error(`当前仅适配 Codex ${compatibility.extensionVersion}；检测到 ${version}，未修改扩展。`);
    const previous = await readState(storage);
    if (previous?.enabled) {
      if (previous.extensionRoot !== extensionRoot) throw new Error('存在其他 Codex 版本的桥接备份，请先移除旧桥接。');
      for (const file of previous.files) {
        if (digest(await fs.readFile(path.join(extensionRoot, file.path))) !== file.patchedHash) {
          throw new Error('Codex 文件已被更新或修改，请先处理旧桥接备份。');
        }
      }
      const installedBridge = await fs.readFile(path.join(extensionRoot, bridgePath));
      if (digest(installedBridge) !== previous.bridgeHash || digest(await fs.readFile(path.join(__dirname, 'bridge.mjs'))) !== previous.bridgeHash) {
        throw new Error('桥接脚本已变化，请先移除按钮后重新启用。');
      }
      return;
    }
    const files = await prepareFiles(extensionRoot);
    try { await fs.access(path.join(extensionRoot, bridgePath)); throw new Error('目标桥接文件已存在，未覆盖。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bridge = await fs.readFile(path.join(__dirname, 'bridge.mjs'));
    const backupName = `bridge-backup-${Date.now()}-${randomUUID()}`;
    const backup = path.join(storage, backupName);
    await fs.mkdir(backup, { recursive: true });
    const state = {
      version, extensionRoot, backupName, enabled: true,
      files: files.map((file, index) => ({ path: file.path, backup: `${index}.original`, originalHash: digest(file.original), patchedHash: digest(file.patched) })),
      bridgeHash: digest(bridge),
    };
    for (let i = 0; i < files.length; i++) await fs.writeFile(path.join(backup, state.files[i].backup), files[i].original, { flag: 'wx' });
    // 先保存恢复资料；任何安装失败都保留原文件备份。
    await writeAtomic(path.join(storage, 'bridge-state.json'), JSON.stringify(state, null, 2));
    const written = [];
    let bridgeWritten = false;
    try {
      await fs.writeFile(path.join(extensionRoot, bridgePath), bridge, { flag: 'wx' });
      bridgeWritten = true;
      for (const file of files) {
        if (digest(await fs.readFile(path.join(extensionRoot, file.path))) !== digest(file.original)) throw new Error('Codex 文件在更新期间发生变化。');
        await writeAtomic(path.join(extensionRoot, file.path), file.patched);
        written.push(file);
      }
    } catch (error) {
      let recovered = true;
      for (const file of written.reverse()) {
        const target = path.join(extensionRoot, file.path);
        if (digest(await fs.readFile(target)) === digest(file.patched)) await writeAtomic(target, file.original);
        else recovered = false;
      }
      if (bridgeWritten && recovered && digest(await fs.readFile(path.join(extensionRoot, bridgePath))) === state.bridgeHash) await fs.unlink(path.join(extensionRoot, bridgePath));
      state.enabled = !recovered;
      await writeAtomic(path.join(storage, 'bridge-state.json'), JSON.stringify(state, null, 2));
      throw new Error(`${error.message} 原文件备份位于 ${backup}。`);
    }
  });
}

async function disableBridge(storage) {
  return withBridgeLock(storage, async () => {
    const state = await readState(storage);
    if (!state?.enabled) throw new Error('没有已启用的输入框桥接。');
    // 升级适配后仍按旧版的固定清单恢复，不能用新版路径校验旧备份。
    const files = state.version === compatibility.extensionVersion ? compatibility.files
      : Object.hasOwn(compatibility.restoreOnly, state.version) ? compatibility.restoreOnly[state.version] : null;
    if (!files || !/^bridge-backup-[\d]+-[a-f\d-]+$/.test(state.backupName)) throw new Error('桥接恢复记录不匹配，未恢复文件。');
    const restored = [];
    for (const [index, relativePath] of Object.keys(files).entries()) {
      const file = state.files[index];
      if (file?.path !== relativePath || file.backup !== `${index}.original` || file.originalHash !== files[relativePath]) throw new Error('桥接恢复路径不匹配。');
      const original = await fs.readFile(path.join(storage, state.backupName, file.backup));
      if (digest(original) !== files[relativePath]) throw new Error('原文件备份校验失败。');
      const target = path.join(state.extensionRoot, relativePath);
      const currentHash = digest(await fs.readFile(target));
      if (currentHash !== file.patchedHash && currentHash !== file.originalHash) throw new Error('Codex 文件已被更新或再次修改，未覆盖新文件。');
      restored.push({ target, original, expectedHash: currentHash });
    }
    const bridge = path.join(state.extensionRoot, bridgePath);
    if (digest(await fs.readFile(bridge)) !== state.bridgeHash) throw new Error('桥接文件已变化，未删除。');
    for (const file of restored) {
      if (digest(await fs.readFile(file.target)) !== file.expectedHash) throw new Error('Codex 文件在恢复期间发生变化，已停止恢复。');
      await writeAtomic(file.target, file.original);
    }
    await fs.unlink(bridge);
    state.enabled = false;
    await writeAtomic(path.join(storage, 'bridge-state.json'), JSON.stringify(state, null, 2));
  });
}

module.exports = { enableBridge, disableBridge, prepareFiles, readState };
