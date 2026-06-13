import { findConflicts, type Oracle } from './index.js';

/**
 * Check a class string for conflicts. ok means the oracle would change
 * nothing: every token survives, so the string needs no runtime referee.
 */
export function mergeFree(classes: string, oracle?: Oracle): { ok: boolean; dropped: string[] } {
	const conflict = findConflicts(classes, oracle);
	return conflict ? { ok: false, dropped: conflict.dropped } : { ok: true, dropped: [] };
}

/** Throws when a class string has conflicting tokens, listing exactly which ones lose. */
export function assertMergeFree(classes: string, oracle?: Oracle): void {
	const result = mergeFree(classes, oracle);
	if (!result.ok) {
		throw new Error(`classes are not merge-free: "${result.dropped.join(' ')}" would be dropped from "${classes}"`);
	}
}

/** Cartesian product of variant axes: { size: ['sm', 'lg'] } becomes [{ size: 'sm' }, { size: 'lg' }]. */
export function combos(axes: Record<string, readonly string[]>): Record<string, string>[] {
	const keys = Object.keys(axes);
	if (keys.length === 0) return [{}];
	return keys.reduce<Record<string, string>[]>(
		(acc, key) => acc.flatMap((partial) => axes[key].map((value) => ({ ...partial, [key]: value }))),
		[{}],
	);
}

/**
 * Asserts that a variants function (cva, tailwind-variants, or hand-rolled)
 * produces a merge-free class string for every combination of its axes.
 * Run it in your test suite so merge-authored variants can never land.
 */
export function assertVariantsMergeFree(
	variants: (props?: Record<string, string>) => string,
	axes: Record<string, readonly string[]>,
	oracle?: Oracle,
): void {
	for (const combo of combos(axes)) {
		try {
			assertMergeFree(variants(combo), oracle);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error(`variant combo ${JSON.stringify(combo)}: ${detail}`);
		}
	}
}
