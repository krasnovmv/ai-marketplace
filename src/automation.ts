import { check, branch, repository, safePath } from './config.ts';
import { git } from './git.ts';
import { catalogPaths } from './mirror.ts';

export const botBranch = 'bot/plugin-sync';
const botEmail = '41898282+github-actions[bot]@users.noreply.github.com';
const commitMessage = 'chore: sync upstream plugins\n\nMarketplace-Sync: v1';
const marker = '<!-- marketplace-sync:v1 -->';

export function managedPath(path) {
  if (catalogPaths.includes(path)) return true;
  safePath(path);
  return /^(plugins\/[a-z0-9]+(?:-[a-z0-9]+)*\/.+|metadata\/[a-z0-9]+(?:-[a-z0-9]+)*\.json)$/.test(path);
}

export function assertBotCommit(root, head, base, runGit = git) {
  const parents = runGit(root, ['rev-list', '--parents', '-n', '1', head]).toString().trim().split(' ');
  check(parents.length === 2, botBranch, 'foreign or merged commits; refusing to overwrite');
  runGit(root, ['merge-base', '--is-ancestor', parents[1], base]);
  const identity = runGit(root, ['show', '-s', '--format=%ae%n%ce%n%B', head]).toString().trim();
  check(identity === `${botEmail}\n${botEmail}\n${commitMessage}`, botBranch, 'foreign commit; refusing to overwrite');
  const paths = runGit(root, ['diff', '--name-only', '-z', parents[1], head]).toString().split('\0').filter(Boolean);
  check(paths.length > 0 && paths.every(managedPath), botBranch, 'commit contains unmanaged paths');
}

export function reportBody(result, repo) {
  return `${marker}\nUpdates from verified upstream revisions. Merge remains manual.\n\n`
    + '| Plugin | Status | Accepted SHA | Checked SHA |\n|---|---|---|---|\n'
    + result.reports.map(r => {
      const link = `https://github.com/${r.repository ?? repo}`;
      return `| [${r.name}](${link}) | ${r.status} | ${r.accepted ?? '—'} | ${r.checked ?? '—'} |`;
    }).join('\n') + '\n';
}

export async function publishCandidate(result, { repo, defaultBranch, initialBot, api, runGit = git }) {
  repository(repo, 'GITHUB_REPOSITORY');
  branch(defaultBranch, 'DEFAULT_BRANCH');
  check(result.root && /^[a-f0-9]{40}$/.test(result.base), 'candidate', 'validated candidate required');
  const root = result.root;
  const remote = `https://github.com/${repo}.git`;
  const basePath = `/git/ref/heads/${encodeURIComponent(defaultBranch)}`;
  const botPath = `/git/ref/heads/${encodeURIComponent(botBranch)}`;
  const owner = repo.split('/')[0];
  async function assertFresh() {
    check((await api(basePath)).object.sha === result.base, 'default branch', 'changed during preparation; retry');
    check(((await api(botPath, { missing: true }))?.object.sha ?? null) === initialBot, botBranch, 'changed during preparation; retry');
  }
  await assertFresh();
  if (initialBot) {
    runGit(root, ['fetch', '--no-tags', '--no-recurse-submodules', remote, initialBot]);
    assertBotCommit(root, initialBot, result.base, runGit);
  }
  const pulls = await api(`/pulls?state=open&head=${encodeURIComponent(`${owner}:${botBranch}`)}&base=${encodeURIComponent(defaultBranch)}`);
  check(pulls.length <= 1, botBranch, 'multiple pull requests');
  const existing = pulls[0];
  if (existing) check(existing.user.login === 'github-actions[bot]' && existing.body?.startsWith(marker), botBranch, 'foreign pull request; refusing to edit');
  if (result.changed.length === 0) {
    if (existing) {
      await assertFresh();
      await api(`/pulls/${existing.number}`, { method: 'PATCH', body: { state: 'closed', body: `${existing.body}\nClosed after a successful complete comparison: no updates remain.\n` } });
    }
    return { status: 'UNCHANGED', pr: existing?.html_url ?? null };
  }
  check(result.changed.every(managedPath), 'candidate', 'contains unmanaged paths');
  const staged = runGit(root, ['diff', '--cached', '--name-only', '-z', result.base]).toString().split('\0').filter(Boolean);
  check(staged.length === result.changed.length && staged.every(p => result.changed.includes(p)), 'candidate', 'index changed after validation');
  const tree = runGit(root, ['write-tree']).toString().trim();
  const previousTree = initialBot ? runGit(root, ['rev-parse', `${initialBot}^{tree}`]).toString().trim() : null;
  let head = initialBot;
  if (tree !== previousTree) {
    runGit(root, ['-c', 'user.name=github-actions[bot]', '-c', `user.email=${botEmail}`, '-c', 'commit.gpgsign=false', 'commit', '-m', commitMessage]);
    head = runGit(root, ['rev-parse', 'HEAD']).toString().trim();
    await assertFresh();
    runGit(root, ['push', `--force-with-lease=refs/heads/${botBranch}:${initialBot ?? ''}`, remote, `${head}:refs/heads/${botBranch}`]);
  }
  const body = reportBody(result, repo);
  const pr = existing
    ? await api(`/pulls/${existing.number}`, { method: 'PATCH', body: { title: 'Update mirrored plugins', body } })
    : await api('/pulls', { method: 'POST', body: { title: 'Update mirrored plugins', head: botBranch, base: defaultBranch, body } });
  // GITHUB_TOKEN pushes do not trigger normal push workflows; dispatch is explicitly supported.
  await api('/actions/workflows/validate.yml/dispatches', { method: 'POST', body: { ref: botBranch } });
  return { status: 'PUBLISHED', head, pr: pr.html_url };
}
