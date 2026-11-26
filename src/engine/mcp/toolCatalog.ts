import type { ToolDef } from '../model/chat';
import type { Log } from '../ports/host';
import { ToolSchemas } from './toolSchemas';

export const CATALOG_TOOLS: readonly ToolDef[] = [
	{
		name: 'tool_catalog',
		description: 'Find available tools by name or purpose using query. Omit query to list all names. Pass an exact name to read its complete JSON definition. Follow nextCursor until absent; concatenate definition chunks before parsing. Use call_tool to execute the original tool.',
		inputSchema: { type: 'object', properties: { query: { type: 'string' }, name: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } } },
	},
	{
		name: 'call_tool',
		description: 'Execute an available tool by its original name. Read its full definition with tool_catalog first. argumentsJson is a JSON object string matching that definition, including all required arguments. Execution and approval remain with the client.',
		inputSchema: { type: 'object', properties: { name: { type: 'string' }, argumentsJson: { type: 'string' } }, required: ['name', 'argumentsJson'] },
	},
];

export class ToolCatalogError extends Error { }

function objectOf(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkFiniteNumbers(parsed: unknown): void {
	const pending = [parsed];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error('Numeric arguments must be finite; a value exceeds the supported range.');
		}
		if (value !== null && typeof value === 'object') {
			for (const child of Object.values(value)) {
				pending.push(child);
			}
		}
	}
}

export class ToolCatalog {
	private readonly schemas: ToolSchemas;
	private readonly limit: number;

	constructor(log: Log, maxResultChars?: number) {
		this.schemas = new ToolSchemas(log);
		this.limit = Math.min(maxResultChars ?? 3_000, 3_000);
	}

	query(tools: readonly ToolDef[], input: unknown): string {
		if (!objectOf(input)) {
			throw new ToolCatalogError('tool_catalog arguments must be an object.');
		}
		const { name, query } = input;
		const cursor = input.cursor === undefined ? 0 : input.cursor;
		if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor < 0) {
			throw new ToolCatalogError('cursor must be a non-negative integer.');
		}
		if (name !== undefined) {
			if (typeof name !== 'string' || name.length === 0 || query !== undefined) {
				throw new ToolCatalogError('Pass either an exact name or a search query.');
			}
			const tool = this.find(tools, name);
			const definition = JSON.stringify(tool);
			if (cursor >= definition.length) {
				throw new ToolCatalogError('Definition cursor is out of range; restart at cursor 0.');
			}
			return this.definitionPage(name, definition, cursor);
		}
		if (query !== undefined && typeof query !== 'string') {
			throw new ToolCatalogError('query must be a string.');
		}
		const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
		const names = tools.filter(tool => words.every(word => `${tool.name} ${tool.description}`.toLowerCase().includes(word))).map(tool => tool.name).sort();
		if (cursor > names.length || (cursor === names.length && cursor !== 0)) {
			throw new ToolCatalogError('Directory cursor is out of range; restart at cursor 0.');
		}
		const page: string[] = [];
		let end = cursor;
		while (end < names.length) {
			const candidate = this.directory([...page, names[end]], names.length, end + 1);
			if (candidate.length > this.limit) {
				break;
			}
			page.push(names[end++]);
		}
		if (end === cursor && cursor < names.length) {
			throw new ToolCatalogError('A tool name exceeds the catalog response limit; search for it by exact name.');
		}
		const result = this.directory(page, names.length, end);
		if (result.length > this.limit) {
			throw new ToolCatalogError('The catalog response limit is too small.');
		}
		return result;
	}

	call(tools: readonly ToolDef[], input: unknown): { name: string; input: Record<string, unknown> } {
		if (!objectOf(input) || typeof input.name !== 'string' || typeof input.argumentsJson !== 'string') {
			throw new ToolCatalogError('call_tool requires name and argumentsJson strings.');
		}
		const tool = this.find(tools, input.name);
		let args: unknown;
		try {
			args = JSON.parse(input.argumentsJson);
			checkFiniteNumbers(args);
		} catch (error) {
			throw new ToolCatalogError(`Invalid argumentsJson for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!objectOf(args)) {
			throw new ToolCatalogError('argumentsJson must encode an object.');
		}
		let validate;
		try {
			validate = this.schemas.validator(tool.inputSchema);
		} catch (error) {
			throw new ToolCatalogError(`Cannot validate the input schema for ${tool.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
		if (!validate(args)) {
			throw new ToolCatalogError(`Invalid arguments for ${tool.name}: ${validate.errors?.map(error => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
		}
		return { name: tool.name, input: args };
	}

	private find(tools: readonly ToolDef[], name: string): ToolDef {
		const tool = tools.find(candidate => candidate.name === name);
		if (!tool) {
			throw new ToolCatalogError(`Tool ${name} is not available in this session.`);
		}
		return tool;
	}

	private directory(names: readonly string[], total: number, end: number): string {
		return JSON.stringify({ names, total, ...(end < total ? { nextCursor: end } : {}) });
	}

	private definitionPage(name: string, definition: string, cursor: number): string {
		const page = (length: number): string => {
			const end = cursor + length;
			return JSON.stringify({ name, definition: definition.slice(cursor, end), ...(end < definition.length ? { nextCursor: end } : {}) });
		};
		let low = 0;
		let high = definition.length - cursor;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (page(mid).length <= this.limit) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		if (low === 0) {
			throw new ToolCatalogError('The tool definition metadata exceeds the catalog response limit.');
		}
		return page(low);
	}
}
