// Rewrites the generated parts of package.json from registry/agents.json.
// Run with `node scripts/generate-vendors.ts`; add `--check` to only compare.
import { readFileSync, writeFileSync } from 'node:fs';
import { applyRegistry } from '../src/core/vendors.ts';

const registry = JSON.parse(readFileSync('registry/agents.json', 'utf8'));
const current = readFileSync('package.json', 'utf8');
const generated = JSON.stringify(applyRegistry(JSON.parse(current), registry), null, '\t') + '\n';

if (process.argv.includes('--check')) {
	if (current.replace(/\r\n/g, '\n') !== generated) {
		console.error('package.json is out of date. Run: npm run generate');
		process.exit(1);
	}
	console.log('package.json is up to date.');
} else {
	writeFileSync('package.json', generated);
	console.log('package.json updated.');
}
