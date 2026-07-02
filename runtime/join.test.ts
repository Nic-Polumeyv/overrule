import { test, expect } from 'bun:test';

import { join, type ClassValue } from './index.js';

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
