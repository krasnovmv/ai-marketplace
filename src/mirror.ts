import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { check, name, object, parseJson, readConfig, repository, branch, safePath } from './config.ts';
import { fetchSource, git, indexFile, readBlob, readTree, temporary } from './git.ts';
import { checkOrigin, contentHash, metadataFor, readPackage, resolveLinks, selectPlugins, stillWanted, validatePackage } from './packages.ts';

export const catalogPaths = ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json'];
export const json = value => `${JSON.stringify(value, null, 2)}\n`;

function checkedPath(root, path, allowLeafLink = false) {
  safePath(path);
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try { check(allowLeafLink && current === join(root, path) || !lstatSync(current).isSymbolicLink(), path, 'symlink/junction is unsupported'); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return join(root, path);
}

function read(root, path) {
  const full = checkedPath(root, path);
  check(lstatSync(full).isFile(), path, 'expected regular file');
  return readFileSync(full);
}

function children(root, path) {
  const full = checkedPath(root, path);
  if (!existsSync(full)) return [];
  check(lstatSync(full).isDirectory(), path, 'expected directory');
  return readdirSync(full).sort();
}

export function write(root, path, data, mode = '100644') {
  const full = checkedPath(root, path);
  if (existsSync(full)) check(lstatSync(full).isFile(), path, 'expected regular file');
  mkdirSync(dirname(full), { recursive: true });
  if (mode === '120000' && process.platform !== 'win32') {
    check(!existsSync(full), path, 'symlink destination already exists');
    symlinkSync(data.toString('utf8'), full);
    return;
  }
  // Windows: Git-compatible target-text checkout; index retains mode 120000 and exact bytes.
  writeFileSync(full, data);
  if (process.platform !== 'win32') chmodSync(full, mode === '100755' ? 0o755 : 0o644);
}

export function localFiles(root, pluginName, limits) {
  const prefix = `plugins/${pluginName}`;
  const trackedFiles = new Map();
  const committedFiles = new Map();
  const tracked = git(root, ['ls-files', '--stage', '-z', '--', prefix]).toString();
  for (const entry of tracked.split('\0').filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    check(match && match[3] === '0', prefix, 'unmerged index');
    trackedFiles.set(match[4], { mode: match[1], oid: match[2] });
  }
  // Git for Windows may turn a checked-out symlink into a regular CRLF text file
  // and report it as 100644 in the index. HEAD remains the authoritative record.
  if (process.platform === 'win32') {
    for (const entry of readTree(root, 'HEAD')) {
      if (entry.path.startsWith(`${prefix}/`)) committedFiles.set(entry.path, entry);
    }
  }
  const files = [];
  let total = 0;
  function visit(path) {
    const full = checkedPath(root, path, true);
    const stat = lstatSync(full);
    if (stat.isDirectory()) {
      for (const child of readdirSync(full).sort()) visit(`${path}/${child}`);
    } else {
      const indexed = trackedFiles.get(path);
      const committed = committedFiles.get(path);
      const link = stat.isSymbolicLink();
      const symlink = indexed?.mode === '120000' ? indexed : committed?.mode === '120000' ? committed : undefined;
      check(stat.isFile() || link && indexed?.mode === '120000', path, 'special or untracked link is unsupported');
      let data;
      if (process.platform === 'win32' && symlink) {
        data = git(root, ['cat-file', 'blob', symlink.oid], { maxBuffer: limits.maxFileSizeMb * 1048576 + 1 });
      } else if (link) data = readlinkSync(full, { encoding: 'buffer' });
      else data = readFileSync(full);
      total += data.length;
      check(data.length <= limits.maxFileSizeMb * 1048576, path, 'file size limit exceeded');
      check(total <= limits.maxPluginSizeMb * 1048576, prefix, 'package size limit exceeded');
      check(!indexed || ['100644', '100755', '120000'].includes(indexed.mode), path, 'unsupported index mode');
      check(!symlink || link || process.platform === 'win32', path, 'expected symlink');
      const mode = link ? '120000' : process.platform === 'win32' ? symlink?.mode ?? indexed?.mode ?? '100644' : stat.mode & 0o111 ? '100755' : '100644';
      files.push({ path: path.slice(prefix.length + 1), mode, data });
    }
  }
  visit(prefix);
  return files;
}

export function readAccepted(root, config) {
  const accepted = new Map();
  for (const filename of children(root, 'metadata')) {
    check(filename.endsWith('.json'), `metadata/${filename}`, 'unknown metadata file');
    const pluginName = name(filename.slice(0, -5), 'metadata filename');
    const raw = read(root, `metadata/${filename}`);
    const metadata = parseJson(raw, filename);
    object(metadata, ['name', 'source', 'marketplace', 'integrity'], filename);
    check(metadata.name === pluginName, filename, 'metadata name mismatch');
    object(metadata.source, ['id', 'type', 'repository', 'branch', 'path', 'commit'], `${filename}.source`);
    name(metadata.source.id, `${filename}.source.id`);
    check(['marketplace', 'repository'].includes(metadata.source.type), filename, 'invalid source type');
    repository(metadata.source.repository, `${filename}.source.repository`);
    branch(metadata.source.branch, `${filename}.source.branch`);
    safePath(metadata.source.path, `${filename}.source.path`, true);
    check(/^[a-f0-9]{40}$/.test(metadata.source.commit), filename, 'invalid commit SHA');
    object(metadata.integrity, ['contentHash'], `${filename}.integrity`);
    check(/^[a-f0-9]{64}$/.test(metadata.integrity.contentHash), filename, 'invalid content hash');
    const marketplace = metadata.marketplace ?? {};
    object(marketplace, ['description', 'version', 'strict', 'lspServers'], `${filename}.marketplace`);
    if (marketplace.description !== undefined) check(typeof marketplace.description === 'string', `${filename}.marketplace.description`, 'expected string');
    if (marketplace.version !== undefined) check(typeof marketplace.version === 'string', `${filename}.marketplace.version`, 'expected string');
    if (marketplace.strict !== undefined) check(typeof marketplace.strict === 'boolean', `${filename}.marketplace.strict`, 'expected boolean');
    if (marketplace.lspServers !== undefined) check(marketplace.lspServers && typeof marketplace.lspServers === 'object' && !Array.isArray(marketplace.lspServers), `${filename}.marketplace.lspServers`, 'expected object');
    const files = localFiles(root, pluginName, config.limits);
    const info = validatePackage(files, pluginName, config.limits, marketplace);
    check(contentHash(files) === metadata.integrity.contentHash, `plugins/${pluginName}`, 'content hash mismatch');
    accepted.set(pluginName, { metadata, raw, files, info, marketplace });
  }
  for (const pluginName of children(root, 'plugins')) {
    check(accepted.has(pluginName), `plugins/${pluginName}`, 'unknown occupied path without metadata');
  }
  return accepted;
}

export function catalogs(config, accepted) {
  const entries = [...accepted.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return [
    json({ name: config.marketplace.name, owner: config.marketplace.owner, plugins: entries.map(([n, p]) => ({
      name: n, source: `./plugins/${n}`, ...(p.info.description ?? p.marketplace?.description ? { description: p.info.description ?? p.marketplace.description } : {}),
      ...(p.info.version ?? p.marketplace?.version ? { version: p.info.version ?? p.marketplace.version } : {}),
      ...(p.marketplace?.strict === false ? { strict: false } : {}),
      ...(p.marketplace?.lspServers ? { lspServers: p.marketplace.lspServers } : {}),
    })) }),
    json({ name: config.marketplace.name, interface: { displayName: config.marketplace.name }, plugins: entries.map(([n]) => ({
      name: n, source: { source: 'local', path: `./plugins/${n}` },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
    })) }),
  ];
}

export function validate(root, config = readConfig(root), { bootstrap = false } = {}) {
  const accepted = readAccepted(root, config);
  const expected = catalogs(config, accepted);
  for (let i = 0; i < catalogPaths.length; i++) {
    if (bootstrap && accepted.size === 0 && !existsSync(checkedPath(root, catalogPaths[i]))) continue;
    check(read(root, catalogPaths[i]).equals(Buffer.from(expected[i])), catalogPaths[i], 'catalog differs; run npm run generate');
  }
  const pending = config.sources.some(s => s.enabled && ![...accepted.values()].some(p => p.metadata.source.id === s.id))
    || [...accepted.values()].some(p => !stillWanted(p.metadata, config) || !config.sources.some(s =>
      s.id === p.metadata.source.id && s.repository === p.metadata.source.repository && s.branch === p.metadata.source.branch
      && s.type === p.metadata.source.type && (s.selection === 'all' || s.plugins.some(w => w.enabled && w.name === p.metadata.name
        && (s.type !== 'repository' || w.path === p.metadata.source.path)))))
    || config.sources.some(s => s.enabled && s.selection === 'selected' && s.plugins.some(p => p.enabled && !accepted.has(p.name)));
  return { accepted, pending };
}

export function generate(root) {
  const config = readConfig(root);
  const accepted = readAccepted(root, config);
  const output = catalogs(config, accepted);
  // Check both destinations before writing either catalog.
  catalogPaths.forEach(path => checkedPath(root, path));
  catalogPaths.forEach((path, i) => write(root, path, output[i]));
}

export function prepare(root, { fetch = fetchSource, dryRun = false } = {}) {
  root = resolve(root);
  const config = readConfig(root);
  validate(root, config, { bootstrap: true });
  const base = git(root, ['rev-parse', 'HEAD']).toString().trim();
  const candidate = temporary('marketplace-candidate-');
  const reports = [];
  let success = false;
  try {
    git(candidate.root, ['clone', '--no-hardlinks', '--no-checkout', '--template=', '--', root, candidate.root]);
    git(candidate.root, ['read-tree', base]);
    const baseFiles = readTree(candidate.root, base).map(entry => ({ ...entry,
      data: readBlob(candidate.root, entry, 64 * 1048576, entry.path.startsWith('plugins/')) }));
    const linkedPackages = new Set(baseFiles.filter(f => f.mode === '120000').map(f => f.path.split('/')[1]));
    for (const n of linkedPackages) {
      name(n, 'package name');
      resolveLinks(baseFiles.filter(f => f.path.startsWith(`plugins/${n}/`)).map(f => ({ ...f, path: f.path.slice(`plugins/${n}/`.length) })));
    }
    for (const entry of baseFiles) {
      const data = entry.data;
      write(candidate.root, entry.path, data, entry.mode);
    }
    const previousConfig = existsSync(join(candidate.root, 'config/upstreams.json')) ? readConfig(candidate.root) : config;
    const { accepted: old } = validate(candidate.root, previousConfig, { bootstrap: true });
    const next = new Map();
    for (const source of config.sources.filter(s => s.enabled)) {
      // No network is necessary for an explicitly empty selection.
      if (source.selection === 'selected' && !source.plugins.some(p => p.enabled)) continue;
      const snapshot = fetch(source);
      try {
        for (const plugin of selectPlugins(source, snapshot, config.limits)) {
          check(!next.has(plugin.name), plugin.name, `collision between ${next.get(plugin.name)?.metadata.source.id} and ${source.id}; use exclude/selected`);
          const previous = old.get(plugin.name);
          checkOrigin(previous?.metadata, source, plugin);
          const files = readPackage(snapshot, plugin, config.limits);
          const info = validatePackage(files, plugin.name, config.limits, plugin.marketplace);
          const metadata = metadataFor(source, plugin, snapshot.commit, files, previous?.metadata);
          next.set(plugin.name, { metadata, info, files, marketplace: metadata.marketplace ?? {}, raw: metadata === previous?.metadata ? previous.raw : Buffer.from(json(metadata)) });
          reports.push({ source: source.id, repository: source.repository, name: plugin.name, status: previous ? metadata === previous.metadata ? 'UNCHANGED' : 'UPDATED' : 'ADDED',
            accepted: previous?.metadata.source.commit ?? null, checked: snapshot.commit });
        }
      } catch (error) {
        throw new Error(`${source.id}: BROKEN: ${error.message}`);
      } finally { snapshot.cleanup(); }
    }
    for (const [n, previous] of old) {
      if (next.has(n)) continue;
      check(!stillWanted(previous.metadata, config), n, 'REMOVED: disappeared upstream; exclude or disable explicitly');
      reports.push({ source: previous.metadata.source.id, repository: previous.metadata.source.repository, name: n, status: 'REMOVED', reason: 'explicit config change', accepted: previous.metadata.source.commit, checked: null });
    }
    for (const [n, previous] of old) {
      for (const file of previous.files) git(candidate.root, ['update-index', '--force-remove', '--', `plugins/${n}/${file.path}`]);
      git(candidate.root, ['update-index', '--force-remove', '--', `metadata/${n}.json`]);
      // The path is a validated name under our fresh temporary candidate, never the caller's tree.
      rmSync(checkedPath(candidate.root, `plugins/${n}`), { recursive: true });
      rmSync(checkedPath(candidate.root, `metadata/${n}.json`));
    }
    for (const [n, pkg] of next) {
      check(!existsSync(checkedPath(candidate.root, `plugins/${n}`)) && !existsSync(checkedPath(candidate.root, `metadata/${n}.json`)), n, 'unknown occupied destination');
      for (const file of pkg.files) {
        const path = `plugins/${n}/${file.path}`;
        write(candidate.root, path, file.data, file.mode);
        indexFile(candidate.root, path, file.data, file.mode);
      }
      write(candidate.root, `metadata/${n}.json`, pkg.raw);
      indexFile(candidate.root, `metadata/${n}.json`, pkg.raw);
    }
    const outputs = catalogs(config, next);
    catalogPaths.forEach((path, i) => { write(candidate.root, path, outputs[i]); indexFile(candidate.root, path, Buffer.from(outputs[i])); });
    validate(candidate.root, config);
    const changed = git(candidate.root, ['diff', '--cached', '--name-only', '-z', base]).toString().split('\0').filter(Boolean);
    for (const path of changed) check(catalogPaths.includes(path) || [...old.keys(), ...next.keys()].some(n => path.startsWith(`plugins/${n}/`) || path === `metadata/${n}.json`), path, 'change outside managed paths');
    const diff = git(candidate.root, ['diff', '--cached', '--stat', base]).toString();
    // Config is a local input, never staged into the publication commit.
    write(candidate.root, 'config/upstreams.json', read(root, 'config/upstreams.json'));
    success = true;
    return { root: dryRun ? null : candidate.root, base, reports, changed, diff, cleanup: candidate.cleanup };
  } finally {
    if (!success || dryRun) candidate.cleanup();
  }
}
