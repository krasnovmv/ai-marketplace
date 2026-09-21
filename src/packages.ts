import { createHash } from 'node:crypto';
import { check, name, safePath, parseJson } from './config.ts';
import { readBlob } from './git.ts';

export function selectPlugins(source, snapshot, limits) {
  if (source.type === 'repository') return source.plugins.filter(p => p.enabled);
  const entry = snapshot.entries.find(e => e.path === '.claude-plugin/marketplace.json');
  check(entry, source.id, 'missing marketplace manifest');
  const manifest = parseJson(readBlob(snapshot.root, entry, limits.maxFileSizeMb * 1048576), source.id);
  check(manifest && Array.isArray(manifest.plugins), source.id, 'expected marketplace plugins array');
  const entries = new Map();
  for (const plugin of manifest.plugins) {
    check(plugin && typeof plugin === 'object', source.id, 'invalid plugin entry');
    name(plugin.name, `${source.id}.plugins.name`);
    check(!entries.has(plugin.name), source.id, `ambiguous plugin ${plugin.name}`);
    entries.set(plugin.name, plugin);
  }
  const wanted = source.selection === 'all' ? [...entries.keys()].filter(n => !source.exclude.includes(n))
    : source.plugins.filter(p => p.enabled).map(p => p.name);
  return wanted.map(n => {
    check(entries.has(n), source.id, `REMOVED: ${n} disappeared upstream; change config explicitly`);
    const entry = entries.get(n);
    const path = safePath(entry.source, `${source.id}/${n}.source`, true);
    const marketplace = {};
    for (const field of ['description', 'version']) {
      if (entry[field] !== undefined) {
        check(typeof entry[field] === 'string', `${source.id}/${n}.${field}`, 'expected string');
        marketplace[field] = entry[field];
      }
    }
    if (entry.strict !== undefined) {
      check(typeof entry.strict === 'boolean', `${source.id}/${n}.strict`, 'expected boolean');
      marketplace.strict = entry.strict;
    }
    if (entry.lspServers !== undefined) {
      check(entry.lspServers && typeof entry.lspServers === 'object' && !Array.isArray(entry.lspServers), `${source.id}/${n}.lspServers`, 'expected object');
      marketplace.lspServers = entry.lspServers;
    }
    return { name: n, path, marketplace };
  });
}

export function stillWanted(metadata, config) {
  const source = config.sources.find(s => s.id === metadata.source.id && s.enabled);
  if (!source) return false;
  return source.selection === 'all' ? !source.exclude.includes(metadata.name)
    : source.plugins.some(p => p.name === metadata.name && p.enabled);
}

export function checkOrigin(previous, source, plugin) {
  if (!previous) return;
  const old = previous.source;
  const changed = old.id !== source.id || old.type !== source.type || old.repository !== source.repository || old.branch !== source.branch;
  check(changed || source.type === 'repository' || old.path === plugin.path,
    plugin.name, `BROKEN: upstream path changed from ${old.path} to ${plugin.path}; confirm using repository selection`);
}

export function readPackage(snapshot, plugin, limits) {
  const prefix = plugin.path === '.' ? '' : `${plugin.path}/`;
  const entries = snapshot.entries.filter(e => e.path.startsWith(prefix));
  let total = 0;
  const files = entries.map(entry => {
    total += entry.size;
    check(Number.isFinite(total) && total <= limits.maxPluginSizeMb * 1048576, plugin.name, 'package size limit exceeded');
    return { path: entry.path.slice(prefix.length), mode: entry.mode, data: readBlob(snapshot.root, entry, limits.maxFileSizeMb * 1048576, true) };
  });
  validatePackage(files, plugin.name, limits, plugin.marketplace);
  return files;
}

// Resolve only against the selected Git tree, never through the host filesystem.
export function resolveLinks(files) {
  const byPath = new Map(files.map(file => [file.path, file]));
  const directories = new Set();
  for (const file of files) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join('/'));
  }
  const resolved = new Map();
  for (const start of files.filter(file => file.mode === '120000')) {
    let file = start;
    const seen = new Set();
    let directoryTarget = false;
    while (file.mode === '120000' && !resolved.has(file.path)) {
      check(!seen.has(file.path), start.path, 'symlink cycle');
      seen.add(file.path);
      let target;
      try { target = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.data); }
      catch { throw new Error(`${file.path}: invalid UTF-8 symlink target`); }
      check(target.length > 0 && !target.startsWith('/') && !/[\\\x00-\x1f\x7f:]/u.test(target), file.path, 'symlink target must be relative and portable');
      const parts = file.path.split('/').slice(0, -1);
      const segments = target.split('/');
      for (let i = 0; i < segments.length; i++) {
        const part = segments[i];
        check(part.length > 0, file.path, 'empty symlink target component');
        if (part === '..') {
          check(parts.length > 0, file.path, 'symlink escapes package');
          parts.pop();
        } else if (part !== '.') {
          safePath(part, file.path);
          parts.push(part);
        }
        if (i < segments.length - 1) {
          check(parts.length === 0 || directories.has(parts.join('/')), file.path, 'symlink target traverses a missing directory or a file');
        }
      }
      const path = parts.join('/');
      if (!byPath.has(path)) {
        check(directories.has(path), file.path, 'symlink target must be an existing file or directory in this package');
        directoryTarget = true;
        break;
      }
      file = byPath.get(path);
    }
    if (directoryTarget) continue;
    file = resolved.get(file.path) ?? file;
    check(['100644', '100755'].includes(file.mode), start.path, 'symlink target must be a regular file');
    for (const path of seen) resolved.set(path, file);
  }
  return resolved;
}

export function validatePackage(files, pluginName, limits, marketplace = {}) {
  check(files.length > 0, pluginName, 'empty package');
  const paths = new Map();
  const directories = new Map();
  let total = 0;
  for (const file of files) {
    safePath(file.path, `${pluginName}/${file.path}`);
    check(['100644', '100755', '120000'].includes(file.mode), file.path, 'unsupported file mode');
    const key = file.path.toLowerCase();
    check(!paths.has(key), file.path, 'duplicate path or case collision');
    paths.set(key, file.path);
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const previous = directories.get(dir.toLowerCase());
      check(previous === undefined || previous === dir, file.path, 'directory case collision');
      directories.set(dir.toLowerCase(), dir);
    }
    total += file.data.length;
    check(file.data.length <= limits.maxFileSizeMb * 1048576, file.path, 'file size limit exceeded');
    check(total <= limits.maxPluginSizeMb * 1048576, pluginName, 'package size limit exceeded');
    const magic = file.data.subarray(0, 4).toString('hex');
    check(!/\.(exe|dll|so|dylib)$/i.test(file.path) && !magic.startsWith('4d5a')
      && !['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(magic), file.path, 'executable binary is unsupported');
    check(!file.data.subarray(0, 100).toString().startsWith('version https://git-lfs.github.com/spec/v1'), file.path, 'LFS pointer is unsupported');
  }
  for (const key of directories.keys()) check(!paths.has(key), pluginName, 'file/directory collision');
  const links = resolveLinks(files);
  const manifestPaths = ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
  const manifests = files.filter(f => manifestPaths.includes(f.path));
  check(manifests.length > 0 || files.some(f => /(?:^|\/)SKILL\.md$/.test(f.path)
    || /^(rules|agents|commands|hooks)\/.+/.test(f.path) || ['.mcp.json', 'mcp.json'].includes(f.path))
    || marketplace.lspServers !== undefined, pluginName, 'missing plugin components');
  let info = {};
  for (const file of manifests) {
    const manifest = parseJson((links.get(file.path) ?? file).data, `${pluginName}/${file.path}`);
    check(manifest && typeof manifest === 'object' && !Array.isArray(manifest), file.path, 'invalid plugin manifest');
    name(manifest.name, `${file.path}.name`);
    check(manifest.name === pluginName, file.path, 'plugin name differs from selected name');
    for (const field of ['description', 'version']) {
      if (manifest[field] !== undefined) check(typeof manifest[field] === 'string', `${file.path}.${field}`, 'expected string');
    }
    info = { ...info, ...manifest };
    for (const field of ['skills', 'rules', 'agents', 'commands', 'hooks', 'mcpServers', 'apps', 'outputStyles']) {
      if (manifest[field] !== undefined) validateReferences(manifest[field], files, `${file.path}.${field}`);
    }
  }
  for (const file of files.filter(f => ['.mcp.json', 'mcp.json', '.app.json', 'hooks/hooks.json'].includes(f.path))) {
    validateReferences(parseJson((links.get(file.path) ?? file).data, file.path), files, file.path);
  }
  return info;
}

function validateReferences(value, files, label) {
  if (Array.isArray(value)) { value.forEach(v => validateReferences(v, files, label)); return; }
  if (value && typeof value === 'object') { Object.values(value).forEach(v => validateReferences(v, files, label)); return; }
  if (typeof value !== 'string') return;
  // Only explicitly local references; arbitrary shell commands are data, never evaluated.
  for (const token of value.matchAll(/\$\{(?:CLAUDE|CODEX)_PLUGIN_ROOT\}\/([^\s"'`;|&<>]+)/g)) {
    requirePath(token[1], files, label);
  }
  if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    requirePath(value, files, label);
  }
}

function requirePath(value, files, label) {
  const path = safePath(value.replace(/\/$/, ''), label, true);
  check(path === '.' || files.some(f => f.path === path || f.path.startsWith(`${path}/`)), label, `missing local reference ${path}`);
}

export function contentHash(files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    for (const value of [Buffer.from(file.path), Buffer.from(file.mode), file.data]) {
      const length = Buffer.alloc(8);
      length.writeBigUInt64BE(BigInt(value.length));
      hash.update(length).update(value);
    }
  }
  return hash.digest('hex');
}

export function metadataFor(source, plugin, commit, files, previous) {
  const origin = { id: source.id, type: source.type, repository: source.repository, branch: source.branch, path: plugin.path };
  const hash = contentHash(files);
  const marketplace = Object.keys(plugin.marketplace ?? {}).length ? plugin.marketplace : undefined;
  if (previous && previous.integrity.contentHash === hash && Object.entries(origin).every(([key, value]) => previous.source[key] === value)
    && JSON.stringify(previous.marketplace) === JSON.stringify(marketplace)) return previous;
  return { name: plugin.name, source: { ...origin, commit }, ...(marketplace ? { marketplace } : {}), integrity: { contentHash: hash } };
}
