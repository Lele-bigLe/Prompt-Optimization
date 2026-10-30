'use strict';

const { randomUUID } = require('node:crypto');
const { createJsonStore } = require('./json-store.cjs');
const { builtins, variableNames, validateTemplate, templateVariables } = require('../core/templates.cjs');

function createTemplates(context) {
  const { read, commit, change } = createJsonStore(context.globalStorageUri.fsPath, 'templates',
    () => ({ version:1, revision:'', activeId:builtins[0].id, custom:[], variables:{} }),
    state => Array.isArray(state.custom) && state.custom.length <= 100 && state.custom.every(item => item && /^[a-f\d-]{36}$/.test(item.id)) && new Set(state.custom.map(item => item.id)).size === state.custom.length && state.variables && typeof state.variables === 'object' && !Array.isArray(state.variables) && [...builtins,...state.custom].some(item => item.id === state.activeId));
  const all = state => [...builtins,...state.custom].map(item => ({ ...item, variables: state.variables[item.id] || {}, variableNames:variableNames(item) }));
  function normalize(input) {
    const result = Object.fromEntries(['name','description','category','systemPrompt','userTemplate'].map(name => [name, input?.[name] ?? '']));
    validateTemplate(result);
    result.name = result.name.trim();
    return result;
  }
  return {
    read, all,
    active: state => all(state).find(item => item.id === state.activeId),
    save: (input, revision) => change(revision, async state => {
      const previous = state.custom.find(item => item.id === input?.id);
      if (input?.id && !previous) throw new Error('内置模板请先复制；已删除的模板需要重新选择。');
      if (!previous && state.custom.length >= 100) throw new Error('最多保存 100 个自定义模板。');
      const item = { ...normalize(input), id:previous?.id || randomUUID(), version:(previous?.version || 0) + 1, isBuiltin:false };
      const values = templateVariables(item, input.variables);
      if (previous) state.custom = state.custom.map(existing => existing.id === item.id ? item : existing);
      else state.custom.push(item);
      state.variables[item.id] = values;
      state.activeId = item.id;
      await commit(state);
      return item.id;
    }),
    activate: (id, variables, revision) => change(revision, async state => {
      const template = all(state).find(item => item.id === id);
      if (!template) throw new Error('模板已被删除，请重新读取。');
      state.variables[id] = templateVariables(template, variables);
      state.activeId = id;
      await commit(state);
      return id;
    }),
    copy: (id, revision) => change(revision, async state => {
      const source = all(state).find(item => item.id === id);
      if (!source) throw new Error('模板已被删除，请重新读取。');
      if (state.custom.length >= 100) throw new Error('最多保存 100 个自定义模板。');
      const item = { ...normalize({ ...source, name:(source.name + ' 副本').slice(0,80) }), id:randomUUID(), version:1, isBuiltin:false };
      state.custom.push(item);
      state.variables[item.id] = templateVariables(item, source.variables, false);
      await commit(state);
      return item.id;
    }),
    remove: (id, revision) => change(revision, async state => {
      if (!state.custom.some(item => item.id === id)) throw new Error('只能删除自定义模板。');
      state.custom = state.custom.filter(item => item.id !== id);
      delete state.variables[id];
      if (state.activeId === id) state.activeId = builtins[0].id;
      await commit(state);
    }),
    import: (payload, revision) => change(revision, async state => {
      const version = Array.isArray(payload) ? 1 : payload?.Version ?? payload?.version ?? 1;
      if (version !== 1) throw new Error('此模板文件版本尚未支持。');
      const entries = Array.isArray(payload) ? payload : payload?.Templates ?? payload?.templates;
      if (!Array.isArray(entries) || !entries.length || entries.length + state.custom.length > 100) throw new Error('模板 JSON 为空、格式不正确，或导入后超过 100 个自定义模板。');
      const imported = entries.map(entry => ({ ...normalize(Object.fromEntries(['name','description','category','systemPrompt','userTemplate'].map(key => [key, entry?.[key] ?? entry?.[key[0].toUpperCase() + key.slice(1)] ?? '']))), id:randomUUID(), version:1, isBuiltin:false }));
      state.custom.push(...imported);
      await commit(state);
      return { id:imported[0].id, count:imported.length };
    }),
    export: template => ({ Version:1, Templates:[{ Id:template.id, Name:template.name, Description:template.description, Category:template.category, SystemPrompt:template.systemPrompt, UserTemplate:template.userTemplate, IsBuiltin:template.isBuiltin, Language:'zh', Version:template.version }] }),
  };
}

module.exports = { createTemplates };
