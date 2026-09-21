import { appendFileSync } from 'node:fs';
import { check, repository, branch } from '../src/config.js';
import { git } from '../src/git.js';
import { prepare } from '../src/mirror.js';
import { botBranch, publishCandidate } from '../src/automation.js';

let result;
try {
  check(process.env.GITHUB_ACTIONS === 'true', 'environment', 'run this publisher only in GitHub Actions');
  const repo = repository(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const defaultBranch = branch(process.env.DEFAULT_BRANCH, 'DEFAULT_BRANCH');
  const token = process.env.GH_TOKEN;
  check(Boolean(token), 'GH_TOKEN', 'token is required');
  async function api(path, { method = 'GET', body, missing = false } = {}) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
    });
    if (missing && response.status === 404) return null;
    check(response.ok, 'GitHub API', `request failed (${response.status}); check repository Actions permissions`);
    return response.status === 204 ? null : response.json();
  }
  const initialBot = (await api(`/git/ref/heads/${encodeURIComponent(botBranch)}`, { missing: true }))?.object.sha ?? null;
  result = prepare(process.cwd());
  const runGit = (root, args) => git(root, args, { gitEnv: {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  } });
  const outcome = await publishCandidate(result, { repo, defaultBranch, initialBot, api, runGit });
  console.log(JSON.stringify(outcome));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${outcome.status}${outcome.pr ? `: ${outcome.pr}` : ': no plugin changes'}\n`);
} catch (error) {
  console.error(`BROKEN: ${error.message}`);
  process.exitCode = 1;
} finally {
  result?.cleanup();
}
