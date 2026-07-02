import type { Oracle } from './index.js';

/**
 * Check a class string for conflicts. ok means the oracle would change
 * nothing: every token survives, so the string needs no runtime referee.
 */
export declare function mergeFree(classes: string, oracle: Oracle): { ok: boolean; dropped: string[] };

/** Throws when a class string has conflicting tokens, listing exactly which ones lose. */
export declare function assertMergeFree(classes: string, oracle: Oracle): void;

/** Cartesian product of variant axes: { size: ['sm', 'lg'] } becomes [{ size: 'sm' }, { size: 'lg' }]. */
export declare function combos(axes: Record<string, readonly string[]>): Record<string, string>[];

/**
 * Asserts that a variants function (cva, tailwind-variants, or hand-rolled)
 * produces a merge-free class string for every combination of its axes.
 * Run it in your test suite so merge-authored variants can never land.
 */
export declare function assertVariantsMergeFree<F extends (props?: any) => string>(
	variants: F,
	axes: Record<string, readonly string[]>,
	oracle: Oracle,
): void;
