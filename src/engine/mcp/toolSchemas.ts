import Ajv, { type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Log } from '../ports/host';

type Draft = '07' | '2019' | '2020';

const DIALECTS: Record<Draft, string> = {
	'07': 'http://json-schema.org/draft-07/schema#',
	'2019': 'https://json-schema.org/draft/2019-09/schema',
	'2020': 'https://json-schema.org/draft/2020-12/schema',
};
const MAX_VALIDATORS = 128;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const KEYWORDS_2019 = ['$anchor', '$recursiveRef', '$recursiveAnchor', '$vocabulary', 'unevaluatedItems', 'unevaluatedProperties', 'dependentSchemas', 'dependentRequired', 'minContains', 'maxContains'];
const KEYWORDS_2020 = ['prefixItems', '$dynamicRef', '$dynamicAnchor'];
const SCHEMA_MAPS = ['properties', 'patternProperties', 'definitions', '$defs', 'dependentSchemas'];
const SCHEMA_ARRAYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_VALUES = ['additionalProperties', 'additionalItems', 'propertyNames', 'contains', 'not', 'if', 'then', 'else', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema'];

function objectOf(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function draftOf(value: unknown): Draft {
	if (value === undefined) {
		return '07';
	}
	for (const draft of ['07', '2019', '2020'] as const) {
		const canonical = DIALECTS[draft].replace(/#$/, '');
		const secure = canonical.replace(/^http:/, 'https:');
		const plain = canonical.replace(/^https:/, 'http:');
		if ([secure, `${secure}#`, plain, `${plain}#`].includes(value as string)) {
			return draft;
		}
	}
	throw new Error(`Unsupported JSON schema dialect: ${JSON.stringify(value)}. Use a $schema declaration for draft-07, 2019-09 or 2020-12.`);
}

function checkKeywords(schema: Record<string, unknown>, draft: Draft): void {
	if (schema.$schema !== undefined && draftOf(schema.$schema) !== draft) {
		throw new Error('Mixed JSON schema dialects are not supported; use one root $schema declaration.');
	}
	if (schema.$async === true) {
		throw new Error('Asynchronous input schemas are not supported.');
	}
	const unsupported = draft === '07' ? [...KEYWORDS_2019, ...KEYWORDS_2020] : draft === '2019' ? KEYWORDS_2020 : ['additionalItems', '$recursiveRef', '$recursiveAnchor'];
	for (const keyword of unsupported) {
		if (Object.hasOwn(schema, keyword)) {
			throw new Error(`Keyword ${keyword} is not supported by ${DIALECTS[draft]}; declare a compatible $schema instead of leaving the constraint ignored.`);
		}
	}
}

function* schemaChildren(schema: Record<string, unknown>): Iterable<unknown> {
	for (const keyword of SCHEMA_MAPS) {
		const children = schema[keyword];
		if (objectOf(children)) {
			yield* Object.values(children);
		}
	}
	for (const keyword of SCHEMA_ARRAYS) {
		const children = schema[keyword];
		if (Array.isArray(children)) {
			yield* children;
		}
	}
	for (const keyword of SCHEMA_VALUES) {
		yield schema[keyword];
	}
	if (Array.isArray(schema.items)) {
		yield* schema.items;
	} else {
		yield schema.items;
	}
	if (objectOf(schema.dependencies)) {
		yield* Object.values(schema.dependencies);
	}
}

function checkSchemaStructure(schema: unknown, draft: Draft): void {
	const pending = [schema];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!objectOf(current) || seen.has(current)) {
			continue;
		}
		seen.add(current);
		checkKeywords(current, draft);
		for (const child of schemaChildren(current)) {
			pending.push(child);
		}
	}
}

interface SchemaLocation {
	schema: unknown;
	baseId: string;
}

function checkSchemaReferences(root: unknown, draft: Draft, compiler: Ajv): void {
	const resolve = (baseId: string, reference: string) => compiler.opts.uriResolver.resolve(baseId, reference);
	const location = (schema: unknown, parentId: string): SchemaLocation => ({
		schema,
		baseId: objectOf(schema) && typeof schema.$id === 'string' ? resolve(parentId, schema.$id) : parentId,
	});
	const pending = [location(root, '')];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const { schema, baseId } = pending.pop()!;
		if (!objectOf(schema) || seen.has(schema)) {
			continue;
		}
		seen.add(schema);
		checkKeywords(schema, draft);
		for (const child of schemaChildren(schema)) {
			pending.push(location(child, baseId));
		}
		for (const keyword of ['$ref', '$dynamicRef', '$recursiveRef']) {
			const value = schema[keyword];
			if (typeof value === 'string') {
				const reference = resolve(baseId, value);
				const target = compiler.getSchema(reference);
				if (target) {
					// Ajv has already applied the target's $id to this base.
					pending.push({ schema: target.schema, baseId: target.schemaEnv?.baseId ?? reference });
				}
			}
		}
	}
}

function schemaKey(schema: object | boolean): string {
	return JSON.stringify(schema, (_key, value: unknown) => {
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new Error('Numeric schema values must be finite.');
		}
		return objectOf(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
	});
}

export class ToolSchemas {
	private readonly validators = new Map<string, { validate: ValidateFunction; bytes: number }>();
	private bytes = 0;

	constructor(private readonly log: Log) { }

	validator(inputSchema: unknown): ValidateFunction {
		const original = inputSchema ?? { type: 'object', properties: {} };
		if (typeof original !== 'boolean' && !objectOf(original)) {
			throw new Error('Invalid input schema.');
		}
		const draft = draftOf(objectOf(original) ? original.$schema : undefined);
		const schema = objectOf(original) && original.$schema !== undefined ? { ...original, $schema: DIALECTS[draft] } : original;
		const key = `${draft}:${schemaKey(schema)}`;
		const cached = this.validators.get(key);
		if (cached) {
			this.validators.delete(key);
			this.validators.set(key, cached);
			return cached.validate;
		}
		checkSchemaStructure(schema, draft);
		const Constructor = draft === '2020' ? Ajv2020 : draft === '2019' ? Ajv2019 : Ajv;
		// Ajv retains generated functions even after removeSchema; each cache entry owns its compiler.
		const compiler = new Constructor({ strict: false, strictNumbers: true, ownProperties: true, logger: {
			log: message => this.log(String(message), 'debug'),
			warn: message => this.log(String(message), 'warn'),
			error: message => this.log(String(message), 'error'),
		} });
		addFormats(compiler);
		let validate: ValidateFunction;
		try {
			validate = compiler.compile(schema);
			checkSchemaReferences(schema, draft, compiler);
		} finally {
			compiler.removeSchema();
		}
		const bytes = Buffer.byteLength(key);
		if (bytes <= MAX_SCHEMA_BYTES) {
			while (this.validators.size >= MAX_VALIDATORS || this.bytes + bytes > MAX_SCHEMA_BYTES) {
				const oldest = this.validators.entries().next().value;
				if (!oldest) {
					break;
				}
				this.validators.delete(oldest[0]);
				this.bytes -= oldest[1].bytes;
			}
			this.validators.set(key, { validate, bytes });
			this.bytes += bytes;
		}
		return validate;
	}
}
