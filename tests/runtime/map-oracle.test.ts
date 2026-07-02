import { test, expect } from 'bun:test';

import { createMapOracle, type ConflictMap } from '../../runtime/map-oracle.js';

// Hand-written fixture, tailwind-flavored for readability. Buckets are opaque
// keys from the oracle's point of view; the names here mean nothing to it.
const map: ConflictMap = {
	version: 1,
	covers: {
		margin: ['margin-top', 'margin-bottom'],
		// Deliberately not flattened: border does NOT list border-top-width.
		// The oracle expands one level only; the emitter owns transitivity.
		border: ['border-width'],
		'border-width': ['border-top-width'],
	},
	tokens: {
		'p-2': [{ bucket: 'base', props: ['padding'] }],
		'p-4': [{ bucket: 'base', props: ['padding'] }],
		'sm:p-8': [{ bucket: 'sm', props: ['padding'] }],
		'm-2': [{ bucket: 'base', props: ['margin'] }],
		'mt-4': [{ bucket: 'base', props: ['margin-top'] }],
		border: [{ bucket: 'base', props: ['border'] }],
		'border-w': [{ bucket: 'base', props: ['border-width'] }],
		'border-t-w': [{ bucket: 'base', props: ['border-top-width'] }],
		ring: [{ bucket: 'base', props: ['--tw-ring-shadow', 'box-shadow'] }],
		'shadow-none': [{ bucket: 'base', props: ['box-shadow'] }],
		'p-fluid': [
			{ bucket: 'base', props: ['padding'] },
			{ bucket: 'sm', props: ['padding'] },
		],
		'no-decls': [],
	},
};

const oracle = createMapOracle(map);

// ---- version gate ----

test('a map with any other version is rejected at creation', () => {
	expect(() => createMapOracle({ ...map, version: 2 } as unknown as ConflictMap)).toThrow(/version 2.*version 1/);
	expect(() => createMapOracle({ covers: {}, tokens: {} } as unknown as ConflictMap)).toThrow(/undefined.*version 1/);
});

// ---- the dead-token rule ----

test('same bucket, same property: the left token is dropped', () => {
	expect(oracle('p-2 p-4')).toEqual(['p-2']);
	expect(oracle('p-4 p-2')).toEqual(['p-4']);
});

test('different properties do not conflict', () => {
	expect(oracle('p-2 m-2')).toEqual([]);
});

test('different buckets never conflict, same property or not', () => {
	expect(oracle('p-2 sm:p-8')).toEqual([]);
	expect(oracle('sm:p-8 p-4')).toEqual([]);
});

test('a kept shorthand beats the properties it covers', () => {
	expect(oracle('mt-4 m-2')).toEqual(['mt-4']);
});

test('a longhand does not beat the shorthand that covers it', () => {
	expect(oracle('m-2 mt-4')).toEqual([]);
});

test('an unclaimed custom property keeps a token alive', () => {
	// shadow-none claims box-shadow but --tw-ring-shadow still escapes: cva
	// fragments meet at runtime and the reader can sit in another string.
	expect(oracle('ring shadow-none')).toEqual([]);
	expect(oracle('shadow-none ring')).toEqual(['shadow-none']);
});

test('unknown tokens are never dropped and claim nothing', () => {
	expect(oracle('wat p-2 p-4')).toEqual(['p-2']);
	expect(oracle('wat wat')).toEqual([]);
	expect(oracle('p-2 wat')).toEqual([]);
});

test('tokens named after Object.prototype members are unknown, not inherited', () => {
	expect(oracle('toString constructor hasOwnProperty')).toEqual([]);
});

test('exact duplicates are one token and never self-conflict', () => {
	expect(oracle('p-2 p-2')).toEqual([]);
	// Set semantics: the deduped list keeps first positions, so the trailing
	// duplicate does not resurrect p-2 past p-4.
	// The last p-2 is the instance the cascade reads, so p-4 is the loser.
	expect(oracle('p-2 p-4 p-2')).toEqual(['p-4']);
});

test('a dropped token claims nothing', () => {
	// border claims border-width (one covers hop), which kills border-w. If
	// the dead border-w still claimed, its covers entry would reach
	// border-top-width and wrongly kill border-t-w.
	expect(oracle('border-t-w border-w border')).toEqual(['border-w']);
});

test('covers expansion is one level, not transitive', () => {
	expect(oracle('border-t-w border')).toEqual([]);
});

test('a token with no declaration groups is never dropped', () => {
	expect(oracle('no-decls no-decls p-2')).toEqual([]);
});

test('a token survives while any of its declaration groups is unbeaten', () => {
	expect(oracle('p-fluid p-4')).toEqual([]);
	expect(oracle('p-fluid sm:p-8')).toEqual([]);
	expect(oracle('p-fluid p-4 sm:p-8')).toEqual(['p-fluid']);
});

test('empty and whitespace-only input drops nothing', () => {
	expect(oracle('')).toEqual([]);
	expect(oracle('   ')).toEqual([]);
});

test('dropped tokens come back in string order, not discovery order', () => {
	// Right-to-left processing discovers mt-4 before p-2; the output must not.
	expect(oracle('p-2 mt-4 p-4 m-2')).toEqual(['p-2', 'mt-4']);
});

test('extra whitespace between tokens is not a token', () => {
	expect(oracle('  p-2   p-4  ')).toEqual(['p-2']);
});
