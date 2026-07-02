import type { Oracle } from './index.js';

/**
 * The overrule/map entry: the conflict oracle backed by your own compiled
 * stylesheet, via the map `overrule map` emits. No name tables, no peers.
 */

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
 * Build an oracle from a conflict map, so verdicts come from the stylesheet
 * that actually ships. Replays the dead-token rule: processing right to left,
 * a token is dropped only when every (bucket, prop) it declares is already
 * claimed by a kept token. Unknown tokens are never dropped and claim
 * nothing; dropped tokens beat nobody.
 *
 * @throws On a map version this runtime does not read.
 * @example
 * ```ts
 * import { createMapOracle } from 'overrule/map';
 * import map from './conflicts.json';
 *
 * const oracle = createMapOracle(map);
 * oracle('p-2 p-4 p-2'); // ['p-4']: the last p-2 is what the cascade reads
 * ```
 */
export declare function createMapOracle(map: ConflictMap): Oracle;
