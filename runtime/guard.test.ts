import { test, expect, spyOn } from 'bun:test';

import { findConflicts, guard, join, type Conflict, type Oracle } from './index.js';
import { createMapOracle } from './map-oracle.js';

// A hand-written stylesheet map stands in for a generated one: enough tokens
// for these tests to contest realistically, nothing else.
const mapOracle = createMapOracle({
	version: 1,
	covers: {},
	tokens: {
		'p-2': [{ bucket: '', props: ['padding'] }],
		'p-4': [{ bucket: '', props: ['padding'] }],
		'm-2': [{ bucket: '', props: ['margin'] }],
		'text-sm': [{ bucket: '', props: ['font-size'] }],
		'text-lg': [{ bucket: '', props: ['font-size'] }],
		'mt-1': [{ bucket: '', props: ['margin-top'] }],
		'mt-2': [{ bucket: '', props: ['margin-top'] }],
		'mt-3': [{ bucket: '', props: ['margin-top'] }],
		flex: [{ bucket: '', props: ['display'] }],
		'gap-2': [{ bucket: '', props: ['gap'] }],
	},
});

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
