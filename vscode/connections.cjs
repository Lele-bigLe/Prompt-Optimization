'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createJsonStore } = require('./json-store.cjs');
const { storage } = require('../core/native.cjs');
const { providers, endpointFor } = require('../core/api.cjs');

function createConnections(context, legacy, legacySecretId, executableFor) {
  const directory = context.globalStorageUri.fsPath;
  const source = 'vscode:' + createHash('sha256').update(directory.toLowerCase()).digest('hex');
  const preferenceKey = 'sharedConnectionSelection.v1';
  let selection;
  let initializing;
  let changing = Promise.resolve();
  const transport = profile => JSON.stringify([profile.provider, providers.includes(profile.provider) ? String(endpointFor(profile)) : '', profile.provider === 'claude' ? profile.executable || '' : '']);
  const choice = profile => ({ transport: transport(profile), model: profile.model, reasoningEffort: profile.reasoningEffort, supportsImages: profile.supportsImages, modelMetadata: profile.modelMetadata });
  const effective = profile => {
    const saved = selection.overrides[profile.id];
    if (!saved) return profile;
    const sameTransport = saved.transport === transport(profile);
    return { ...profile, model: saved.model, reasoningEffort: saved.reasoningEffort, supportsImages: sameTransport ? saved.supportsImages : false, modelMetadata: sameTransport ? saved.modelMetadata : undefined };
  };
  async function persist(next = selection) { const saved = { ...next, revision: randomUUID() }; await context.globalState.update(preferenceKey, saved); selection = saved; }

  async function oldStore() {
    const filename = path.join(directory, 'connections.json');
    try { if ((await fs.stat(filename)).size > 1024 * 1024) throw new Error('旧连接配置过大，迁移已停止，原文件保留。'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const store = createJsonStore(directory, 'connections', () => { throw new Error('旧连接配置已变化，请重新打开设置。'); }, state => Array.isArray(state.items) && state.items.length <= 100 && state.items.every(item => item && /^[a-f\d-]{36}$/.test(item.id) && typeof item.name === 'string') && new Set(state.items.map(item => item.id)).size === state.items.length);
    return { store, state: await store.read() };
  }
  async function migrate(pool) {
    const defaults = context.globalState.get(preferenceKey);
    const old = pool.imports[source] && defaults ? null : await oldStore();
    let activeId = old?.state.activeId || null;
    let mapping = pool.imports[source];
    if (!mapping) {
      const transfer = async state => {
        const items = state.items.map(item => ({ ...item }));
        const keys = {};
        for (const profile of items) {
          if (['deepseek', 'anthropic', 'openai-compatible'].includes(profile.provider)) {
            const key = await context.secrets.get('codexPromptOptimizer.connection.' + profile.id);
            if (key) keys[profile.id] = key;
          } else if (profile.provider === 'claude' && !profile.executable) {
            try { profile.executable = await executableFor('claude'); } catch { /* 保留未安装客户端的连接，使用前再设置路径。 */ }
          }
        }
        return storage({ action: 'import', source, items, keys });
      };
      let imported;
      if (old) imported = await old.store.change(old.state.revision, transfer);
      else {
        const current = legacy();
        const items = [];
        const keys = {};
        if (current.provider !== 'choose') {
          const profile = { id: randomUUID(), name: '原有连接', provider: current.provider, apiBaseUrl: current.apiBaseUrl || '', model: current.model || '', reasoningEffort: current.reasoningEffort, supportsImages: current.supportsImages, tokenLimitParameter: 'max_tokens' };
          if (['deepseek', 'anthropic', 'openai-compatible'].includes(profile.provider)) { const key = await context.secrets.get(legacySecretId(profile)); if (key) keys[profile.id] = key; }
          if (profile.provider === 'claude') { try { profile.executable = await executableFor('claude'); } catch {} }
          items.push(profile); activeId = profile.id;
        }
        imported = await storage({ action: 'import', source, items, keys });
      }
      pool = imported.pool; mapping = imported.mapping;
    }
    selection = defaults ? structuredClone(defaults) : { activeId: mapping[activeId] || (activeId ? null : old ? null : Object.values(mapping)[0] || null), overrides: {} };
    selection.overrides ||= {};
    const profile = pool.items.find(item => item.id === selection.activeId);
    if (profile && !selection.overrides[profile.id]) selection.overrides[profile.id] = choice(profile);
    if (!selection.revision) await persist();
  }
  async function ready() {
    if (!selection && !initializing) initializing = storage({ action: 'read' }).then(migrate).catch(error => { selection = undefined; throw error; }).finally(() => { initializing = undefined; });
    if (initializing) await initializing;
  }
  async function read() {
    await ready();
    const pool = await storage({ action: 'read' });
    return { ...pool, poolRevision: pool.revision, revision: pool.revision + ':' + selection.revision, activeId: pool.items.some(item => item.id === selection.activeId) ? selection.activeId : null, items: pool.items.map(effective) };
  }
  function change(action) { const next = changing.catch(() => {}).then(action); changing = next; return next; }
  async function current(expectedRevision) { const state = await read(); if (state.revision !== expectedRevision) throw new Error('连接或本窗口的选择已变化，请重新读取后再保存。'); return state; }
  async function select(profile) { await persist({ ...selection, activeId: profile.id, overrides: { ...selection.overrides, [profile.id]: choice(profile) } }); }

  return {
    read, storage: directory,
    key: async profile => { if (!profile) return undefined; await ready(); const { hasKey, transport: ignored, ...definition } = profile; return (await storage({ action: 'key', id: profile.id, profile: definition })).key || undefined; },
    save: (profile, key, expectedRevision, activate = true) => change(async () => {
      const state = await current(expectedRevision);
      const { hasKey, transport: ignored, ...definition } = profile;
      if (definition.provider === 'claude' && !definition.executable) definition.executable = await executableFor('claude');
      const result = await storage({ action: 'save', profile: definition, key, revision: state.poolRevision });
      if (activate) await select({ ...definition, id: result.id });
      return result.id;
    }),
    choose: (profile, revision) => change(async () => { const state = await current(revision); if (!state.items.some(item => item.id === profile.id)) throw new Error('此连接已删除，请重新选择。'); await select(profile); return profile.id; }),
    activate: (id, revision) => change(async () => { const state = await current(revision); const profile = state.items.find(item => item.id === id); if (!profile) throw new Error('此连接已删除，请重新选择。'); await select(profile); }),
    clearKey: (id, revision) => change(async () => { const state = await current(revision); await storage({ action: 'clear-key', id, revision: state.poolRevision }); }),
    remove: (id, revision) => change(async () => { const state = await current(revision); await storage({ action: 'remove', id, revision: state.poolRevision }); const overrides = { ...selection.overrides }; delete overrides[id]; await persist({ ...selection, activeId: selection.activeId === id ? null : selection.activeId, overrides }); }),
  };
}

module.exports = { createConnections };
