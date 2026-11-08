import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertShellSafe, authenticateMethodFor, googleAdapter, googleLaunchSpec, resolveCommand } from '../../../src/adapters/google';
import { QuotaLimitError } from '../../../src/adapters/googleQuota';
import type { AgentSettings, InstallContext, LaunchContext } from '../../../src/core/adapter';
import { RpcError } from '../../../src/core/rpc';

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
		expect(googleAdapter.rebuildExpiredSessions).toBe(true);
		expect(googleAdapter.settings.map(setting => setting.key)).toContain('useAgentBuiltInTools');
		expect(googleAdapter.settings.map(setting => setting.key)).toContain('idleTimeoutSeconds');
		expect(googleAdapter.settings.map(setting => setting.key)).not.toContain('agyCommand');
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
	it('runs the downloaded CLI as an ACP server on its own conversations, without a shell, in a path with spaces and é', () => {
		const ctx = launchContext({}, 'AIza-key');
		const spec = googleLaunchSpec(ctx, {}, 'win32');

		expect(spec.command).toBe(ctx.entryPath);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot', '--process-per-session']);
		expect(spec.shell).toBeUndefined();
		expect(spec.env).toEqual({ GEMINI_API_KEY: 'AIza-key' });
	});

	it('passes the launch of the real adapter through', () => {
		const spec = googleAdapter.launch(launchContext());

		expect(spec.command).toBe(launchContext().entryPath);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot', '--process-per-session']);
		expect(spec.env.GEMINI_API_KEY).toBeUndefined();
	});

	it('leaves the saved key out when only the signed-in account is wanted', () => {
		const spec = googleLaunchSpec(launchContext({ authPreference: 'oauth' }, 'AIza-key'), {}, 'win32');

		expect(spec.env.GEMINI_API_KEY).toBeUndefined();
	});

	it('starts a command override directly, with its arguments as an array', () => {
		const file = touch('agy é.exe');
		const spec = googleLaunchSpec(launchContext({ command: file, args: ['--debug', '--name=a b'] }), { PATHEXT: '.exe;.cmd' }, 'win32');

		expect(spec.command).toBe(file);
		expect(spec.args).toEqual(['--debug', '--name=a b']);
		expect(spec.shell).toBeUndefined();
	});

	it('hands shell metacharacters in the arguments to the program as literal text', () => {
		const file = touch('agy.exe');
		const spec = googleLaunchSpec(launchContext({ command: file, args: ['& calc', '"x" | y', '%PATH%'] }), { PATHEXT: '.exe;.cmd' }, 'win32');

		expect(spec.shell).toBeUndefined();
		expect(spec.args).toEqual(['& calc', '"x" | y', '%PATH%']);
	});

	it('never interprets a command that looks like a shell line', () => {
		const spec = googleLaunchSpec(launchContext({ command: 'agy_not_installed & calc', args: [] }), { PATH: temp, PATHEXT: '.exe;.cmd' }, 'win32');

		expect(spec.command).toBe('agy_not_installed & calc');
		expect(spec.shell).toBeUndefined();
	});

	it('looks the override up on PATH, and runs it as agy acp when no arguments are set', () => {
		const file = touch('agy-acp.exe');
		const spec = googleLaunchSpec(launchContext({ command: 'agy-acp' }), { PATH: temp, PATHEXT: '.exe;.cmd' }, 'win32');

		expect(spec.command).toBe(file);
		expect(spec.args).toEqual(['acp', '--app-data-dir=antigravity-copilot', '--process-per-session']);
	});

	it('uses a shell only for a .cmd shim, and then refuses arguments cmd.exe would interpret', () => {
		const shim = touch('agy.cmd');
		const env = { PATH: temp, PATHEXT: '.exe;.cmd' };

		expect(googleLaunchSpec(launchContext({ command: 'agy', args: ['--acp'] }), env, 'win32')).toMatchObject({ command: shim, args: ['--acp'], shell: true });
		expect(() => googleLaunchSpec(launchContext({ command: 'agy', args: ['& calc'] }), env, 'win32')).toThrow('cannot be passed to a .cmd launcher');
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
