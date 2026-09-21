import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readConfig, safePath, validateConfig } from '../src/config.ts';

const base = () => ({ marketplace: { name: 'test', owner: { name: 'Test' } }, sources: [
  { id: 'one', type: 'marketplace', repository: 'owner/repo', branch: 'main', selection: 'all' },
] });

test('initial sources, defaults, all exclusions and empty selected', () => {
  const initial = readConfig(fileURLToPath(new URL('..', import.meta.url)));
  assert.deepEqual(initial.sources.map(s => s.repository), [
    'DietrichGebert/ponytail', 'mattpocock/skills', 'obra/superpowers', 'anthropics/claude-plugins-official', 'talkstream/ru-text',
  ]);
  assert(initial.sources.every(s => s.branch === 'main'));
  const config = base();
  assert.equal(validateConfig(config).limits.maxFileSizeMb, 5);
  config.sources[0].exclude = ['skip'];
  assert.deepEqual(validateConfig(config).sources[0].exclude, ['skip']);
  delete config.sources[0].exclude;
  Object.assign(config.sources[0], { selection: 'selected', plugins: [] });
  assert.deepEqual(validateConfig(config).sources[0].plugins, []);
  Object.assign(config.sources[0], { type: 'repository', plugins: [{ name: 'some-plugin', path: './', enabled: false }] });
  assert.equal(validateConfig(config).sources[0].plugins[0].path, '.');
});

test('reject invalid configuration before any network is possible', () => {
  const changes = [
    c => { c.extra = true; }, c => { c.sources[0].enabled = 'false'; },
    c => { c.sources.push({ ...c.sources[0] }); },
    c => { c.sources.push({ ...c.sources[0], id: 'two' }); },
    c => { c.sources[0].repository = 'https://secret@github.com/a/b'; },
    c => { c.sources[0].plugins = []; }, c => { c.sources[0].selection = 'guess'; },
    c => { c.sources[0].type = 'repository'; }, c => { c.sources[0].branch = '--upload-pack=evil'; },
    c => { c.sources[0].exclude = ['same', 'same']; },
    c => { c.sources[0].exclude = ['con']; },
    c => { c.limits = { maxFileSizeMb: 0 }; }, c => { c.limits = { maxPluginSizeMb: Infinity }; },
    c => { c.sources[0] = { ...c.sources[0], selection: 'selected', plugins: [], exclude: [] }; },
    c => { c.marketplace.owner.name = ''; },
  ];
  for (const change of changes) { const config = base(); change(config); assert.throws(() => validateConfig(config)); }
  const config = base();
  Object.assign(config.sources[0], { selection: 'selected', plugins: [{ name: 'same' }] });
  config.sources.push({ ...config.sources[0], id: 'two', repository: 'owner/other' });
  assert.throws(() => validateConfig(config), /collision/);
  config.sources[1].enabled = false;
  assert.equal(validateConfig(config).sources.length, 2);
});

test('portable paths reject traversal, device names and alternate separators', () => {
  for (const path of ['../outside', '/etc', 'C:/x', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a/NUL.txt', '.git/config', 'x.', 'x ', 'x\n']) {
    assert.throws(() => safePath(path));
  }
  assert.equal(safePath('./skills/my-skill'), 'skills/my-skill');
});
