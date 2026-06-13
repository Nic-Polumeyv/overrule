import { test, expect } from 'bun:test';

import { declareVariants } from './index.js';
import { assertMergeFree, assertVariantsMergeFree } from './test.js';

const button = declareVariants({
	base: 'inline-flex items-center',
	variants: {
		size: { sm: 'h-8 px-2 text-sm', lg: 'h-11 px-4 text-base' },
		tone: { solid: 'bg-black text-white', ghost: 'bg-transparent text-black' },
	},
	defaultVariants: { size: 'sm', tone: 'solid' },
});

test('no props returns base plus the default variants', () => {
	expect(button()).toBe('inline-flex items-center h-8 px-2 text-sm bg-black text-white');
});

test('a selection overrides that axis default', () => {
	expect(button({ size: 'lg' })).toBe('inline-flex items-center h-11 px-4 text-base bg-black text-white');
});

test('an omitted axis falls back to its default', () => {
	expect(button({ tone: 'ghost' })).toBe('inline-flex items-center h-8 px-2 text-sm bg-transparent text-black');
});

test('null opts an axis out and skips its default', () => {
	expect(button({ size: null })).toBe('inline-flex items-center bg-black text-white');
});

test('the caller class is appended last', () => {
	expect(button({ class: 'mt-2' })).toBe('inline-flex items-center h-8 px-2 text-sm bg-black text-white mt-2');
});

test('a base-less config does not leak a leading space', () => {
	const plain = declareVariants({ variants: { tone: { a: 'text-red-500' } }, defaultVariants: { tone: 'a' } });
	expect(plain()).toBe('text-red-500');
});

test('disjoint variants are merge-free', () => {
	assertMergeFree(button({ size: 'lg', tone: 'ghost' }));
});

test('a merge-authored variant is caught', () => {
	const bad = declareVariants({ base: 'px-2', variants: { size: { sm: 'px-4' } }, defaultVariants: { size: 'sm' } });
	expect(() => assertMergeFree(bad())).toThrow(/px-2|px-4/);
});

test('assertVariantsMergeFree accepts a declareVariants function', () => {
	// assertVariantsMergeFree takes the loose (props?: Record<string, string>) => string
	// contract; declareVariants returns a stricter function, so widen it for the helper.
	assertVariantsMergeFree(button as unknown as (props?: Record<string, string>) => string, {
		size: ['sm', 'lg'],
		tone: ['solid', 'ghost'],
	});
});
