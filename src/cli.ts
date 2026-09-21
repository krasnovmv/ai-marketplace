import { resolve } from 'node:path';
import { generate, prepare, validate } from './mirror.ts';

const [command, ...args] = process.argv.slice(2);
try {
  if (!['sync', 'validate', 'generate', 'diff'].includes(command)
    || !(args.length === 0 || command === 'sync' && args.length === 1 && args[0] === '--dry-run')) {
    throw new Error('Usage: npm run sync [-- --dry-run] | npm run validate | npm run generate | npm run diff');
  }
  const root = resolve('.');
  if (command === 'validate') {
    const result = validate(root);
    console.log(`VALID: ${result.accepted.size} plugins${result.pending ? '; config differs from accepted set: run sync' : ''}`);
  } else if (command === 'generate') {
    generate(root);
    console.log('Generated both marketplace catalogs');
  } else {
    const result = prepare(root, { dryRun: command === 'diff' || args.includes('--dry-run') });
    for (const report of result.reports) console.log(JSON.stringify(report));
    console.log(result.diff || 'No changes');
    if (result.root) console.log(`VALIDATED candidate: ${result.root}`);
  }
} catch (error) {
  console.error(`BROKEN: ${error.message}`);
  process.exitCode = 1;
}
