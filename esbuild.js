/*---------------------------------------------------------------------------------------------
 *  Copyright (c) NeoMetric. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const esbuild = require("esbuild");
const { version } = require("./package.json");

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

/** @type {import('esbuild').BuildOptions} */
const shared = {
	bundle: true,
	platform: "node",
	format: "cjs",
	target: "node20",
	external: ["vscode"],
	sourcemap: true,
	logLevel: "info",
	// The bundle names the version it was built from, so `/health` can report it.
	define: { __ACP_HUB_VERSION__: JSON.stringify(version) }
};

/** @type {import('esbuild').BuildOptions[]} */
const builds = tests
	? [{
		...shared,
		// The smoke tests run inside the extension host, next to the bundled extension.
		entryPoints: ["test/smoke/extension.test.ts"],
		outfile: "out/test/extension.test.js",
		external: ["vscode", "mocha"]
	}]
	: [{
		...shared,
		entryPoints: ["src/extension.ts"],
		outfile: "dist/extension.js",
		minify: !watch
	}, {
		// VS Code runs this once after the extension is uninstalled.
		...shared,
		entryPoints: ["src/uninstall.ts"],
		outfile: "dist/uninstall.js",
		minify: !watch
	}, {
		// The control page: VS Code loads this into the sidebar's webview, and the
		// HTTP host serves the same file to a browser.
		...shared,
		platform: "browser",
		format: "iife",
		target: "es2022",
		external: [],
		entryPoints: ["src/ui/main.ts"],
		outfile: "dist/sidebar.js",
		minify: !watch
	}, {
		// The headless gateway is a program of its own: it ships beside the
		// extension, not inside it, so it is bundled outside dist/ and ignored
		// by the VSIX.
		...shared,
		entryPoints: ["src/main/server.ts"],
		outfile: "server-dist/server.js",
		minify: !watch
	}];

async function main() {
	for (const options of builds) {
		if (watch) {
			const context = await esbuild.context(options);
			await context.watch();
		} else {
			await esbuild.build(options);
		}
	}
}

main().catch(error => {
	console.error(error);
	process.exit(1);
});
