import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { cssOracle, typoOracle } from '../src/css.js';
import { createCssOracle, loadDesignSystem } from '../src/css-node.js';
import type { Oracle } from '../src/index.js';

let oracle: Oracle;
let typos: Oracle;
let prefixed: Oracle;

beforeAll(async () => {
	const designSystem = await loadDesignSystem({
		css: '@import "tailwindcss"; @utility border-grid { border: 1px solid red; }',
		base: process.cwd(),
	});
	oracle = cssOracle(designSystem);
	typos = typoOracle(designSystem);
	prefixed = await createCssOracle({ css: '@import "tailwindcss" prefix(tw);', base: process.cwd() });
});

describe('createCssOracle', () => {
	test('same property in the same bucket conflicts, last wins', () => {
		expect(oracle('h-9 px-4 h-8')).toEqual(['h-9']);
		expect(oracle('px-4 px-2 text-sm')).toEqual(['px-4']);
		expect(oracle('bg-red-500 p-2 bg-blue-500')).toEqual(['bg-red-500']);
	});

	test('duplicates are not conflicts', () => {
		expect(oracle('h-8 px-4 h-8')).toEqual([]);
	});

	test('unrelated tokens never conflict', () => {
		expect(oracle('flex h-9 items-center rounded-md')).toEqual([]);
	});

	test('important and normal never conflict, two importants do', () => {
		expect(oracle('font-medium font-normal!')).toEqual([]);
		expect(oracle('font-medium! font-normal!')).toEqual(['font-medium!']);
	});

	test('variants bucket by meaning, not by spelling order', () => {
		expect(oracle('p-2 md:p-4')).toEqual([]);
		expect(oracle('md:p-2 md:p-4')).toEqual(['md:p-2']);
		expect(oracle('hover:md:p-2 md:hover:p-4')).toEqual(['hover:md:p-2']);
	});

	test('pseudo-element variant order styles different boxes', () => {
		expect(oracle('before:hover:m-1 hover:before:m-2')).toEqual([]);
		expect(oracle('before:focus:underline before:focus:no-underline')).toEqual(['before:focus:underline']);
		expect(oracle('before:focus:underline focus:before:no-underline')).toEqual([]);
	});

	test('a later shorthand kills the longhand, the reverse layers', () => {
		expect(oracle('px-2 p-4')).toEqual(['px-2']);
		expect(oracle('p-4 px-2')).toEqual([]);
		expect(oracle('scroll-mt-2 scroll-m-4')).toEqual(['scroll-mt-2']);
		expect(oracle('scroll-m-4 scroll-mt-2')).toEqual([]);
	});

	test('custom utilities are first class: border-grid survives a border color', () => {
		// tailwind-merge misreads border-grid as a border color and deletes it.
		expect(oracle('border-grid border-red-500')).toEqual([]);
		expect(oracle('border-red-500 border-grid')).toEqual(['border-red-500']);
	});

	test('v4 composition through custom properties is not a conflict', () => {
		// tailwind-merge drops leading-snug after text-xs; the compiled CSS
		// shows text-* reading --tw-leading, so they compose.
		expect(oracle('leading-snug text-xs')).toEqual([]);
		expect(oracle('text-xs leading-snug')).toEqual([]);
		expect(oracle('leading-tight leading-snug')).toEqual(['leading-tight']);
		expect(oracle('ordinal slashed-zero')).toEqual([]);
	});

	test('an unbeaten custom property is an export, not dead weight', () => {
		// cva splits strings that only meet at runtime: the variant sets the
		// ring color, the base sets the ring width, and the variable lives on
		// the element. Anything the merge tables would kill here is a
		// cross-check conversation, never a fix.
		expect(oracle('focus-visible:ring-red-500/50 bg-red-500')).toEqual([]);
		expect(oracle('font-medium [font-weight:900]')).toEqual([]);
		expect(oracle('translate-x-2 translate-none')).toEqual([]);
		expect(oracle('ordinal normal-nums')).toEqual([]);
	});

	test('ring and shadow compose through the shared box-shadow', () => {
		expect(oracle('ring-2 shadow-lg')).toEqual([]);
	});

	test('custom properties cross buckets: ring color feeds ring width', () => {
		// The shadcn pattern. The color is set under one state, the width
		// under another, and the variable lives on the element, so both
		// apply the moment the states hold together.
		expect(oracle('ring-red-500/50 focus-visible:ring-[3px]')).toEqual([]);
		expect(oracle('aria-invalid:ring-red-500/20 focus-visible:ring-[3px]')).toEqual([]);
	});

	test('a postfix line height kills an earlier text size whole', () => {
		expect(oracle('text-sm text-lg/7')).toEqual(['text-sm']);
		expect(oracle('text-lg/7 leading-snug')).toEqual([]);
		// leading-snug before the postfix survives too: its variable is an
		// export, and the tables disagree here on purpose.
		expect(oracle('leading-snug text-lg/7')).toEqual([]);
	});

	test('multi-declaration utilities die only when fully covered', () => {
		expect(oracle('flex line-clamp-2')).toEqual(['flex']);
		expect(oracle('line-clamp-2 flex')).toEqual([]);
	});

	test('arbitrary variants compile and bucket like any other', () => {
		expect(oracle('[&>svg]:size-4 [&>svg]:size-5')).toEqual(['[&>svg]:size-4']);
		expect(oracle('[&>svg]:hover:size-4 hover:[&>svg]:size-5')).toEqual([]);
	});

	test('arbitrary properties contest the real property', () => {
		expect(oracle('[padding:1rem] p-4')).toEqual(['[padding:1rem]']);
	});

	test('tokens that only set custom properties stay alive', () => {
		expect(oracle('[--cell-size:3rem] p-4')).toEqual([]);
	});

	test('unknown tokens are skipped, never reported', () => {
		expect(oracle('text-xsm p-4 p-2')).toEqual(['p-4']);
		expect(oracle('not-a-class also-not-one')).toEqual([]);
	});

	test('a prefixed project conflicts on prefixed tokens and ignores bare ones', () => {
		expect(prefixed('tw:p-2 tw:p-4')).toEqual(['tw:p-2']);
		expect(prefixed('p-2 p-4')).toEqual([]);
	});
});

describe('cssOracle', () => {
	test('rejects anything without candidatesToAst', () => {
		expect(() => cssOracle({} as never)).toThrow('candidatesToAst');
	});
});

describe('typoOracle', () => {
	test('reports tokens that compile to nothing, custom utilities count as known', () => {
		expect(typos('p-4 text-xsm btn')).toEqual(['text-xsm', 'btn']);
		expect(typos('flex h-9 border-grid')).toEqual([]);
	});
});

describe('platform neutrality', () => {
	test('only the cli, the scanner, and the node loader may touch node', () => {
		const neutral = ['index.ts', 'oracle.ts', 'parse.ts', 'test.ts', 'css.ts'];
		for (const file of neutral) {
			const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
			expect(src).not.toMatch(/\bnode:|@tailwindcss\/node|\bprocess\./);
		}
	});
});
