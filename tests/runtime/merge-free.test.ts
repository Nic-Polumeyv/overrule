import { test, expect } from 'bun:test';

import { declareVariants } from '../../runtime/index.js';
import { assertMergeFree, assertVariantsMergeFree, combos, mergeFree } from '../../runtime/test.js';
import { mapOracle } from './oracle-fixture.js';

// ---- combos ----

test('combos builds the full cartesian product, last axis included', () => {
	expect(combos({ a: ['1', '2'], b: ['x', 'y'] })).toEqual([
		{ a: '1', b: 'x' },
		{ a: '1', b: 'y' },
		{ a: '2', b: 'x' },
		{ a: '2', b: 'y' },
	]);
	expect(combos({ only: ['one'] })).toEqual([{ only: 'one' }]);
	expect(combos({})).toEqual([{}]);
});

// ---- mergeFree / assertMergeFree ----

test('mergeFree is ok for a clean string and lists losers otherwise', () => {
	expect(mergeFree('p-2 m-2', mapOracle)).toEqual({ ok: true, dropped: [] });
	expect(mergeFree('p-2 p-4', mapOracle)).toEqual({ ok: false, dropped: ['p-2'] });
});

test('assertMergeFree throws naming the losers', () => {
	expect(() => assertMergeFree('p-2 m-2', mapOracle)).not.toThrow();
	expect(() => assertMergeFree('p-2 p-4', mapOracle)).toThrow(/"p-2".*p-2 p-4/);
});

// ---- assertVariantsMergeFree ----

test('a conflict hiding in the last combination of the last axis is found', () => {
	const badge = declareVariants({
		base: 'p-2',
		variants: {
			tone: { plain: 'text-black', loud: 'text-red-500' },
			pad: { none: '', big: 'p-4' },
		},
	});

	expect(() =>
		assertVariantsMergeFree(badge, { tone: ['plain', 'loud'], pad: ['none', 'big'] }, mapOracle),
	).toThrow(/\{"tone":"plain","pad":"big"\}.*"p-2"/);
});

test('a merge-free variants function passes every combination', () => {
	const clean = declareVariants({
		base: 'inline-flex',
		variants: { size: { sm: 'h-8', lg: 'h-11' } },
	});

	// Typed variants functions are accepted without a widening cast.
	expect(() => assertVariantsMergeFree(clean, { size: ['sm', 'lg'] }, mapOracle)).not.toThrow();
});
