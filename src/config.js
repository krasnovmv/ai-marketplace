import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function check(ok, field, message) {
  if (!ok) throw new Error(`${field}: ${message}`);
}

export function object(value, keys, field) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), field, 'expected object');
  check(Object.keys(value).every(key => keys.includes(key)), field, 'unknown field');
}

export function safePath(value, field = 'path', root = false) {
  check(typeof value === 'string' && value.length > 0, field, 'expected relative path');
  if (root && (value === '.' || value === './')) return '.';
  const path = value.startsWith('./') ? value.slice(2) : value;
  check(!/[\\\x00-\x1f\x7f<>:"|?*]/u.test(path), field, 'unsafe path');
  for (const part of path.split('/')) {
    check(part && part !== '.' && part !== '..' && !/[ .]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)
      && !/^\.git$/i.test(part), field, 'non-portable path');
  }
  return path;
}

export function name(value, field) {
  check(typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value), field, 'expected lower-case hyphenated name');
  safePath(value, field);
  return value;
}

function enabled(value, field) {
  check(value === undefined || typeof value === 'boolean', field, 'expected boolean');
  return value ?? true;
}

export function repository(value, field) {
  check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)
    && !value.endsWith('.git') && !value.endsWith('.'), field, 'expected GitHub owner/repo without credentials');
  return value;
}

export function branch(value, field) {
  check(typeof value === 'string' && value.length > 0 && value !== '@'
    && !/[\s\x00-\x20\x7f~^:?*\[\\]/u.test(value)
    && !value.includes('..') && !value.includes('@{') && !value.startsWith('-')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),
  field, 'expected branch name');
  return value;
}

export function validateConfig(input) {
  object(input, ['marketplace', 'sources', 'limits'], 'config');
  object(input.marketplace, ['name', 'owner'], 'marketplace');
  name(input.marketplace.name, 'marketplace.name');
  object(input.marketplace.owner, ['name'], 'marketplace.owner');
  check(typeof input.marketplace.owner.name === 'string' && input.marketplace.owner.name.trim().length > 0
    && !/[\x00-\x1f\x7f]/u.test(input.marketplace.owner.name), 'marketplace.owner.name', 'expected nonempty name');
  check(Array.isArray(input.sources), 'sources', 'expected array');
  const ids = new Set();
  const identities = new Set();
  const names = new Map();
  const sources = input.sources.map((source, index) => {
    const field = `sources[${index}]`;
    object(source, ['id', 'type', 'repository', 'branch', 'enabled', 'selection', 'exclude', 'plugins'], field);
    name(source.id, `${field}.id`);
    check(!ids.has(source.id), `${field}.id`, 'duplicate source');
    ids.add(source.id);
    check(['marketplace', 'repository'].includes(source.type), `${field}.type`, 'unsupported type');
    repository(source.repository, `${field}.repository`);
    branch(source.branch, `${field}.branch`);
    const identity = `${source.repository.toLowerCase()}@${source.branch}:${source.type}`;
    check(!identities.has(identity), field, 'duplicate repository/branch/type');
    identities.add(identity);
    const active = enabled(source.enabled, `${field}.enabled`);
    check(['all', 'selected'].includes(source.selection), `${field}.selection`, 'expected all or selected');
    if (source.selection === 'all') {
      check(source.type === 'marketplace' && !Object.hasOwn(source, 'plugins'), field, 'all requires marketplace and forbids plugins');
      const exclude = source.exclude ?? [];
      check(Array.isArray(exclude), `${field}.exclude`, 'expected array');
      exclude.forEach((value, i) => name(value, `${field}.exclude[${i}]`));
      check(new Set(exclude).size === exclude.length, `${field}.exclude`, 'duplicate name');
      return { ...source, enabled: active, exclude };
    }
    check(!Object.hasOwn(source, 'exclude') && Array.isArray(source.plugins), field, 'selected requires plugins and forbids exclude');
    const local = new Set();
    const plugins = source.plugins.map((plugin, i) => {
      const loc = `${field}.plugins[${i}]`;
      object(plugin, source.type === 'repository' ? ['name', 'enabled', 'path'] : ['name', 'enabled'], loc);
      name(plugin.name, `${loc}.name`);
      check(!local.has(plugin.name), loc, 'duplicate plugin');
      local.add(plugin.name);
      const pluginEnabled = enabled(plugin.enabled, `${loc}.enabled`);
      if (active && pluginEnabled) {
        check(!names.has(plugin.name), loc, `name collision with ${names.get(plugin.name)}`);
        names.set(plugin.name, source.id);
      }
      return { ...plugin, enabled: pluginEnabled,
        ...(source.type === 'repository' ? { path: safePath(plugin.path, `${loc}.path`, true) } : {}) };
    });
    return { ...source, enabled: active, plugins };
  });
  const limits = { maxFileSizeMb: 5, maxPluginSizeMb: 20, ...input.limits };
  if (input.limits !== undefined) object(input.limits, ['maxFileSizeMb', 'maxPluginSizeMb'], 'limits');
  for (const [key, value] of Object.entries(limits)) {
    check(typeof value === 'number' && Number.isFinite(value) && value > 0 && Number.isSafeInteger(Math.ceil(value * 1048576)), `limits.${key}`, 'expected positive finite size');
  }
  return { marketplace: input.marketplace, sources, limits };
}

export function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`${label}: invalid JSON`); }
}

export function readConfig(root) {
  return validateConfig(parseJson(readFileSync(join(root, 'config/upstreams.json')), 'config/upstreams.json'));
}
