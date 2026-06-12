// Compiles candidate tokens with Tailwind v4 and prints their ASTs as JSON.
// The Rust side embeds this file and runs it once per invocation with the
// whole token batch. Tailwind is the ground truth; this is the only place
// JavaScript still runs.
//
// argv[2]: optional CSS entry. Imports, theme, and the tailwindcss install
//          all resolve from its directory; without it, a bare import from cwd.
// stdin:   JSON array of tokens.
// stdout:  JSON array of AST arrays, aligned with the input.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
const base = entry ? dirname(resolve(entry)) : process.cwd();

// Isolated installs (bun, pnpm) keep transitive deps out of the project's
// node_modules, and @tailwindcss/node usually arrives through the vite or
// postcss plugin. Resolve it directly when hoisted; otherwise hop through
// whichever Tailwind package the project does declare, whose real location
// in the store can see its own dependencies.
// Anchors are tried in order: the entry's directory first so the project's
// own Tailwind wins, then the invocation directory as the escape hatch for
// library packages (a shared ui kit rightly declares no tailwind at all).
let modPath;
const carriers = ['@tailwindcss/vite', '@tailwindcss/postcss', '@tailwindcss/cli', 'tailwindcss'];
for (const anchor of [base, process.cwd()]) {
	const require = createRequire(join(anchor, 'noop.js'));
	const resolvers = ['@tailwindcss/node', ...carriers];
	for (const name of resolvers) {
		try {
			const found = require.resolve(name);
			modPath = name === '@tailwindcss/node' ? found : createRequire(found).resolve('@tailwindcss/node');
			break;
		} catch {}
	}
	if (modPath) break;
}
if (!modPath) {
	console.error(`The stylesheet oracle compiles your classes with Tailwind itself. Install tailwindcss and @tailwindcss/node, both 4.2 or newer, in ${base}, ${process.cwd()}, or above them.`);
	process.exit(1);
}
const { __unstable__loadDesignSystem } = await import(pathToFileURL(modPath).href);

const css = entry ? readFileSync(entry, 'utf8') : '@import "tailwindcss";';
const designSystem = await __unstable__loadDesignSystem(css, { base });
if (typeof designSystem.candidatesToAst !== 'function') {
	console.error('candidatesToAst is missing: the stylesheet oracle needs tailwindcss 4.2 or newer.');
	process.exit(1);
}

const tokens = JSON.parse(readFileSync(0, 'utf8'));
const asts = designSystem.candidatesToAst(tokens);
// src/dst spans carry whole source files; the judge never looks at them.
process.stdout.write(JSON.stringify(asts, (key, value) => (key === 'src' || key === 'dst' ? undefined : value)));
