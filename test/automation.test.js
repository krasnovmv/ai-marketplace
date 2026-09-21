import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishCandidate, managedPath, reportBody } from '../src/automation.js';

const base = 'a'.repeat(40);
const bot = 'b'.repeat(40);
const head = 'c'.repeat(40);
const marker = '<!-- marketplace-sync:v1 -->';
const existing = { number: 7, body: marker, user: { login: 'github-actions[bot]' }, html_url: 'https://github.com/test/mirror/pull/7' };

function scenario(options = {}) {
  const calls = [];
  const result = { root: '/candidate', base, changed: ['plugins/alpha/SKILL.md'], reports: [{
    name: 'alpha', source: 'source', repository: 'example/upstream', status: 'UPDATED', accepted: base, checked: head,
  }], ...options.result };
  const context = {
    repo: 'test/mirror', defaultBranch: 'main', initialBot: options.initialBot ?? null,
    async api(path, request = {}) {
      calls.push({ type: 'api', path, ...request });
      if (path === '/git/ref/heads/main') return { object: { sha: options.newBase ?? base } };
      if (path === '/git/ref/heads/bot%2Fplugin-sync') {
        const sha = options.newBot ?? context.initialBot;
        return sha ? { object: { sha } } : null;
      }
      if (path.startsWith('/pulls?')) return options.existing ? [options.existing] : [];
      if (path.startsWith('/pulls')) return existing;
      if (path === '/actions/workflows/validate.yml/dispatches') return null;
      throw new Error(`unexpected API ${path}`);
    },
    runGit(root, args) {
      calls.push({ type: 'git', args });
      if (args[0] === 'rev-list') return Buffer.from(`${bot} ${base}`);
      if (args[0] === 'show') return Buffer.from(options.foreign ? 'foreign author' : '41898282+github-actions[bot]@users.noreply.github.com\n41898282+github-actions[bot]@users.noreply.github.com\nchore: sync upstream plugins\n\nMarketplace-Sync: v1');
      if (args[0] === 'diff') return Buffer.from(`${(options.staged ?? result.changed).join('\0')}\0`);
      if (args[0] === 'write-tree') return Buffer.from('new-tree');
      if (args[0] === 'rev-parse') return Buffer.from(args[1] === 'HEAD' ? head : options.sameTree ? 'new-tree' : 'old-tree');
      return Buffer.alloc(0);
    },
  };
  return { calls, result, context, run: () => publishCandidate(result, context) };
}

test('publisher creates a single PR, leases only the bot branch and explicitly dispatches validation', async () => {
  const s = scenario();
  const outcome = await s.run();
  assert.equal(outcome.status, 'PUBLISHED');
  assert.equal(outcome.head, head);
  const push = s.calls.find(c => c.args?.[0] === 'push');
  assert(push.args.includes('--force-with-lease=refs/heads/bot/plugin-sync:'));
  assert(push.args.includes(`${head}:refs/heads/bot/plugin-sync`));
  assert(!push.args.some(a => a.endsWith(':refs/heads/main')));
  const post = s.calls.find(c => c.path === '/pulls');
  assert.equal(post.body.base, 'main');
  assert.match(post.body.body, /example\/upstream/);
  assert(s.calls.some(c => c.path === '/actions/workflows/validate.yml/dispatches' && c.body.ref === 'bot/plugin-sync'));
});

test('publisher updates its existing PR and preserves a matching bot commit', async () => {
  const s = scenario({ initialBot: bot, existing, sameTree: true });
  assert.equal((await s.run()).head, bot);
  assert(!s.calls.some(c => c.args?.[0] === 'push' || c.args?.includes('commit')));
  assert(s.calls.some(c => c.path === '/pulls/7' && c.method === 'PATCH'));
  assert(!s.calls.some(c => c.path === '/pulls' && c.method === 'POST'));
});

test('no-op never pushes; an obsolete bot PR closes only after successful comparison', async () => {
  const empty = scenario({ result: { changed: [] } });
  assert.equal((await empty.run()).status, 'UNCHANGED');
  assert(!empty.calls.some(c => c.method || c.args?.[0] === 'push'));
  const stale = scenario({ initialBot: bot, existing, result: { changed: [] }, staged: ['metadata/alpha.json'] });
  assert.equal((await stale.run()).status, 'UNCHANGED');
  assert(stale.calls.some(c => c.path === '/pulls/7' && c.body.state === 'closed'));
  assert(!stale.calls.some(c => c.args?.[0] === 'push'));
});

test('races, foreign commits/PRs and unmanaged or changed staging block publication', async () => {
  for (const options of [
    { newBase: 'd'.repeat(40) }, { newBot: bot },
    { initialBot: bot, foreign: true },
    { existing: { ...existing, user: { login: 'someone' } } },
    { result: { changed: ['src/cli.js'] } },
    { staged: ['plugins/alpha/other.md'] },
  ]) {
    const s = scenario(options);
    await assert.rejects(s.run());
    assert(!s.calls.some(c => c.method || c.args?.[0] === 'push'));
  }
});

test('managed paths and reports preserve meaningful revisions without allowing root workflow edits', () => {
  assert(managedPath('plugins/alpha/.github/workflows/upstream.yml'));
  assert(managedPath('metadata/alpha.json'));
  assert(!managedPath('.github/workflows/sync.yml'));
  assert.throws(() => managedPath('plugins/alpha/../../src/cli.js'));
  const s = scenario();
  const text = reportBody(s.result, 'test/mirror');
  assert(text.includes(base) && text.includes(head));
});
