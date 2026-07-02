import type { Oracle } from './index.js';

/**
 * The overrule/test entry: assertion helpers that make merge-free class
 * strings a test suite invariant instead of a hope.
 */

/**
 * Check a class string for conflicts.
 *
 * @returns ok true when the oracle would change nothing, otherwise the
 * losing tokens under dropped.
 */
export declare function mergeFree(classes: string, oracle: Oracle): { ok: boolean; dropped: string[] };

/**
 * Assert a class string is merge-free.
 *
 * @throws Naming exactly which tokens lose, when any do.
 */
export declare function assertMergeFree(classes: string, oracle: Oracle): void;

/** Cartesian product of variant axes: { size: ['sm', 'lg'] } becomes [{ size: 'sm' }, { size: 'lg' }]. */
export declare function combos(axes: Record<string, readonly string[]>): Record<string, string>[];

/**
 * Assert a variants function (cva, tailwind-variants, or hand-rolled)
 * produces a merge-free class string for every combination of its axes.
 * Run it in your test suite so merge-authored variants can never land.
 *
 * @throws Naming the first failing combination and its losing tokens.
 * @example
 * ```ts
 * test('button variants are merge-free', () => {
 * 	assertVariantsMergeFree(button, { size: ['sm', 'lg'], tone: ['solid', 'ghost'] }, oracle);
 * });
 * ```
 */
export declare function assertVariantsMergeFree<F extends (props?: any) => string>(
	variants: F,
	axes: Record<string, readonly string[]>,
	oracle: Oracle,
): void;
