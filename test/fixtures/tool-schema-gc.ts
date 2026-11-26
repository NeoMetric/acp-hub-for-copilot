import { setImmediate } from 'node:timers/promises';
import { ToolSchemas } from '../../src/engine/mcp/toolSchemas';

async function main(): Promise<void> {
	if (!global.gc) {throw new Error('Run with --expose-gc');}
	const results = [];
	for (const dialect of [
		'http://json-schema.org/draft-07/schema#',
		'https://json-schema.org/draft/2019-09/schema',
		'https://json-schema.org/draft/2020-12/schema',
	]) {
		const cache = new ToolSchemas(() => undefined);
		const schema = (n: number) => ({ $schema: dialect, type: 'object', properties: { n: { const: n } } });
		const evicted = new WeakRef(cache.validator(schema(0)));
		for (let i = 1; i <= 128; i++) {cache.validator(schema(i));}
		let collected = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			// WeakRef keeps its target alive until the end of the current job.
			await setImmediate();
			global.gc();
			if (evicted.deref() === undefined) {
				collected = true;
				break;
			}
		}
		if (!cache.validator(schema(128))({ n: 128 })) {throw new Error('Retained validator failed');}
		results.push({ dialect, collected });
	}
	process.stdout.write(JSON.stringify(results));
}

void main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
