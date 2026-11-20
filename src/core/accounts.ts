import type { AgentAdapter, LaunchContext, LaunchSpec } from './adapter';
import type { ConfigReader } from './settings';
import { settingKey } from './settings';

/** One extra account of an agent type, as `config.json` stores it. */
export interface AccountRecord {
	id: string;
	name: string;
}

/** The settings an account keeps for itself; every other key is read under the type id. */
export const PER_ACCOUNT_SETTINGS: ReadonlySet<string> = new Set(['enabled', 'authPreference']);

/** The card switch that turns all extra accounts of a type on or off (default on). */
export const ACCOUNTS_ENABLED_KEY = 'accountsEnabled';

const MAX_NAME_LENGTH = 20;

/** The key the records of a type are stored under, without the `acpHub.` prefix. */
export function accountsKey(typeId: string): string {
	return `accounts.${typeId}`;
}

/** The id of the adapter whose folder holds the program: the type id for an account copy. */
export function typeIdOf(adapter: AgentAdapter): string {
	return adapter.installId ?? adapter.id;
}

export function accountsSupported(adapter: AgentAdapter, platform: NodeJS.Platform = process.platform): boolean {
	return !!adapter.accounts && !adapter.accountName && platform === 'win32';
}

export function accountId(typeId: string, name: string): string {
	return `${typeId}-${name.trim().toLowerCase().replace(/[ -]+/g, '-')}`;
}

/** The message that says why the name cannot be used, or `undefined` when it can. */
export function validateAccountName(name: string, existing: readonly AccountRecord[], takenIds: ReadonlySet<string>, typeId: string): string | undefined {
	const trimmed = name.trim();
	if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
		return `The name must have 1 to ${MAX_NAME_LENGTH} characters.`;
	}
	if (!/^[A-Za-z0-9 -]+$/.test(trimmed) || !/[A-Za-z0-9]/.test(trimmed)) {
		return 'The name may use letters, digits, spaces and hyphens only.';
	}
	if (trimmed.toLowerCase() === 'default') {
		return 'The name "Default" is the account that exists already.';
	}
	const lower = trimmed.toLowerCase();
	if (existing.some(record => record.name.trim().toLowerCase() === lower) || takenIds.has(accountId(typeId, trimmed))) {
		return 'An account with this name already exists.';
	}
	return undefined;
}

export function accountVendor(typeVendor: string, name: string): string {
	return `${typeVendor} · ${name}`;
}

/** A copy of the adapter that runs as one more account of the same agent. */
export function accountAdapter(base: AgentAdapter, account: AccountRecord): AgentAdapter {
	return {
		...base,
		id: account.id,
		installId: typeIdOf(base),
		accountName: account.name,
		displayName: `${base.displayName} · ${account.name}`,
		vendor: accountVendor(base.vendor, account.name),
		launch(ctx: LaunchContext): LaunchSpec {
			const spec = base.launch(ctx);
			const support = base.accounts;
			if (!support) {
				return spec;
			}
			const unsetEnv = [...(spec.unsetEnv ?? []), ...support.inheritedCredentials.filter(name => !(name in spec.env))];
			return { ...spec, env: { ...spec.env, ...support.environment(ctx.storageDir) }, unsetEnv };
		},
	};
}

/** The stored records of a type; an entry that cannot be used is dropped and reported. */
export function readAccounts(config: ConfigReader, typeId: string, warn: (message: string) => void = () => { }): AccountRecord[] {
	const stored = config.get<unknown>(accountsKey(typeId));
	if (!Array.isArray(stored)) {
		return [];
	}
	const records: AccountRecord[] = [];
	const seen = new Set<string>();
	for (const entry of stored) {
		const record = entry as Partial<AccountRecord> | null;
		if (typeof record !== 'object' || record === null || typeof record.id !== 'string' || typeof record.name !== 'string') {
			warn(`An entry of acpHub.${accountsKey(typeId)} is not an account and was ignored.`);
		} else if (!record.id.startsWith(`${typeId}-`) || record.id.includes('/')) {
			warn(`The account "${record.id}" does not have a valid id and was ignored.`);
		} else if (seen.has(record.id)) {
			warn(`The account "${record.id}" is listed twice; the later entry was ignored.`);
		} else {
			seen.add(record.id);
			records.push({ id: record.id, name: record.name });
		}
	}
	return records;
}

/** Whether the agent is on: its own switch and, for an account, its type's account switch must not be `false`. */
export function isServing(adapter: AgentAdapter, config: ConfigReader): boolean {
	if (config.get<boolean>(settingKey(adapter.id, 'enabled')) === false) {
		return false;
	}
	return config.get<boolean>(settingKey(typeIdOf(adapter), ACCOUNTS_ENABLED_KEY)) !== false;
}
