import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, safePath } from './config.js';

export function git(cwd, args, { input, timeout = 120000, maxBuffer = 64 * 1048576, gitEnv = {} } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  env.GIT_TERMINAL_PROMPT = '0';
  Object.assign(env, gitEnv);
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false',
    '-c', 'core.quotePath=false', '-c', 'protocol.ext.allow=never', ...args],
  { cwd, input, timeout, maxBuffer, env, windowsHide: true });
  // Never include subprocess output: Git and credential helpers may print secrets.
  if (result.error || result.status !== 0) {
    throw new Error(`Git ${args[0]} failed (${result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'access, revision or command error'})`);
  }
  return result.stdout;
}

export function temporary(prefix = 'marketplace-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function fetchSource(source, url = `https://github.com/${source.repository}.git`, options = {}) {
  const temp = temporary('marketplace-upstream-');
  try {
    const remote = git(temp.root, ['ls-remote', '--exit-code', '--refs', url, `refs/heads/${source.branch}`], options).toString().trim();
    const matches = remote.split('\n').filter(line => line.endsWith(`\trefs/heads/${source.branch}`));
    check(matches.length === 1, source.id, 'branch did not resolve uniquely');
    const commit = matches[0].split('\t')[0];
    check(/^[a-f0-9]{40}$/.test(commit), source.id, 'expected full commit SHA');
    git(temp.root, ['init', '--bare', '--template='], options);
    git(temp.root, ['fetch', '--no-tags', '--no-recurse-submodules', '--depth=1', url, commit], options);
    check(git(temp.root, ['rev-parse', 'FETCH_HEAD^{commit}'], options).toString().trim() === commit, source.id, 'revision mismatch');
    return { ...temp, commit, entries: readTree(temp.root, commit) };
  } catch (error) {
    temp.cleanup();
    throw new Error(`${source.id}: BROKEN: ${error.message}`);
  }
}

export function readTree(root, commit) {
  const output = git(root, ['ls-tree', '-rlz', '--full-tree', commit]);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(output); }
  catch { throw new Error('Git tree: non-UTF-8 paths are unsupported'); }
  return text.split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/.exec(record);
    check(match, 'Git tree', 'invalid entry');
    return { mode: match[1], type: match[2], oid: match[3], size: Number(match[4]), path: match[5] };
  });
}

export function readBlob(root, entry, maxBytes, allowLink = false) {
  safePath(entry.path);
  check(entry.type === 'blob' && (['100644', '100755'].includes(entry.mode) || allowLink && entry.mode === '120000'), entry.path, 'unsupported Git mode (link/submodule)');
  check(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= maxBytes, entry.path, 'file size limit exceeded');
  const data = git(root, ['cat-file', 'blob', entry.oid], { maxBuffer: Math.max(1, entry.size + 1) });
  check(data.length === entry.size, entry.path, 'blob size mismatch');
  return data;
}

export function indexFile(root, path, data, mode = '100644') {
  safePath(path);
  const oid = git(root, ['hash-object', '-w', '--stdin'], { input: data }).toString().trim();
  git(root, ['update-index', '--add', '--cacheinfo', `${mode},${oid},${path}`]);
}
