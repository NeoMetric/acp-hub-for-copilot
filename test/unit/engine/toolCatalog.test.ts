import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpBridge, type McpServerEndpoint } from '../../../src/engine/mcp/bridge';
import type { ToolDef } from '../../../src/engine/model/chat';
import { ToolCatalog } from '../../../src/engine/mcp/toolCatalog';

interface Reply {
	result?: { tools?: ToolDef[]; content?: Array<{ type: string; text: string }>; isError?: boolean };
	error?: { code: number; message: string };
}

const bridges: McpBridge[] = [];
const log = vi.fn();
const bash: ToolDef = {
	name: 'bash',
	description: 'Run shell commands. ' + 'Keep all instructions: "quoted"\n'.repeat(400),
	inputSchema: {
		type: 'object',
		properties: { command: { type: 'string', minLength: 1 }, description: { type: 'string' }, mode: { enum: ['sync', 'async'] } },
		required: ['command', 'description'],
		additionalProperties: false,
	},
};
const tools: ToolDef[] = [bash, ...Array.from({ length: 98 }, (_, index) => ({ name: `tool_${String(index).padStart(3, '0')}`, description: 'Reads workspace data', inputSchema: { type: 'object' } }))];

function bridge(): McpBridge {
	const created = new McpBridge(log);
	bridges.push(created);
	return created;
}

async function rpc(endpoint: McpServerEndpoint, method: string, params?: unknown): Promise<Reply> {
	const response = await fetch(endpoint.url, {
		method: 'POST',
		headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
	expect(response.status).toBe(200);
	return response.json();
}

async function catalog(endpoint: McpServerEndpoint, args: unknown): Promise<string> {
	const reply = await rpc(endpoint, 'tools/call', { name: 'tool_catalog', arguments: args });
	expect(reply.error).toBeUndefined();
	const text = reply.result?.content?.[0]?.text;
	if (text === undefined) {throw new Error('Missing catalog response');}
	expect(text.length).toBeLessThanOrEqual(3_500);
	return text;
}

afterEach(() => {
	for (const item of bridges.splice(0)) {item.dispose();}
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

describe('catalog tool presentation', () => {
	it('exposes two small entry points while preserving every original definition in bounded pages', async () => {
		const endpoint = await bridge().registerSession(tools, async () => undefined, { toolPresentation: 'catalog', maxResultChars: 3_500 });
		const listed = await rpc(endpoint, 'tools/list');
		expect(listed.result?.tools?.map(tool => tool.name)).toEqual(['tool_catalog', 'call_tool']);
		expect(JSON.stringify(listed.result?.tools).length).toBeLessThan(3_500);
		const found: { names: string[] } = JSON.parse(await catalog(endpoint, { query: 'shell commands' }));
		expect(found.names).toEqual(['bash']);
		let cursor: number | undefined = 0;
		let definition = '';
		let pages = 0;
		do {
			const page: { definition: string; nextCursor?: number } = JSON.parse(await catalog(endpoint, { name: 'bash', cursor }));
			definition += page.definition;
			cursor = page.nextCursor;
			pages++;
		} while (cursor !== undefined);
		expect(pages).toBeGreaterThan(1);
		expect(JSON.parse(definition)).toEqual(bash);
	});

	it('paginates a large directory without losing or repeating names', async () => {
		const many = Array.from({ length: 99 }, (_, index) => ({ name: `${index}_${'long_name_'.repeat(15)}`, description: '', inputSchema: {} }));
		const endpoint = await bridge().registerSession(many, async () => undefined, { toolPresentation: 'catalog', maxResultChars: 500 });
		const names: string[] = [];
		let cursor: number | undefined = 0;
		do {
			const text = await catalog(endpoint, { cursor });
			expect(text.length).toBeLessThanOrEqual(500);
			const page: { names: string[]; nextCursor?: number } = JSON.parse(text);
			names.push(...page.names);
			cursor = page.nextCursor;
		} while (cursor !== undefined);
		expect(names).toEqual(many.map(tool => tool.name).sort());
	});

	it('forwards the original name and parsed arguments and preserves client errors', async () => {
		const execute = vi.fn(async () => ({ content: ['Client denied this command'], isError: true }));
		const endpoint = await bridge().registerSession(tools, execute, { toolPresentation: 'catalog' });
		const input = { command: 'printf probe', description: 'Probe' };
		const reply = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson: JSON.stringify(input) } });
		expect(execute).toHaveBeenCalledWith('bash', input, expect.objectContaining({ isCancellationRequested: false }));
		expect(reply.result).toEqual({ content: [{ type: 'text', text: 'Client denied this command' }], isError: true });
	});

	it.each(['not json', '[]', 'null', '{}', '{"command":42,"description":"probe"}', '{"command":"","description":"probe"}', '{"command":"ls","description":"probe","mode":"invalid"}'])('rejects invalid original arguments before forwarding: %s', async argumentsJson => {
		const execute = vi.fn(async () => ({ content: [] }));
		const endpoint = await bridge().registerSession(tools, execute, { toolPresentation: 'catalog' });
		const reply = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson } });
		expect(reply.error).toBeUndefined();
		expect(reply.result?.isError).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it('checks referenced and composed schemas without changing the input', async () => {
		const tool: ToolDef = { name: 'choose', description: '', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', $defs: { choice: { anyOf: [{ type: 'integer', minimum: 2 }, { type: 'string', pattern: '^ok$' }] } }, properties: { value: { $ref: '#/$defs/choice' } }, required: ['value'] } };
		const execute = vi.fn(async () => ({ content: ['ok'] }));
		const endpoint = await bridge().registerSession([tool], execute, { toolPresentation: 'catalog' });
		const call = (value: unknown) => rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'choose', argumentsJson: JSON.stringify({ value }) } });
		expect((await call(1)).result?.isError).toBe(true);
		expect((await call('ok')).error).toBeUndefined();
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]).toEqual(['choose', { value: 'ok' }, expect.anything()]);
	});

	it('refuses withdrawn and other-session tools, including direct calls', async () => {
		const instance = bridge();
		const execute = vi.fn(async () => ({ content: [] }));
		const endpoint = await instance.registerSession([bash], execute, { toolPresentation: 'catalog' });
		await instance.registerSession([{ name: 'private', description: '', inputSchema: {} }], execute, { toolPresentation: 'catalog' });
		instance.updateTools(endpoint.token, []);
		for (const name of ['bash', 'private']) {
			const reply = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name, argumentsJson: '{}' } });
			expect(reply.result?.isError).toBe(true);
		}
		expect((await rpc(endpoint, 'tools/call', { name: 'bash', arguments: {} })).error?.code).toBe(-32602);
		expect(JSON.parse(await catalog(endpoint, {})).names).toEqual([]);
		expect(execute).not.toHaveBeenCalled();
	});

	it('keeps direct presentation and empty sessions unchanged', async () => {
		const instance = bridge();
		const direct = await instance.registerSession([bash], async () => ({ content: ['ok'] }));
		expect((await rpc(direct, 'tools/list')).result?.tools).toEqual([bash]);
		const empty = await instance.registerSession([], async () => undefined, { toolPresentation: 'catalog' });
		expect((await rpc(empty, 'tools/list')).result?.tools).toEqual([]);
	});

	it('uses updated schemas and exposes newly enabled tools', async () => {
		const instance = bridge();
		const execute = vi.fn(async () => ({ content: ['ok'] }));
		const endpoint = await instance.registerSession([bash], execute, { toolPresentation: 'catalog' });
		const invoke = () => rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson: '{"command":"ls","description":"probe"}' } });
		expect((await invoke()).error).toBeUndefined();
		instance.updateTools(endpoint.token, [{ ...bash, inputSchema: { type: 'object', required: ['newArgument'] } }, { name: 'new_tool', description: '', inputSchema: {} }]);
		expect((await invoke()).result?.isError).toBe(true);
		expect(JSON.parse(await catalog(endpoint, { query: 'new_tool' })).names).toEqual(['new_tool']);
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('reports invalid schemas explicitly without executing', async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const endpoint = await bridge().registerSession([{ name: 'invalid', description: '', inputSchema: { type: 'object', properties: { value: { type: 'not-a-type' } } } }], execute, { toolPresentation: 'catalog' });
		const reply = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'invalid', argumentsJson: '{}' } });
		expect(reply.error).toBeUndefined();
		expect(reply.result?.isError).toBe(true);
		expect(reply.result?.content?.[0]?.text).toContain('Cannot validate the input schema');
		expect(log).toHaveBeenCalledWith(expect.stringContaining('Cannot validate'), 'warn');
		expect(execute).not.toHaveBeenCalled();
	});

	it.each([null, { cursor: null }, { cursor: -1 }, { cursor: 1.5 }, { cursor: 1000 }, { query: 1 }, { name: 'bash', query: 'shell' }, { name: 'bash', cursor: 1_000_000 }])('rejects invalid catalog arguments: %j', async input => {
		const endpoint = await bridge().registerSession([bash], async () => undefined, { toolPresentation: 'catalog' });
		const reply = await rpc(endpoint, 'tools/call', { name: 'tool_catalog', arguments: input });
		expect(reply.error).toBeUndefined();
		expect(reply.result?.isError).toBe(true);
	});

	it('propagates cancellation to the original client call', async () => {
		let calls = 0;
		let announce: () => void = () => undefined;
		const started = new Promise<void>(resolve => { announce = resolve; });
		let cancelled: () => void = () => undefined;
		const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
		const endpoint = await bridge().registerSession([bash], async (_name, _input, token) => {
			if (++calls > 1) {return { content: ['after cancellation'] };}
			announce();
			await new Promise<void>(resolve => token.onCancellationRequested(() => { cancelled(); resolve(); }));
			return { content: [], isError: true };
		}, { toolPresentation: 'catalog' });
		const controller = new AbortController();
		const result = fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ id: 1, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'bash', argumentsJson: '{"command":"ls","description":"probe"}' } } }), signal: controller.signal });
		const rejected = expect(result).rejects.toThrow();
		await started;
		controller.abort();
		await rejected;
		await cancellation;
		const next = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson: '{"command":"ls","description":"probe"}' } });
		expect(next.result?.content?.[0]?.text).toBe('after cancellation');
	});

	it('lets an agent correct a failed invocation without reopening the session', async () => {
		const execute = vi.fn(async () => ({ content: ['corrected'] }));
		const endpoint = await bridge().registerSession([bash], execute, { toolPresentation: 'catalog', maxResultChars: 500 });
		const invalid = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson: '{}' } });
		expect(invalid.error).toBeUndefined();
		expect(invalid.result?.isError).toBe(true);
		expect(invalid.result?.content?.[0]?.text).toContain('required');
		const valid = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'bash', argumentsJson: '{"command":"ls","description":"probe"}' } });
		expect(valid.result?.content?.[0]?.text).toBe('corrected');
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it('bounds diagnostic content while keeping malformed protocol calls as RPC errors', async () => {
		const execute = vi.fn(async () => ({ content: [] }));
		const endpoint = await bridge().registerSession([bash], execute, { toolPresentation: 'catalog', maxResultChars: 500 });
		const reply = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'missing'.repeat(1000), argumentsJson: '{}' } });
		expect(reply.error).toBeUndefined();
		expect(reply.result?.isError).toBe(true);
		expect(reply.result?.content?.[0]?.text.length).toBeLessThanOrEqual(500);
		expect((await rpc(endpoint, 'tools/call', { name: '' })).error?.code).toBe(-32602);
		expect((await rpc(endpoint, 'tools/call', { name: 'not_an_entry' })).error?.code).toBe(-32602);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(['array', 'object'])('preserves deeply nested %s arguments while rejecting numeric overflow', async kind => {
		const depth = 2_500;
		const open = kind === 'array' ? '[' : '{"value":';
		const close = kind === 'array' ? ']' : '}';
		const argumentsWith = (value: string) => '{"data":' + open.repeat(depth) + value + close.repeat(depth) + '}';
		const execute = vi.fn(async (_name: string, input: unknown) => ({ content: [JSON.stringify(input)] }));
		const endpoint = await bridge().registerSession([{ name: 'json_data', description: '', inputSchema: { type: 'object' } }], execute, { toolPresentation: 'catalog' });
		const call = (argumentsJson: string) => rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'json_data', argumentsJson } });
		const valid = argumentsWith('1');
		expect(JSON.stringify(JSON.parse(valid))).toBe(valid);
		expect((await call(valid)).result?.isError).not.toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect((await execute.mock.results[0].value).content[0]).toBe(valid);
		const invalid = await call(argumentsWith('1e400'));
		expect(invalid.result?.isError).toBe(true);
		expect(invalid.result?.content?.[0]?.text).toContain('finite');
		expect(execute).toHaveBeenCalledTimes(1);
	});

	it.each([
		[{ type: 'object', properties: { n: { type: 'number' } } }, '{"n":1e400}'],
		[{ type: 'object', properties: { n: { type: 'number' } } }, '{"n":-1e400}'],
		[{ type: 'object' }, '{"nested":[{"n":1e400}]}'],
		[true, '{"nested":[-1e400]}'],
	])('rejects overflowing numbers before forwarding, even without numeric constraints: %j', async (inputSchema, argumentsJson) => {
		const execute = vi.fn(async () => ({ content: ['ok'] }));
		const endpoint = await bridge().registerSession([{ name: 'number_probe', description: '', inputSchema }], execute, { toolPresentation: 'catalog' });
		const invalid = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'number_probe', argumentsJson } });
		expect(invalid.error).toBeUndefined();
		expect(invalid.result?.isError).toBe(true);
		expect(invalid.result?.content?.[0]?.text).toContain('finite');
		expect(execute).not.toHaveBeenCalled();
		const input = { n: Number.MAX_VALUE, nested: [Number.MIN_VALUE, null, '1e400', '-Infinity'] };
		const corrected = await rpc(endpoint, 'tools/call', { name: 'call_tool', arguments: { name: 'number_probe', argumentsJson: JSON.stringify(input) } });
		expect(corrected.result?.isError).not.toBe(true);
		expect(execute).toHaveBeenCalledExactlyOnceWith('number_probe', input, expect.anything());
	});
});

function invokeSchema(catalog: ToolCatalog, inputSchema: unknown, input: unknown = { n: 1 }): unknown {
	return catalog.call([{ name: 'schema_probe', description: '', inputSchema }], { name: 'schema_probe', argumentsJson: JSON.stringify(input) });
}

describe('catalog schema cache', () => {
	it('does not merge distinct array semantics', () => {
		const catalog = new ToolCatalog(log);
		const tuple = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }] } } };
		invokeSchema(catalog, tuple, { pair: ['ok', 1] });
		expect(() => invokeSchema(catalog, { ...tuple, properties: { pair: { type: 'array', items: [{ type: 'integer' }, { type: 'string' }] } } }, { pair: ['ok', 1] })).toThrow('Invalid arguments');
	});

	it('supports boolean schemas', () => {
		const catalog = new ToolCatalog(log);
		invokeSchema(catalog, true);
		expect(() => invokeSchema(catalog, false)).toThrow('Invalid arguments');
	});

	it('rejects overflowing schema values before they can collide with null in a cache key', () => {
		const catalog = new ToolCatalog(log);
		const schema = JSON.parse('{"type":"object","properties":{"n":{"type":"number","maximum":1e400}}}');
		expect(() => invokeSchema(catalog, schema)).toThrow('finite');
		expect(() => invokeSchema(catalog, { type: 'object', properties: { n: { type: 'number', maximum: null } } })).toThrow('Cannot validate');
		invokeSchema(catalog, { type: 'object', properties: { n: { type: 'number', maximum: Number.MAX_VALUE } } });
	});
});

describe('catalog schema dialect contract', () => {
	it.each([
		'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-07/schema',
		'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft/2019-09/schema#',
		'https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft/2020-12/schema#',
	])('accepts supported URI aliases without altering the original: %s', dialect => {
		const catalog = new ToolCatalog(log);
		const schema = { $schema: dialect, type: 'object', properties: { n: { type: 'integer' } } };
		const before = JSON.stringify(schema);
		invokeSchema(catalog, schema);
		expect(() => invokeSchema(catalog, schema, { n: '1' })).toThrow('Invalid arguments');
		expect(JSON.stringify(schema)).toBe(before);
	});

	it.each(['https://example.invalid/2020-12', 'http://json-schema.org/draft-04/schema#', '', 42, null])('rejects unsupported or malformed dialects: %j', dialect => {
		expect(() => invokeSchema(new ToolCatalog(log), { $schema: dialect, type: 'object' })).toThrow(/Unsupported.*schema.*dialect/i);
	});

	it.each([
		{ properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }], items: false } } },
		{ properties: { pair: { type: 'object', unevaluatedProperties: false } } },
		{ definitions: { local: { dependentRequired: { a: ['b'] } } } },
		{ $defs: { local: { $dynamicRef: '#node' } } },
	])('rejects silently ignored constraints in undeclared draft-07 schemas: %j', schema => {
		expect(() => invokeSchema(new ToolCatalog(log), { type: 'object', ...schema })).toThrow(/\$schema/);
	});

	it('enforces newer constraints under declared dialects and preserves legacy tuples', () => {
		const catalog = new ToolCatalog(log);
		const tuple = { type: 'object', properties: { pair: { type: 'array', items: [{ type: 'string' }, { type: 'integer' }], additionalItems: false } } };
		invokeSchema(catalog, tuple, { pair: ['ok', 1] });
		expect(() => invokeSchema(catalog, tuple, { pair: ['ok', 1, 2] })).toThrow('Invalid arguments');
		const modern = { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { pair: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: false } } };
		invokeSchema(catalog, modern, { pair: ['ok', 1] });
		expect(() => invokeSchema(catalog, modern, { pair: [1, 'ok'] })).toThrow('Invalid arguments');
		const dependencies = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', dependentRequired: { n: ['other'] }, unevaluatedProperties: false, properties: { n: {}, other: {} } };
		invokeSchema(catalog, dependencies, { n: 1, other: 2 });
		expect(() => invokeSchema(catalog, dependencies, { n: 1 })).toThrow('Invalid arguments');
		expect(() => invokeSchema(catalog, { ...dependencies, properties: { x: { prefixItems: [] } } })).toThrow(/\$schema/);
	});

	it('does not treat data, extension annotations or property names as schema keywords', () => {
		const catalog = new ToolCatalog(log);
		invokeSchema(catalog, { type: 'object', properties: { prefixItems: { type: 'string' }, default: { type: 'string' } }, default: { prefixItems: [], $schema: 42 }, examples: [{ unevaluatedProperties: false }], 'x-ui': { prefixItems: [] } }, { prefixItems: 'ok', default: 'value' });
		invokeSchema(catalog, { type: 'object', properties: { data: { const: { prefixItems: [], $schema: 42 } } } }, { data: { prefixItems: [], $schema: 42 } });
	});

	it('checks referenced schema targets outside the usual schema containers and handles cycles', () => {
		const catalog = new ToolCatalog(log);
		expect(() => invokeSchema(catalog, { $ref: '#/examples/0', examples: [{ type: 'object', unevaluatedProperties: false }] })).toThrow(/\$schema/);
		expect(() => invokeSchema(catalog, { $ref: '#/x~1target', 'x/target': { type: 'object', dependentRequired: { n: ['other'] } } })).toThrow(/\$schema/);
		invokeSchema(catalog, { type: 'object', properties: { next: { $ref: '#' } } }, { next: { next: {} } });
		invokeSchema(catalog, { type: 'object', definitions: { child: { $id: 'https://example.invalid/child', type: 'object', definitions: { n: { type: 'integer' } }, properties: { n: { $ref: '#/definitions/n' } } } }, properties: { child: { $ref: '#/definitions/child' } } }, { child: { n: 1 } });
	});

	it.each(['#/x-schema', 'https://example.invalid/schemas/tool#/x-schema', 'tool#/x-schema', './tool#/x-schema'])('checks equivalent same-document references consistently: %s', reference => {
		const catalog = new ToolCatalog(log);
		const schema = { $id: 'https://example.invalid/schemas/tool', $ref: reference, 'x-schema': { type: 'object', dependentRequired: { a: ['b'] } } };
		expect(() => invokeSchema(catalog, schema, { a: 1 })).toThrow(/\$schema/);
		const declared = { ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' };
		expect(() => invokeSchema(catalog, declared, { a: 1 })).toThrow('Invalid arguments');
		invokeSchema(catalog, declared, { a: 1, b: 2 });
	});

	it('resolves references across embedded resources without treating unrelated annotations as schemas', () => {
		const catalog = new ToolCatalog(log);
		const schema = {
			$id: 'https://example.invalid/root', type: 'object', properties: { n: { $ref: 'child#/x-target' } },
			definitions: { child: { $id: 'child', 'x-target': { dependentRequired: { a: ['b'] } } } },
			examples: [{ dependentRequired: { a: ['b'] } }],
		};
		expect(() => invokeSchema(catalog, schema, { n: {} })).toThrow(/\$schema/);
		invokeSchema(catalog, { ...schema, definitions: { child: { $id: 'child', 'x-target': { type: 'integer' } } } }, { n: 1 });
		const nested = { $id: 'https://example.invalid/root', type: 'object', definitions: { child: { $id: 'sub/child', $ref: 'https://example.invalid/root#/x-target' } }, properties: { n: { $ref: 'sub/child' } }, 'x-target': { dependentRequired: { a: ['b'] } } };
		expect(() => invokeSchema(catalog, nested, { n: {} })).toThrow(/\$schema/);
	});

	it('checks anchored references and URN identifiers using the compiler resolver', () => {
		const catalog = new ToolCatalog(log);
		const schema = { $schema: 'https://json-schema.org/draft/2019-09/schema', $id: 'urn:example:tool', $ref: '#target', 'x-schema': { $anchor: 'target', prefixItems: [] } };
		expect(() => invokeSchema(catalog, schema, {})).toThrow(/\$schema/);
		const supported = { ...schema, 'x-schema': { $anchor: 'target', type: 'object', properties: { n: { type: 'integer' } } } };
		invokeSchema(catalog, supported);
		expect(() => invokeSchema(catalog, supported, { n: 'wrong' })).toThrow('Invalid arguments');
	});
});
