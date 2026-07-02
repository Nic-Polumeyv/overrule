import { twMerge } from 'tailwind-merge';

import type { Oracle } from './index.js';


/**
 * The default oracle. tailwind-merge's group tables decide which tokens
 * survive; anything it would remove is a conflict. Duplicates are not
 * conflicts.
 */
export function createTwMergeOracle(): Oracle {
	return (classes) => {
		const kept = new Set(twMerge(classes).split(' '));
		return [...new Set(classes.split(/\s+/))].filter((token) => token && !kept.has(token));
	};
}

let cached: Oracle | undefined;

/**
 * The default oracle, built on first use so importing join alone never
 * constructs tailwind-merge's tables, in a bundle or on a server.
 */
export const defaultOracle: Oracle = (classes) => (cached ??= createTwMergeOracle())(classes);
