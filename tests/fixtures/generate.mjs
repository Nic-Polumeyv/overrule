// Regenerates asts.json and asts-prefixed.json: candidatesToAst dumps for
// every token the css tests judge, straight from the tailwindcss in this
// repo's node_modules. Run after bumping tailwindcss:
//
//   bun install && node tests/fixtures/generate.mjs && cargo test
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __unstable__loadDesignSystem } from '@tailwindcss/node';

const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..', '..');

// src/dst spans carry whole source files; the judge never looks at them.
const strip = (key, value) => (key === 'src' || key === 'dst' ? undefined : value);
const dump = (designSystem, tokens) => {
	const asts = designSystem.candidatesToAst(tokens);
	const out = {};
	tokens.forEach((token, i) => (out[token] = asts[i] ?? []));
	return out;
};

const main = await __unstable__loadDesignSystem(
	'@import "tailwindcss"; @utility border-grid { border: 1px solid red; }',
	{ base },
);
const tokens = [
	'h-9', 'px-4', 'h-8', 'px-2', 'text-sm', 'bg-red-500', 'p-2', 'bg-blue-500',
	'flex', 'items-center', 'rounded-md', 'font-medium', 'font-normal!', 'font-medium!',
	'p-4', 'md:p-4', 'md:p-2', 'hover:md:p-2', 'md:hover:p-4',
	'before:hover:m-1', 'hover:before:m-2', 'before:focus:underline', 'before:focus:no-underline', 'focus:before:no-underline',
	'scroll-mt-2', 'scroll-m-4', 'border-grid', 'border-red-500',
	'leading-snug', 'text-xs', 'leading-tight', 'ordinal', 'slashed-zero',
	'focus-visible:ring-red-500/50', '[font-weight:900]', 'translate-x-2', 'translate-none', 'normal-nums',
	'ring-2', 'shadow-lg', 'ring-red-500/50', 'focus-visible:ring-[3px]', 'aria-invalid:ring-red-500/20',
	'text-lg/7', 'line-clamp-2',
	'[&>svg]:size-4', '[&>svg]:size-5', '[&>svg]:hover:size-4', 'hover:[&>svg]:size-5',
	'[padding:1rem]', '[--cell-size:3rem]',
	'text-xsm', 'not-a-class', 'also-not-one', 'btn',
];
writeFileSync(join(here, 'asts.json'), JSON.stringify(dump(main, tokens), strip, '\t'));

const prefixed = await __unstable__loadDesignSystem('@import "tailwindcss" prefix(tw);', { base });
writeFileSync(
	join(here, 'asts-prefixed.json'),
	JSON.stringify(dump(prefixed, ['tw:p-2', 'tw:p-4', 'p-2', 'p-4']), strip, '\t'),
);
console.log('regenerated asts.json and asts-prefixed.json');
