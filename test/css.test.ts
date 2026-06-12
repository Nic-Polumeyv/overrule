import { beforeAll, describe, expect, test } from 'bun:test';
import { createCssOracle } from '../src/css.js';
import type { Oracle } from '../src/index.js';

let oracle: Oracle;

beforeAll(async () => {
	oracle = await createCssOracle({
		css: '@import "tailwindcss"; @utility border-grid { border: 1px solid red; }',
		base: process.cwd(),
	});
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
	});

	test('a later shorthand kills the longhand, the reverse layers', () => {
		expect(oracle('px-2 p-4')).toEqual(['px-2']);
		expect(oracle('p-4 px-2')).toEqual([]);
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
	});

	test('ring and shadow compose through the shared box-shadow', () => {
		expect(oracle('ring-2 shadow-lg')).toEqual([]);
	});

	test('arbitrary properties contest the real property', () => {
		expect(oracle('[padding:1rem] p-4')).toEqual(['[padding:1rem]']);
		expect(oracle('font-medium [font-weight:900]')).toEqual(['font-medium']);
	});

	test('tokens that only set custom properties stay alive', () => {
		expect(oracle('[--cell-size:3rem] p-4')).toEqual([]);
	});

	test('unknown tokens are skipped, never reported', () => {
		expect(oracle('text-xsm p-4 p-2')).toEqual(['p-4']);
		expect(oracle('not-a-class also-not-one')).toEqual([]);
	});
});
