import { twMerge } from 'tailwind-merge';

/**
 * A conflict oracle takes a class string and returns the tokens that lose.
 * An empty array means no token conflicts with another.
 */
export type Oracle = (classes: string) => string[];

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

export const defaultOracle: Oracle = createTwMergeOracle();
