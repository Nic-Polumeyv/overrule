import { test, expect, spyOn } from 'bun:test';

import {
	declareVariants,
	findConflicts,
	guard,
	join,
	type ClassValue,
	type Conflict,
	type Oracle,
} from '../../runtime/index.js';
import { assertMergeFree, assertVariantsMergeFree } from '../../runtime/test.js';
import { mapOracle } from './oracle-fixture.js';

// ---- join: clsx parity ----

// The parity contract: every expectation below is what clsx 2.1.1 returns for
// the same input. If join drifts from these, it stops being a drop-in.

test('the readme kitchen sink matches clsx', () => {
	expect(join('foo', [1 && 'bar', { baz: false, bat: null }, ['hello', ['world']]], 'cya')).toBe(
		'foo bar hello world cya',
	);
});

test('falsy values are dropped, truthy strings and numbers render', () => {
	expect(join('a', '', null, undefined, false, 0, NaN, 'b')).toBe('a b');
	expect(join(42, -1, 1.5, Infinity)).toBe('42 -1 1.5 Infinity');
	expect(join(true)).toBe('');
});

test('bigint, functions, and symbols are dropped like clsx drops them', () => {
	expect(join(1n)).toBe('');
	expect(join(0n)).toBe('');
	expect(join(['a', (() => 'x') as unknown as ClassValue, 'b'])).toBe('a b');
	expect(join(['a', Symbol('s') as unknown as ClassValue])).toBe('a');
});

test('dictionaries gate keys on value truthiness', () => {
	expect(join({ a: true, b: false, c: 0, d: null, e: undefined, f: 1, g: 'yes' })).toBe('a f g');
	expect(join({ 'px-2': [] }, { 'py-1': {} })).toBe('px-2 py-1');
});

test('arrays flatten at any depth, holes and empties skipped', () => {
	expect(join(['a', ['b', ['c', ['d']]]])).toBe('a b c d');
	expect(join([], [[]], [[[null]]])).toBe('');
	// eslint-disable-next-line no-sparse-arrays
	expect(join(['a', , 'b'])).toBe('a b');
});

test('whitespace inside strings is preserved verbatim', () => {
	expect(join('  a  b  ', 'c')).toBe('  a  b   c');
});

test('a huge flat array does not overflow the stack', () => {
	const big = new Array<string>(200_000).fill('x');
	const out = join(big);
	expect(out.length).toBe(200_000 * 2 - 1);
});

test('deep nesting does not overflow the stack', () => {
	let nested: ClassValue = 'leaf';
	for (let i = 0; i < 10_000; i++) nested = [nested];
	expect(join(nested)).toBe('leaf');
});

// ---- findConflicts and guard ----

// ---- findConflicts ----

test('findConflicts reports the losers of a real tailwind conflict', () => {
	const conflict = findConflicts('p-2 p-4', mapOracle);
	expect(conflict).toEqual({ input: 'p-2 p-4', dropped: ['p-2'] });
});

test('findConflicts is null when nothing conflicts', () => {
	expect(findConflicts('p-2 m-2', mapOracle)).toBeNull();
	expect(findConflicts('', mapOracle)).toBeNull();
});

test('findConflicts threads a custom oracle', () => {
	const oracle: Oracle = (classes) => (classes.includes('loser') ? ['loser'] : []);
	expect(findConflicts('a loser', oracle)).toEqual({ input: 'a loser', dropped: ['loser'] });
	expect(findConflicts('p-2 p-4', oracle)).toBeNull();
});

// ---- guard ----

test('guard passes output through unchanged and reports the conflict', () => {
	const seen: Conflict[] = [];
	const cn = guard(join, mapOracle, (conflict) => seen.push(conflict));

	expect(cn('text-sm', 'text-lg')).toBe('text-sm text-lg');
	expect(seen).toEqual([{ input: 'text-sm text-lg', dropped: ['text-sm'] }]);

	expect(cn('flex', 'gap-2')).toBe('flex gap-2');
	expect(seen).toHaveLength(1);
});

test('guard threads a custom oracle to the callback', () => {
	const oracle: Oracle = () => ['always'];
	const seen: Conflict[] = [];
	const cn = guard(join, oracle, (conflict) => seen.push(conflict));

	cn('anything');
	expect(seen).toEqual([{ input: 'anything', dropped: ['always'] }]);
});

test('the default reporter warns once per input, not once per dropped set', () => {
	const warn = spyOn(console, 'warn').mockImplementation(() => {});
	try {
		const cn = guard(join, mapOracle);

		cn('mt-1 mt-2');
		cn('mt-1 mt-2');
		expect(warn).toHaveBeenCalledTimes(1);

		// A different string dropping the same token is a different bug site
		// and must not be swallowed by the first warning.
		cn('mt-1 mt-3');
		expect(warn).toHaveBeenCalledTimes(2);
	} finally {
		warn.mockRestore();
	}
});

// ---- declareVariants: cva parity and guardrails ----

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
	assertMergeFree(button({ size: 'lg', tone: 'ghost' }), mapOracle);
});

test('a merge-authored variant is caught', () => {
	const bad = declareVariants({ base: 'px-2', variants: { size: { sm: 'px-4' } }, defaultVariants: { size: 'sm' } });
	expect(() => assertMergeFree(bad(), mapOracle)).toThrow(/px-2|px-4/);
});

test('assertVariantsMergeFree accepts a typed declareVariants function directly', () => {
	expect(() =>
		assertVariantsMergeFree(button, { size: ['sm', 'lg'], tone: ['solid', 'ghost'] }, mapOracle),
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

test('the trailing class takes anything join takes', () => {
	expect(button({ size: 'lg', class: ['mt-2', { hidden: false, block: true }] })).toBe(
		'inline-flex items-center h-11 px-4 text-base bg-black text-white mt-2 block',
	);
	expect(button({ class: null })).toBe('inline-flex items-center h-8 px-2 text-sm bg-black text-white');
	expect(declareVariants({ base: 'card' })({ class: ['a', 0, 'b'] })).toBe('card a b');
	expect(declareVariants({})({ class: [null, undefined] })).toBe('');
});
