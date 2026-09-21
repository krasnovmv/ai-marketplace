import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../src/config.ts';
import { fetchSource, git, indexFile, readTree, temporary } from '../src/git.ts';
import { contentHash, metadataFor, resolveLinks, validatePackage } from '../src/packages.ts';
import { catalogs, generate, json, prepare, validate, write } from '../src/mirror.ts';

const config = () => ({ marketplace: { name: 'test-market', owner: { name: 'Tester' } }, sources: [
  { id: 'upstream', type: 'marketplace', repository: 'test/source', branch: 'main', selection: 'all' },
] });
const limits = { maxFileSizeMb: 5, maxPluginSizeMb: 20 };
const file = (path, data, mode = '100644') => ({ path, data: Buffer.from(data), mode });
const pkg = () => [file('.claude-plugin/plugin.json', json({ name: 'alpha', version: '1.0.0' })), file('skills/example/SKILL.md', '# Example\n')];

function repo(t) {
  const temp = temporary('marketplace-test-');
  t.after(temp.cleanup);
  git(temp.root, ['init', '--initial-branch=main', '--template=']);
  return temp.root;
}

function save(root, path, text, mode = '100644') {
  const bytes = Buffer.from(text);
  write(root, path, bytes, mode);
  indexFile(root, path, bytes, mode);
}

function commit(root) {
  git(root, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'test']);
  return git(root, ['rev-parse', 'HEAD']).toString().trim();
}

function upstream(t) {
  const root = repo(t);
  for (const n of ['alpha', 'beta']) {
    save(root, `${n}/.claude-plugin/plugin.json`, json({ name: n, version: '1.0.0' }));
    save(root, `${n}/skills/sample/SKILL.md`, '# Sample\n');
    save(root, `${n}/LICENSE`, 'license\n');
    save(root, `${n}/dist/start.sh`, '#!/bin/sh\necho sample\n', '100755');
    save(root, `${n}/package.json`, json({ scripts: { postinstall: 'touch EXECUTED' } }));
  }
  save(root, '.claude-plugin/marketplace.json', json({ plugins: ['alpha', 'beta'].map(n => ({ name: n, source: `./${n}` })) }));
  commit(root);
  write(root, 'alpha/cache.tmp', 'untracked');
  return root;
}

function mirror(t, input = config()) {
  const root = repo(t);
  save(root, 'config/upstreams.json', json(input));
  generate(root);
  for (const path of ['.claude-plugin/marketplace.json', '.agents/plugins/marketplace.json']) save(root, path, readFileSync(join(root, path)));
  save(root, 'notes.txt', 'committed');
  commit(root);
  return root;
}

function sync(t, root, source, options = {}) {
  const result = prepare(root, { fetch: s => fetchSource(s, source), ...options });
  if (result.root) t.after(result.cleanup);
  return result;
}

test('full pipeline: immutable snapshot, isolated candidate, no-op, unchanged version, selection and explicit removal', t => {
  const source = upstream(t);
  const root = mirror(t);
  write(root, 'notes.txt', 'local work');
  save(root, 'staged.txt', 'staged work');
  const before = git(root, ['status', '--porcelain=v1', '-z']);
  const indexBefore = readFileSync(join(root, '.git/index'));
  const first = sync(t, root, source);
  assert.equal(first.reports.length, 2);
  assert(first.reports.every(r => r.status === 'ADDED'));
  assert.equal(readFileSync(join(first.root, 'notes.txt'), 'utf8'), 'committed');
  assert(!existsSync(join(first.root, 'staged.txt')));
  assert(!existsSync(join(first.root, 'plugins/alpha/cache.tmp')));
  assert(!existsSync(join(first.root, 'plugins/alpha/EXECUTED')));
  assert.equal(readTree(first.root, git(first.root, ['write-tree']).toString().trim()).find(e => e.path === 'plugins/alpha/dist/start.sh').mode, '100755');
  assert.deepEqual(readFileSync(join(root, '.git/index')), indexBefore);
  assert.deepEqual(git(root, ['status', '--porcelain=v1', '-z']), before);
  commit(first.root);
  assert.equal(validate(first.root).accepted.size, 2);
  const alphaMeta = readFileSync(join(first.root, 'metadata/alpha.json'));
  const betaMeta = readFileSync(join(first.root, 'metadata/beta.json'));
  save(source, 'unrelated.txt', 'unrelated change');
  commit(source);
  const unchanged = sync(t, first.root, source);
  assert.deepEqual(unchanged.changed, []);
  assert(unchanged.reports.every(r => r.status === 'UNCHANGED' && r.checked !== r.accepted));
  assert.deepEqual(readFileSync(join(unchanged.root, 'metadata/alpha.json')), alphaMeta);
  save(source, 'alpha/skills/sample/SKILL.md', '# Changed without version bump\n');
  commit(source);
  const update = sync(t, first.root, source);
  assert.equal(update.reports.find(r => r.name === 'alpha').status, 'UPDATED');
  assert.equal(update.reports.find(r => r.name === 'beta').status, 'UNCHANGED');
  assert.deepEqual(readFileSync(join(update.root, 'metadata/beta.json')), betaMeta);
  assert.equal(JSON.parse(readFileSync(join(update.root, 'plugins/alpha/.claude-plugin/plugin.json'))).version, '1.0.0');
  commit(update.root);
  save(source, 'gamma/SKILL.md', '# New plugin\n');
  save(source, '.claude-plugin/marketplace.json', json({ plugins: ['alpha', 'beta', 'gamma'].map(n => ({ name: n, source: `./${n}` })) }));
  commit(source);
  const added = sync(t, update.root, source);
  assert.equal(added.reports.find(r => r.name === 'gamma').status, 'ADDED');
  const selected = config();
  Object.assign(selected.sources[0], { selection: 'selected', plugins: [{ name: 'alpha' }] });
  write(update.root, 'config/upstreams.json', json(selected));
  assert.equal(validate(update.root).pending, true);
  save(source, 'alpha/skills/new/SKILL.md', '# New skill\n');
  commit(source);
  const selection = sync(t, update.root, source);
  assert(!selection.reports.some(r => r.name === 'gamma'));
  assert.equal(selection.reports.find(r => r.name === 'beta').status, 'REMOVED');
  assert(existsSync(join(selection.root, 'plugins/alpha/skills/new/SKILL.md')));
  write(update.root, 'config/upstreams.json', json(config()));
  save(source, '.claude-plugin/marketplace.json', json({ plugins: [{ name: 'alpha', source: './alpha' }] }));
  commit(source);
  assert.throws(() => sync(t, update.root, source), /REMOVED.*disappeared/);
  const excluded = config(); excluded.sources[0].exclude = ['beta'];
  write(update.root, 'config/upstreams.json', json(excluded));
  assert.equal(sync(t, update.root, source).reports.find(r => r.name === 'beta').status, 'REMOVED');
  const preview = sync(t, update.root, source, { dryRun: true });
  assert.equal(preview.root, null);
  assert.deepEqual(readFileSync(join(update.root, 'metadata/beta.json')), betaMeta);
});

test('fetch freezes a SHA, root packages retain tracked files, rejects special modes and missing branch', t => {
  const root = upstream(t);
  const s = validateConfig(config()).sources[0];
  const snapshot = fetchSource(s, root);
  t.after(snapshot.cleanup);
  const old = snapshot.commit;
  save(root, 'alpha/SKILL.md', 'changed'); commit(root);
  assert.equal(git(snapshot.root, ['rev-parse', 'FETCH_HEAD']).toString().trim(), old);
  assert(!snapshot.entries.some(e => e.path === 'alpha/SKILL.md'));
  assert.throws(() => fetchSource({ ...s, branch: 'missing' }, root), /BROKEN/);
  assert.throws(() => fetchSource(s, join(root, 'missing')), /BROKEN/);
  save(root, 'SKILL.md', '# Root plugin');
  save(root, '.claude-plugin/marketplace.json', json({ plugins: [{ name: 'root-plugin', source: './' }] }));
  commit(root);
  const result = sync(t, mirror(t), root);
  assert(existsSync(join(result.root, 'plugins/root-plugin/alpha/dist/start.sh')));
  assert(!existsSync(join(result.root, 'plugins/root-plugin/.git')));
  assert(!existsSync(join(result.root, 'plugins/root-plugin/alpha/cache.tmp')));
});

test('validation rejects corrupt bytes/catalogs, unknown paths, and preserves mtime independence', t => {
  const source = upstream(t);
  const result = sync(t, mirror(t), source);
  commit(result.root);
  const target = join(result.root, 'plugins/alpha/skills/sample/SKILL.md');
  utimesSync(target, new Date(0), new Date(0));
  assert.equal(validate(result.root).accepted.size, 2);
  const original = readFileSync(target);
  writeFileSync(target, 'corrupt');
  assert.throws(() => validate(result.root), /hash mismatch/);
  writeFileSync(target, original);
  const metadataPath = join(result.root, 'metadata/alpha.json');
  const metadataBytes = readFileSync(metadataPath);
  writeFileSync(metadataPath, '{}');
  assert.throws(() => validate(result.root), /metadata name mismatch/);
  writeFileSync(metadataPath, metadataBytes);
  const tinyLimits = validateConfig(config());
  tinyLimits.limits.maxFileSizeMb = 1 / 1048576;
  assert.throws(() => validate(result.root, tinyLimits), /file size limit/);
  const catalog = join(result.root, '.agents/plugins/marketplace.json');
  writeFileSync(catalog, '{}');
  assert.throws(() => validate(result.root), /catalog differs/);
  generate(result.root);
  const before = readFileSync(catalog);
  generate(result.root);
  assert.deepEqual(readFileSync(catalog), before);
  write(result.root, 'plugins/unknown/file', 'private');
  assert.throws(() => sync(t, result.root, source), /unknown occupied/);
  assert.equal(readFileSync(join(result.root, 'plugins/unknown/file'), 'utf8'), 'private');
});

test('portable package validation, size boundaries, executable signatures and broken references', () => {
  validatePackage(pkg(), 'alpha', limits);
  for (const extra of [
    file('../outside', 'x'), file('NUL.txt', 'x'), file('a\\b', 'x'),
    file('sym', 'outside', '120000'), file('submodule', '', '160000'),
    file('image.png', Buffer.from('7f454c4600', 'hex')), file('x', Buffer.from('4d5a0000', 'hex')),
    file('lib.dll', ''), file('lfs', 'version https://git-lfs.github.com/spec/v1\n'),
  ]) assert.throws(() => validatePackage([...pkg(), extra], 'alpha', limits));
  assert.throws(() => validatePackage([...pkg(), file('Readme', 'a'), file('README', 'b')], 'alpha', limits), /collision/);
  assert.throws(() => validatePackage([...pkg(), file('Dir/a', ''), file('dir/b', '')], 'alpha', limits), /collision/);
  assert.throws(() => validatePackage([...pkg(), file('d', ''), file('d/a', '')], 'alpha', limits), /collision/);
  const bytes = 1024;
  const small = [file('SKILL.md', Buffer.alloc(bytes))];
  validatePackage(small, 'alpha', { maxFileSizeMb: bytes / 1048576, maxPluginSizeMb: bytes / 1048576 });
  assert.throws(() => validatePackage([file('SKILL.md', Buffer.alloc(bytes + 1))], 'alpha', { ...limits, maxFileSizeMb: bytes / 1048576 }), /file size/);
  assert.throws(() => validatePackage([...small, file('extra', 'x')], 'alpha', { ...limits, maxPluginSizeMb: bytes / 1048576 }), /package size/);
  assert.throws(() => validatePackage([file('.claude-plugin/plugin.json', json({ name: 'alpha', skills: './missing' }))], 'alpha', limits), /missing local/);
  assert.throws(() => validatePackage([file('.claude-plugin/plugin.json', json({ name: 'other' }))], 'alpha', limits), /name differs/);
});

test('marketplace LSP configuration makes a manifest-less package installable in Claude', () => {
  const marketplace = {
    strict: false,
    lspServers: { typescript: { command: 'typescript-language-server', args: ['--stdio'] } },
  };
  validatePackage([file('README.md', '# TypeScript LSP\n')], 'typescript-lsp', limits, marketplace);
  const catalog = JSON.parse(catalogs(validateConfig(config()), new Map([
    ['typescript-lsp', { info: {}, marketplace }],
  ]))[0]);
  assert.deepEqual(catalog.plugins[0].lspServers, marketplace.lspServers);
  assert.equal(catalog.plugins[0].strict, false);
});

test('hash includes all bytes, path and executable mode; metadata tracks explicit origin changes', () => {
  const files = pkg();
  assert.equal(contentHash(files), contentHash([...files].reverse()));
  for (const change of [file('other', 'x'), file(files[1].path, 'other'), file(files[1].path, files[1].data, '100755')]) {
    assert.notEqual(contentHash(files), contentHash([files[0], change]));
  }
  const source = validateConfig(config()).sources[0];
  const plugin = { name: 'alpha', path: 'alpha' };
  const first = metadataFor(source, plugin, 'a'.repeat(40), files);
  assert.equal(metadataFor(source, plugin, 'b'.repeat(40), files, first), first);
  assert.notEqual(metadataFor({ ...source, repository: 'test/other' }, plugin, 'b'.repeat(40), files, first), first);
});

test('unknown CLI arguments fail without changes; empty catalogs are deterministic', t => {
  const root = mirror(t);
  const before = git(root, ['status', '--porcelain']);
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--experimental-strip-types', cli, 'sync', '--unknown'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage/);
  assert.deepEqual(git(root, ['status', '--porcelain']), before);
  const output = catalogs(validateConfig(config()), new Map());
  assert.deepEqual(JSON.parse(output[0]).plugins, []);
  assert(!output.join('').includes('\r'));
});

test('internal symlinks survive sync, validation, a second sync and target updates', t => {
  const source = upstream(t);
  save(source, 'alpha/CLAUDE.md', '# Instructions');
  const oid = git(source, ['hash-object', '-w', '--stdin'], { input: Buffer.from('CLAUDE.md') }).toString().trim();
  git(source, ['update-index', '--add', '--cacheinfo', `120000,${oid},alpha/AGENTS.md`]);
  const directoryOid = git(source, ['hash-object', '-w', '--stdin'], { input: Buffer.from('../../skills/sample') }).toString().trim();
  git(source, ['update-index', '--add', '--cacheinfo', `120000,${directoryOid},alpha/.claude/skills/sample`]);
  commit(source);
  const root = mirror(t);
  const before = git(root, ['status', '--porcelain=v1', '-z']);
  const first = sync(t, root, source);
  const linkPath = join(first.root, 'plugins/alpha/AGENTS.md');
  if (process.platform === 'win32') {
    assert.equal(lstatSync(linkPath).isSymbolicLink(), false);
    assert.equal(readFileSync(linkPath, 'utf8'), 'CLAUDE.md');
  } else {
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(linkPath), 'CLAUDE.md');
    assert.equal(readFileSync(linkPath, 'utf8'), '# Instructions');
  }
  const staged = readTree(first.root, git(first.root, ['write-tree']).toString().trim());
  assert.equal(staged.find(e => e.path === 'plugins/alpha/AGENTS.md').mode, '120000');
  assert.equal(validate(first.root).accepted.get('alpha').files.find(f => f.path === 'AGENTS.md').data.toString(), 'CLAUDE.md');
  commit(first.root);
  if (process.platform === 'win32') writeFileSync(join(first.root, 'plugins/alpha/.claude/skills/sample'), '../../skills/sample\r\n');
  assert.deepEqual(sync(t, first.root, source).changed, []);
  save(source, 'alpha/CLAUDE.md', '# Changed instructions');
  commit(source);
  assert.equal(sync(t, first.root, source).reports.find(r => r.name === 'alpha').status, 'UPDATED');
  const malicious = git(source, ['hash-object', '-w', '--stdin'], { input: Buffer.from('../beta/LICENSE') }).toString().trim();
  git(source, ['update-index', '--cacheinfo', `120000,${malicious},alpha/AGENTS.md`]);
  commit(source);
  assert.throws(() => sync(t, first.root, source), /symlink escapes package/);
  assert.equal(validate(first.root).accepted.size, 2);
  assert.deepEqual(git(root, ['status', '--porcelain=v1', '-z']), before);
  assert.equal(validate(root).accepted.size, 0);
});

test('symlinks resolve files and allow internal directory targets', () => {
  const files = [...pkg(), file('CLAUDE.md', '# Instructions'), file('AGENTS.md', './CLAUDE.md', '120000'),
    file('nested/alias.md', '../AGENTS.md', '120000'), file('.claude/skills/example', '../../skills/example', '120000')];
  validatePackage(files, 'alpha', limits);
  assert.equal(resolveLinks(files).get('nested/alias.md').path, 'CLAUDE.md');
  const hash = contentHash(files);
  assert.notEqual(hash, contentHash(files.map(f => f.path === 'AGENTS.md' ? file(f.path, 'CLAUDE.md', '120000') : f)));
  for (const target of ['../CLAUDE.md', '../../outside', '/etc/passwd', 'C:/secret', '\\\\host\\share',
    'missing', '.', 'AGENTS.md', 'nested/alias.md', 'missing/../CLAUDE.md',
    'CLAUDE.md/../CLAUDE.md', 'skills/../../CLAUDE.md', '.git/config', 'NUL', 'CLAUDE.md\0']) {
    assert.throws(() => validatePackage(files.map(f => f.path === 'AGENTS.md' ? file(f.path, target, '120000') : f), 'alpha', limits), undefined, target);
  }
  assert.throws(() => resolveLinks([file('a', 'b', '120000'), file('b', 'c', '120000'), file('c', 'a', '120000')]), /cycle/);
  assert.throws(() => resolveLinks([file('a', Buffer.from([0xff]), '120000')]), /UTF-8/);
  const linkedManifest = [file('.claude-plugin/plugin.json', '../manifest.json', '120000'), file('manifest.json', json({ name: 'alpha' }))];
  assert.equal(validatePackage(linkedManifest, 'alpha', limits).name, 'alpha');
});

test('catalog order is stable and metadata is read from the accepted packages', () => {
  const accepted = new Map([
    ['beta', { info: { version: '2.0.0', description: 'Beta' } }],
    ['alpha', { info: { version: '1.0.0', description: 'Alpha' } }],
  ]);
  const first = catalogs(validateConfig(config()), accepted);
  assert.deepEqual(first, catalogs(validateConfig(config()), new Map([...accepted].reverse())));
  assert.deepEqual(JSON.parse(first[0]).plugins.map(p => p.source), ['./plugins/alpha', './plugins/beta']);
  assert.equal(JSON.parse(first[1]).plugins[0].source.path, './plugins/alpha');
  assert.equal(JSON.parse(first[0]).plugins[0].description, 'Alpha');
});

test('CI checks generated catalogs including untracked files', t => {
  const root = mirror(t);
  const script = fileURLToPath(new URL('../scripts/check-generated.ts', import.meta.url));
  const run = () => spawnSync(process.execPath, ['--experimental-strip-types', script], { cwd: root, encoding: 'utf8' });
  assert.equal(run().status, 0);
  const path = '.agents/plugins/marketplace.json';
  write(root, path, '{}');
  assert.equal(run().status, 1);
  generate(root);
  git(root, ['update-index', '--force-remove', '--', path]);
  assert.equal(run().status, 1);
  assert.match(run().stderr, /Generated catalogs differ/);
});
