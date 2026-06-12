import { describe, expect, test } from 'bun:test';
import { createTwMergeOracle, findConflicts, guard, join, type Oracle } from '../src/index.js';
import { assertVariantsMergeFree, mergeFree } from '../src/test.js';

describe('createTwMergeOracle', () => {
	const oracle = createTwMergeOracle();
	test('matches the default behavior', () => {
		expect(oracle('h-9 px-4 h-8')).toEqual(['h-9']);
		expect(oracle('h-8 px-4 h-8')).toEqual([]);
		expect(oracle('font-medium font-normal!')).toEqual([]);
		expect(oracle('text-sm leading-snug text-xs')).toEqual(expect.arrayContaining(['text-sm', 'leading-snug']));
	});
});

describe('oracle injection', () => {
	const fake: Oracle = (classes) => classes.split(/\s+/).filter((t) => t === 'loser');

	test('findConflicts honors a custom oracle', () => {
		expect(findConflicts('a loser b', fake)?.dropped).toEqual(['loser']);
		expect(findConflicts('h-9 h-8', fake)).toBeNull();
	});

	test('guard honors a custom oracle', () => {
		const dropped: string[][] = [];
		const cn = guard(join, (c) => dropped.push(c.dropped), fake);
		cn('a', 'loser');
		cn('h-9', 'h-8');
		expect(dropped).toEqual([['loser']]);
	});

	test('test helpers honor a custom oracle', () => {
		expect(mergeFree('h-9 h-8', fake).ok).toBe(true);
		expect(() => assertVariantsMergeFree(() => 'a loser', {}, fake)).toThrow('loser');
	});
});
