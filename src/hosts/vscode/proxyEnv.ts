/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** The proxy a window was configured with, as the `acpHub.proxy` settings hold it. */
export interface ProxySettings {
	readonly url: string;
	readonly noProxy: string;
}

/** Any scheme the value may carry, so one that has a scheme is never given a second one. */
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The schemes an agent's HTTP stack reads from these variables: `net/http` takes http, https and socks5. */
const USABLE_SCHEME = /^(https?|socks5h?):\/\//i;

/**
 * The proxy variables for the environment the server is started with. The server hands its
 * environment to every agent process it starts, so one setting here covers them all. No URL means no
 * variables at all, and a machine or a shell that is already proxied stays the one in charge.
 */
export function proxyEnvironment(proxy: ProxySettings): Record<string, string> {
	const url = proxyUrlOf(proxy.url);
	if (url === undefined) {
		return {};
	}
	const environment: Record<string, string> = { HTTP_PROXY: url, HTTPS_PROXY: url };
	const noProxy = proxy.noProxy.trim();
	if (noProxy !== '') {
		// The agents reach the hub's own bridges on loopback, which must be named here to stay off the proxy.
		environment.NO_PROXY = noProxy;
	}
	return environment;
}

/**
 * The proxy URL the setting names, or `undefined` when it names nothing usable: empty, a scheme no
 * agent can use, or no host. A value written as `host:port`, which is how a local proxy is usually
 * named, is read as HTTP.
 */
export function proxyUrlOf(value: string): string | undefined {
	const text = value.trim();
	if (text === '') {
		return undefined;
	}
	const withScheme = ANY_SCHEME.test(text) ? text : `http://${text}`;
	if (!USABLE_SCHEME.test(withScheme)) {
		return undefined;
	}
	try {
		return new URL(withScheme).host === '' ? undefined : withScheme;
	} catch {
		return undefined;
	}
}
