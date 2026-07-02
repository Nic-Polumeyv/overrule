import { test, expect } from 'bun:test';

import { declareVariants } from './index.js';
import { defaultOracle } from './oracle.js';
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
	assertMergeFree(button({ size: 'lg', tone: 'ghost' }), defaultOracle);
});

test('a merge-authored variant is caught', () => {
	const bad = declareVariants({ base: 'px-2', variants: { size: { sm: 'px-4' } }, defaultVariants: { size: 'sm' } });
	expect(() => assertMergeFree(bad(), defaultOracle)).toThrow(/px-2|px-4/);
});

test('assertVariantsMergeFree accepts a typed declareVariants function directly', () => {
	expect(() =>
		assertVariantsMergeFree(button, { size: ['sm', 'lg'], tone: ['solid', 'ghost'] }, defaultOracle),
	).not.toThrow();
});

// ---- guardrails ----

test('an unknown config key throws instead of silently dropping styling', () => {
	expect(() => declareVariants({ base: 'x', compoundVariants: [] } as never)).toThrow(
		/unknown config key "compoundVariants"/,
	);
});

test('an unknown selection selects nothing, prototype chain included', () => {
	expect(button({ size: 'huge' as never })).toBe('inline-flex items-center bg-black text-white');
	expect(button({ size: 'toString' as never })).toBe('inline-flex items-center bg-black text-white');
});

test('boolean axes take real booleans', () => {
	const toggle = declareVariants({
		base: 'btn',
		variants: { disabled: { true: 'is-disabled', false: 'is-enabled' } },
		defaultVariants: { disabled: false },
	});
	expect(toggle()).toBe('btn is-enabled');
	expect(toggle({ disabled: true })).toBe('btn is-disabled');
	expect(toggle({ disabled: null })).toBe('btn');
});

test('a null default means no default for that axis', () => {
	const plain = declareVariants({
		base: 'b',
		variants: { tone: { a: 'x' } },
		defaultVariants: { tone: null },
	});
	expect(plain()).toBe('b');
	expect(plain({ tone: 'a' })).toBe('b x');
});

test('the base-less props path does not leak a leading space either', () => {
	const plain = declareVariants({ variants: { tone: { a: 'text-red-500' } }, defaultVariants: { tone: 'a' } });
	expect(plain({ tone: 'a' })).toBe('text-red-500');
	expect(plain({ tone: null, class: 'mt-1' })).toBe('mt-1');
});

test('a variants-less config still appends the caller class', () => {
	expect(declareVariants({ base: 'card' })({ class: 'mt-2' })).toBe('card mt-2');
	expect(declareVariants({})({ class: 'mt-2' })).toBe('mt-2');
	expect(declareVariants({ base: 'card' })()).toBe('card');
});
