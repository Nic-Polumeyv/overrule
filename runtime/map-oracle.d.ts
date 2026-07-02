import type { Oracle } from './index.js';

/**
 * One compiled declaration group of a token. The bucket encodes the full
 * condition context (media queries, variants, pseudo pinning, importance)
 * as an opaque key; equality is its only operation, never parse it.
 */
export type DeclarationGroup = {
	bucket: string;
	/** CSS properties the group declares. Custom properties ("--x") count like any other. */
	props: readonly string[];
};

/**
 * The conflict map `overrule map` emits: every token in the project compiled
 * with the real stylesheet. `covers` lists shorthand relationships: a kept
 * declaration of property P also beats declarations of every property in
 * covers[P] within the same bucket.
 */
export type ConflictMap = {
	version: 1;
	covers: Record<string, readonly string[]>;
	tokens: Record<string, readonly DeclarationGroup[]>;
};

/**
 * An oracle judged by a conflict map instead of tailwind-merge's name tables,
 * so the verdicts come from the stylesheet that actually ships. Replays the
 * dead-token rule: processing right to left, a token is dropped only when it
 * declares something and every (bucket, prop) it declares is already claimed
 * by a kept token. Unknown tokens are never dropped and claim nothing; the
 * map has no evidence about them. Dropped tokens claim nothing either: their
 * declarations lost, so they beat nobody.
 */
export declare function createMapOracle(map: ConflictMap): Oracle;
