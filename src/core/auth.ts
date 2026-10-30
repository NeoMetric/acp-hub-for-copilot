import type { AgentAdapter, AuthMethodSpec, LaunchContext } from './adapter';

/** The part of the secret store that sign-in needs; `AgentSecretStore` fits. */
export interface KeyStore {
	get(agentId: string): Promise<string | undefined>;
	set(agentId: string, value: string): Promise<void>;
	delete(agentId: string): Promise<void>;
}

export interface TerminalOptions {
	name: string;
	shellPath: string;
	shellArgs: string[];
	env: Record<string, string>;
}

/** Opens a terminal with these options and resolves when the user closes it. */
export type TerminalRunner = (options: TerminalOptions) => Promise<void>;

export interface SignInDeps {
	store: KeyStore;
	ctx: LaunchContext;
	runTerminal: TerminalRunner;
}

export interface SignInStateDeps {
	store: KeyStore;
	/** What the running agent says about its own account; `unknown` when it has not said. */
	agentStatus?: () => 'yes' | 'no' | 'unknown';
}

export type SignInChoice =
	| { kind: 'api-key'; key: string }
	| { kind: 'terminal'; method: AuthMethodSpec };

export type SignInResult = { ok: true } | { ok: false; message: string };

export interface KeyProblem {
	severity: 'error' | 'warning';
	message: string;
}

/** What the agent advertises for each method during `initialize`. */
export interface AdvertisedAuthMethod {
	id?: string;
	name?: string;
	description?: string;
	type?: string;
	args?: readonly unknown[];
}

/** Checks a typed API key. An error blocks saving; a warning does not. */
export function validateApiKey(value: string, keyPrefix?: string): KeyProblem | undefined {
	const key = value.trim();
	if (key.length === 0) {
		return { severity: 'error', message: 'Enter the API key.' };
	}
	if (/\s/.test(key)) {
		return { severity: 'error', message: 'An API key has no spaces or line breaks.' };
	}
	if (keyPrefix && !key.startsWith(keyPrefix)) {
		return { severity: 'warning', message: `API keys usually start with "${keyPrefix}". You can continue if you are sure.` };
	}
	return undefined;
}

/** The argument lists the adapter allows a terminal sign-in to start with. */
function allowedCommands(adapter: AgentAdapter): string[][] {
	const commands: string[][] = [];
	for (const method of adapter.auth) {
		if (method.kind === 'oauth-browser' && method.terminalCommand && method.terminalCommand.length > 0) {
			commands.push(method.terminalCommand);
		}
	}
	return commands;
}

function startsWith(args: readonly string[], prefix: readonly string[]): boolean {
	if (args.length < prefix.length) {
		return false;
	}
	return prefix.every((part, index) => args[index] === part);
}

function isAllowedCommand(adapter: AgentAdapter, args: readonly string[]): boolean {
	return allowedCommands(adapter).some(prefix => startsWith(args, prefix));
}

/**
 * The terminal sign-in methods the agent advertised. Only commands that start
 * like one the adapter declared are accepted: whatever else a method asks to
 * run is not launched. Falls back to the adapter's own methods.
 */
export function terminalMethodsFrom(adapter: AgentAdapter, advertised: readonly AdvertisedAuthMethod[]): AuthMethodSpec[] {
	const methods: AuthMethodSpec[] = [];

	for (const method of advertised) {
		const args = method.args;
		if (method.type !== 'terminal' || !method.id || !Array.isArray(args)) {
			continue;
		}
		if (!args.every(arg => typeof arg === 'string')) {
			continue;
		}
		if (!isAllowedCommand(adapter, args as string[])) {
			continue;
		}
		methods.push({
			kind: 'oauth-browser',
			label: method.name ?? method.id,
			terminalCommand: args as string[],
		});
	}

	if (methods.length > 0) {
		return methods;
	}
	return adapter.auth.filter(method => method.kind === 'oauth-browser' && method.terminalCommand !== undefined);
}

/** Saves the key for this agent only. */
export async function signInWithApiKey(agentId: string, key: string, store: KeyStore): Promise<SignInResult> {
	const trimmed = key.trim();
	const problem = validateApiKey(trimmed);
	if (problem?.severity === 'error') {
		return { ok: false, message: problem.message };
	}
	await store.set(agentId, trimmed);
	return { ok: true };
}

/** Runs the adapter's own login command in a terminal and resolves when the terminal closes. */
export async function signInWithTerminal(
	adapter: AgentAdapter,
	method: AuthMethodSpec,
	ctx: LaunchContext,
	deps: { runTerminal: TerminalRunner },
): Promise<SignInResult> {
	if (method.kind !== 'oauth-browser' || !method.terminalCommand) {
		return { ok: false, message: `"${method.label}" has no terminal sign-in.` };
	}
	if (!isAllowedCommand(adapter, method.terminalCommand)) {
		return { ok: false, message: `"${method.label}" asks to run a command ${adapter.displayName} does not allow.` };
	}

	await deps.runTerminal({
		name: `${adapter.displayName} Sign In (${method.label})`,
		shellPath: process.execPath,
		shellArgs: [ctx.entryPath, ...method.terminalCommand],
		env: { ELECTRON_RUN_AS_NODE: '1' },
	});
	return { ok: true };
}

export async function signIn(adapter: AgentAdapter, choice: SignInChoice, deps: SignInDeps): Promise<SignInResult> {
	if (choice.kind === 'api-key') {
		const hasApiKeyMethod = adapter.auth.some(method => method.kind === 'api-key');
		if (!hasApiKeyMethod) {
			return { ok: false, message: `${adapter.displayName} does not sign in with an API key.` };
		}
		return signInWithApiKey(adapter.id, choice.key, deps.store);
	}
	return signInWithTerminal(adapter, choice.method, deps.ctx, deps);
}

/** Removes the saved API key of this agent. Other agents' keys stay. */
export async function signOut(agentId: string, store: KeyStore): Promise<void> {
	await store.delete(agentId);
}

/** A saved key means signed in; otherwise whatever the agent reported. */
export async function readSignInState(adapter: AgentAdapter, deps: SignInStateDeps): Promise<'yes' | 'no' | 'unknown'> {
	const key = await deps.store.get(adapter.id);
	if (key !== undefined) {
		return 'yes';
	}
	if (!deps.agentStatus) {
		return 'unknown';
	}
	return deps.agentStatus();
}
