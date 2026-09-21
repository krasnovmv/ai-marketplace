import { git } from '../src/git.js';
import { catalogPaths } from '../src/mirror.js';

const changes = git(process.cwd(), ['status', '--porcelain', '--untracked-files=all', '--', ...catalogPaths]).toString();
if (changes) {
  console.error(`Generated catalogs differ:\n${changes}`);
  process.exitCode = 1;
}
