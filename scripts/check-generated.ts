import { git } from '../src/git.ts';
import { catalogPaths } from '../src/mirror.ts';

const changes = git(process.cwd(), ['status', '--porcelain', '--untracked-files=all', '--', ...catalogPaths]).toString();
if (changes) {
  console.error(`Generated catalogs differ:\n${changes}`);
  process.exitCode = 1;
}
