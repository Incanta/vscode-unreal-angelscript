const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build language-server started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build language-server finished');
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/server.ts',
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		banner: {
			js: '#!/usr/bin/env node',
		},
		outdir: 'dist',
		external: ['vscode'],
		// Prettier 3's ESM entry calls createRequire(import.meta.url); when
		// bundled into CJS, esbuild stubs import.meta to {}, which makes
		// createRequire(undefined) throw at module load. Point it at the
		// bundled file's own location so it (and fileURLToPath) get a valid URL.
		banner: {
			js: 'const __IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;',
		},
		define: {
			'import.meta.url': '__IMPORT_META_URL__',
		},
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
