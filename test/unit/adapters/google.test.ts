import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertShellSafe, authenticateMethodFor, googleAdapter, googleLaunchSpec, resolveCommand } from '../../../src/adapters/google';
import { QuotaLimitError } from '../../../src/adapters/googleQuota';
import { googleSessionPolicy } from '../../../src/adapters/googleSessionPolicy';
import type { AgentSettings, InstallContext, LaunchContext } from '../../../src/core/adapter';
import { HOST_IDENTITY } from '../../../src/core/hostIdentity';
import { RpcError } from '../../../src/engine/acp/rpc';

let temp: string;

beforeEach(() => {
	temp = fs.mkdtempSync(path.join(os.tmpdir(), 'acphub-google é -'));
});

afterEach(() => {
	fs.rmSync(temp, { recursive: true, force: true });
});

function launchContext(settings: AgentSettings = {}, apiKey?: string): LaunchContext {
	return {
		entryPath: path.join(temp, 'v1.5.3', 'agy.exe'),
		installDir: path.join(temp, 'v1.5.3'),
		storageDir: path.join(temp, 'storage é'),
		settings,
		apiKey,
		workspaceFolder: temp,
	};
}

function touch(name: string): string {
	const file = path.join(temp, name);
	fs.writeFileSync(file, '');
	return file;
}

describe('googleAdapter', () => {
	it('is described by the registry and downloads the Antigravity CLI', () => {
		expect(googleAdapter.id).toBe('google');
		expect(googleAdapter.vendor).toBe('Google Agent');
		expect(googleAdapter.displayName).toBe('Google Agent');
		expect(googleAdapter.install.kind).toBe('download');
		expect(googleAdapter.settings.map(setting => setting.key)).toContain('useAgentBuiltInTools');
		expect(googleAdapter.settings.map(setting => setting.key)).toContain('idleTimeoutSeconds');
		expect(googleAdapter.settings.map(setting => setting.key)).not.toContain('agyCommand');
		expect(googleAdapter.settings.map(setting => setting.key)).toContain('replaceSystemPrompt');
	});

	it('owns how its stored conversations continue in a session policy', () => {
		expect(googleAdapter.sessionPolicy).toBe(googleSessionPolicy);
	});

	it('trusts the cache figures agy acp reports', () => {
		expect(googleAdapter.reportsCache).not.toBe(false);
	});

	it('lists its sign-in methods', () => {
		expect(googleAdapter.auth).toEqual([
			{ kind: 'oauth-browser', label: 'Google account', browserAuthPreference: 'oauth' },
			{ kind: 'api-key', label: 'Gemini API key', envVar: 'GEMINI_API_KEY', keyPrefix: 'AIza' },
		]);
	});

	it('names the chat tools as agy acp lists them, with no call_mcp_tool, and lists required arguments', () => {
		expect(googleAdapter.systemPrompt.toolAccess).toContain('`mcp_vscode_<name>`');
		expect(googleAdapter.systemPrompt.toolAccess).not.toContain('call_mcp_tool');
		expect(googleAdapter.systemPrompt.listRequiredArguments).toBe(true);
	});

	it('finds nothing before the CLI is downloaded', async () => {
		if (googleAdapter.install.kind !== 'download') {
			throw new Error('expected a download install');
		}
		const context: InstallContext = { storageDir: path.join(temp, 'google'), log: () => { }, progress: () => { } };

		expect(await googleAdapter.install.find(context)).toBeUndefined();
	});

	it('fetches the CLI unasked where the old ACP server was installed', async () => {
		if (googleAdapter.install.kind !== 'download' || !googleAdapter.install.needsUpdate) {
			throw new Error('expected a download install that updates');
		}
		const context: InstallContext = { storageDir: path.join(temp, 'google'), log: () => { }, progress: () => { } };
		expect(await googleAdapter.install.needsUpdate(context)).toBe(false);

		fs.mkdirSync(path.join(temp, 'google', 'v1.4.5'), { recursive: true });
		fs.writeFileSync(path.join(temp, 'google', 'v1.4.5', 'installed-version'), '1.4.5');
		expect(await googleAdapter.install.needsUpdate(context)).toBe(true);
		expect(await googleAdapter.install.find(context)).toBeUndefined();
	});

	it('forks with the program the agent runs', async () => {
		expect(await googleAdapter.forker?.locate({}, () => { }, 'agy.exe')).toBe('agy.exe');
	});
});

describe('google launch', () => {
	/** The settings that keep Antigravity's own agent: its own tools, its own prompt. */
	const ownAgent = { useAgentBuiltInTools: true };

	it('runs the downloaded CLI as an ACP server on its own conversations, without a shell, in a path with spaces and é', () => {
		const ctx = launchContext(ownAgent, 'AIza-key');
		const spec = googleLaunchSpec(ctx, {}, 'win32', path.join(temp, 'home'));

		expect(spec.command).toBe(ctx.entryPath);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot']);
		expect(spec.shell).toBeUndefined();
		expect(spec.env).toEqual({ GEMINI_API_KEY: 'AIza-key' });
	});

	it('passes the launch of the real adapter through', () => {
		const spec = googleAdapter.launch(launchContext(ownAgent));

		expect(spec.command).toBe(launchContext().entryPath);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot']);
		expect(spec.env.GEMINI_API_KEY).toBeUndefined();
	});

	it('leaves the saved key out when only the signed-in account is wanted', () => {
		const spec = googleLaunchSpec(launchContext({ authPreference: 'oauth', ...ownAgent }, 'AIza-key'), {}, 'win32', path.join(temp, 'home'));

		expect(spec.env.GEMINI_API_KEY).toBeUndefined();
	});

	it('starts a command override directly, with its arguments as an array', () => {
		const file = touch('agy é.exe');
		const spec = googleLaunchSpec(launchContext({ command: file, args: ['--debug', '--name=a b'], ...ownAgent }), { PATHEXT: '.exe;.cmd' }, 'win32', path.join(temp, 'home'));

		expect(spec.command).toBe(file);
		expect(spec.args).toEqual(['--debug', '--name=a b']);
		expect(spec.shell).toBeUndefined();
	});

	it('hands shell metacharacters in the arguments to the program as literal text', () => {
		const file = touch('agy.exe');
		const spec = googleLaunchSpec(launchContext({ command: file, args: ['& calc', '"x" | y', '%PATH%'], ...ownAgent }), { PATHEXT: '.exe;.cmd' }, 'win32', path.join(temp, 'home'));

		expect(spec.shell).toBeUndefined();
		expect(spec.args).toEqual(['& calc', '"x" | y', '%PATH%']);
	});

	it('never interprets a command that looks like a shell line', () => {
		const spec = googleLaunchSpec(launchContext({ command: 'agy_not_installed & calc', args: [], ...ownAgent }), { PATH: temp, PATHEXT: '.exe;.cmd' }, 'win32', path.join(temp, 'home'));

		expect(spec.command).toBe('agy_not_installed & calc');
		expect(spec.shell).toBeUndefined();
	});

	it('looks the override up on PATH, and runs it as agy acp when no arguments are set', () => {
		const file = touch('agy-acp.exe');
		const spec = googleLaunchSpec(launchContext({ command: 'agy-acp', ...ownAgent }), { PATH: temp, PATHEXT: '.exe;.cmd' }, 'win32', path.join(temp, 'home'));

		expect(spec.command).toBe(file);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot']);
	});

	it('uses a shell only for a .cmd shim, and then refuses arguments cmd.exe would interpret', () => {
		const shim = touch('agy.cmd');
		const env = { PATH: temp, PATHEXT: '.exe;.cmd' };

		const home = path.join(temp, 'home');
		expect(googleLaunchSpec(launchContext({ command: 'agy', args: ['--acp'], ...ownAgent }), env, 'win32', home)).toMatchObject({ command: shim, args: ['--acp'], shell: true });
		expect(() => googleLaunchSpec(launchContext({ command: 'agy', args: ['& calc'], ...ownAgent }), env, 'win32', home)).toThrow('cannot be passed to a .cmd launcher');
	});
});

describe('the extension\'s own agent', () => {
	const agentFile = (home: string) => path.join(home, '.gemini', 'agents', 'acp-hub-copilot', 'agent.md');
	const homeUnder = () => path.join(temp, `home-${Math.random().toString(16).slice(2)}`);

	it('runs a custom agent with no built-in tools, and Antigravity\'s persona, by default', () => {
		const home = homeUnder();

		const spec = googleLaunchSpec(launchContext(), {}, 'win32', home);

		expect(spec.args).toContain('--agent=acp-hub-copilot');
		const file = fs.readFileSync(agentFile(home), 'utf8');
		expect(file.startsWith('---\nname: acp-hub-copilot\n')).toBe(true);
		expect(file).toMatch(/^description: .+$/m);
		expect(file).toMatch(/^tools: \[\]$/m);
		expect(file).toMatch(/^You are Antigravity, /m);
		expect(file).not.toContain(HOST_IDENTITY);
	});

	it('gives the agent Copilot\'s identity instead when the chat replaces the prompt, still with no built-in tools', () => {
		const home = homeUnder();

		googleLaunchSpec(launchContext({ replaceSystemPrompt: true }), {}, 'win32', home);

		const file = fs.readFileSync(agentFile(home), 'utf8');
		expect(file).toMatch(/^tools: \[\]$/m);
		expect(file).toContain(HOST_IDENTITY);
		expect(file).not.toMatch(/^You are Antigravity, /m);
	});

	it('leaves Antigravity\'s own agent and the home folder alone when its built-in tools are wanted', () => {
		const home = homeUnder();

		const spec = googleLaunchSpec(launchContext({ useAgentBuiltInTools: true }), {}, 'win32', home);

		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot']);
		expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
	});

	it('still runs a custom agent for the prompt replacement when the built-in tools are wanted', () => {
		const home = homeUnder();

		const spec = googleLaunchSpec(launchContext({ useAgentBuiltInTools: true, replaceSystemPrompt: true }), {}, 'win32', home);

		expect(spec.args).toContain('--agent=acp-hub-copilot');
		const file = fs.readFileSync(agentFile(home), 'utf8');
		expect(file).not.toMatch(/^tools:/m);
		expect(file).toContain(HOST_IDENTITY);
	});

	it('writes the agent into the gemini home the CLI is told to use', () => {
		const home = homeUnder();
		const geminiHome = path.join(temp, 'other gemini');

		const spec = googleLaunchSpec(launchContext(), { GEMINI_HOME: geminiHome }, 'win32', home);

		expect(spec.args).toContain('--agent=acp-hub-copilot');
		expect(fs.existsSync(path.join(geminiHome, 'agents', 'acp-hub-copilot', 'agent.md'))).toBe(true);
		expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
	});

	it('gives the flag to a command override too', () => {
		const file = touch('agy.exe');
		const home = homeUnder();

		const spec = googleLaunchSpec(launchContext({ command: file }), { PATHEXT: '.exe;.cmd' }, 'win32', home);

		expect(spec.args).toContain('--agent=acp-hub-copilot');
	});

	it('keeps the same bytes in the file from one start to the next, so the prompt cache holds', () => {
		const home = homeUnder();

		googleLaunchSpec(launchContext(), {}, 'win32', home);
		const first = fs.readFileSync(agentFile(home), 'utf8');
		googleLaunchSpec(launchContext(), {}, 'win32', home);

		expect(fs.readFileSync(agentFile(home), 'utf8')).toBe(first);
	});
});

describe('resolveCommand', () => {
	it('finds a program on PATH', () => {
		const file = touch('tool');

		expect(resolveCommand('tool', { PATH: temp }, 'linux')).toEqual({ file, viaShell: false });
		expect(resolveCommand('missing', { PATH: temp }, 'linux')).toBeUndefined();
	});

	it('takes a path as given', () => {
		const file = touch('tool');

		expect(resolveCommand(file, { PATH: '' }, 'linux')?.file).toBe(file);
	});

	it('applies PATHEXT on Windows and flags .cmd shims as needing a shell', () => {
		const shim = touch('agy.cmd');
		const exe = touch('agy-acp.exe');
		const env = { PATH: temp, PATHEXT: '.exe;.cmd' };

		expect(resolveCommand('agy', env, 'win32')).toEqual({ file: shim, viaShell: true });
		expect(resolveCommand('agy-acp', env, 'win32')).toEqual({ file: exe, viaShell: false });
	});
});

describe('assertShellSafe', () => {
	it('allows plain flags and paths', () => {
		expect(() => assertShellSafe(['--acp', '--model=gemini-3', 'C:\\tools\\agy.js'])).not.toThrow();
	});

	it('refuses anything cmd.exe would interpret', () => {
		for (const argument of ['a & b', '"quoted"', '%PATH%', 'a|b', '^x']) {
			expect(() => assertShellSafe([argument])).toThrow('cannot be passed');
		}
	});
});

describe('google hooks', () => {
	it('removes API key variables of the shell when only the account is wanted', () => {
		const env = { GEMINI_API_KEY: 'a', GOOGLE_API_KEY: 'b', PATH: 'x' };

		expect(googleAdapter.mergeConfig?.({ authPreference: 'oauth' }, env)).toEqual({ PATH: 'x' });
		expect(googleAdapter.mergeConfig?.({ authPreference: 'auto' }, env)).toEqual(env);
	});

	it('turns the built-in tools off unless the setting asks for them', () => {
		expect(googleAdapter.disableBuiltInTools?.({ useAgentBuiltInTools: false })).toBe(true);
		expect(googleAdapter.disableBuiltInTools?.({})).toBe(true);
		expect(googleAdapter.disableBuiltInTools?.({ useAgentBuiltInTools: true })).toBe(false);
	});

	it('appends the session prompt, and with the built-in tools off tells the model to use only the chat tools', () => {
		const base = { replaceSystemPrompt: false, reportEachModelCall: false, isNewSession: true };
		const appendOf = (params: Record<string, unknown> | undefined) => (params as { _meta: { antigravity: { systemPrompt: { append: string } } } })._meta.antigravity.systemPrompt.append;

		const off = appendOf(googleAdapter.sessionParams?.({ ...base, disableBuiltInTools: true, systemPromptAppend: 'hello' }));
		expect(off.startsWith('hello\n\n')).toBe(true);
		expect(off).toContain('use only the `mcp_vscode_*` tools');

		expect(appendOf(googleAdapter.sessionParams?.({ ...base, disableBuiltInTools: false, systemPromptAppend: 'hello' }))).toBe('hello');
		expect(appendOf(googleAdapter.sessionParams?.({ ...base, disableBuiltInTools: true }))).toContain('use only the `mcp_vscode_*` tools');
		expect(googleAdapter.sessionParams?.({ ...base, disableBuiltInTools: false })).toEqual({});
	});

	it('gives the same session options on every call, so a resumed or forked chat keeps its prompt cache', () => {
		const input = { replaceSystemPrompt: false, reportEachModelCall: false, disableBuiltInTools: true, systemPromptAppend: 'hello' };

		expect(googleAdapter.sessionParams?.({ ...input, isNewSession: false })).toEqual(googleAdapter.sessionParams?.({ ...input, isNewSession: true }));
	});

	it('maps a quota error and keeps other errors', () => {
		const mapped = googleAdapter.mapError?.(new RpcError('Resource exhausted', -32603));

		expect(mapped).toBeInstanceOf(QuotaLimitError);
		expect(googleAdapter.mapError?.(new RpcError('Internal error', -32603))).toBeUndefined();
	});

	it('picks the API key method only when a key is saved', () => {
		const methods = [{ id: 'oauth-personal' }, { id: 'gemini-api-key' }];

		expect(authenticateMethodFor(methods, true)).toBe('gemini-api-key');
		expect(authenticateMethodFor(methods, false)).toBe('oauth-personal');
		expect(authenticateMethodFor([], false)).toBeUndefined();
		expect(googleAdapter.authenticate?.(methods, 'AIza')).toEqual({ methodId: 'gemini-api-key' });
		expect(googleAdapter.authenticate?.(methods, 'AIza', { authPreference: 'oauth' })).toEqual({ methodId: 'oauth-personal' });
		expect(googleAdapter.authenticate?.([], undefined)).toBeUndefined();
	});
});
