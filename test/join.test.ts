import { describe, expect, test } from 'bun:test';
import { join } from '../src/index.js';

describe('join', () => {
	test('strings and falsy values', () => {
		expect(join('a', 'b c', false, null, undefined, '', 'd')).toBe('a b c d');
	});
	test('bare true is skipped', () => {
		expect(join('a', true as never, 'b')).toBe('a b');
	});
	test('numbers and bigints stringify', () => {
		expect(join('a', 0, 1, 2n)).toBe('a 1 2');
	});
	test('nested arrays flatten', () => {
		expect(join(['a', ['b', false && 'x', ['c']]])).toBe('a b c');
	});
	test('dictionaries keep truthy keys', () => {
		expect(join({ a: true, b: 0, 'c d': 1 })).toBe('a c d');
	});
	test('no inputs gives empty string', () => {
		expect(join()).toBe('');
	});
});
