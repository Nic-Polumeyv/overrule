import { findConflicts, type Oracle } from './index.js';

/**
 * Check a class string for conflicts. ok means the oracle would change
 * nothing: every token survives, so the string needs no runtime referee.
 */
export function mergeFree(classes: string, oracle: Oracle): { ok: boolean; dropped: string[] } {
	const conflict = findConflicts(classes, oracle);
	return conflict ? { ok: false, dropped: conflict.dropped } : { ok: true, dropped: [] };
}

/** Throws when a class string has conflicting tokens, listing exactly which ones lose. */
export function assertMergeFree(classes: string, oracle: Oracle): void {
	const conflict = findConflicts(classes, oracle);

	if (conflict) {
		throw new Error(`classes are not merge-free: "${conflict.dropped.join(' ')}" would be dropped from "${classes}"`);
	}
}

/** Cartesian product of variant axes: { size: ['sm', 'lg'] } becomes [{ size: 'sm' }, { size: 'lg' }]. */
export function combos(axes: Record<string, readonly string[]>): Record<string, string>[] {
	const keys = Object.keys(axes);
	const n = keys.length;

	if (n === 0) return [{}];

	const out: Record<string, string>[] = [];
	const cur: Record<string, string> = {};

	function walk(i: number): void {
		if (i === n) {
			out.push({ ...cur });
			return;
		}

		const key = keys[i]!;
		const values = axes[key]!;

		for (let j = 0, l = values.length; j < l; j++) {
			cur[key] = values[j]!;
			walk(i + 1);
		}
	}

	walk(0);
	return out;
}

/**
 * Asserts that a variants function (cva, tailwind-variants, or hand-rolled)
 * produces a merge-free class string for every combination of its axes.
 * Run it in your test suite so merge-authored variants can never land.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertVariantsMergeFree<F extends (props?: any) => string>(
	variants: F,
	axes: Record<string, readonly string[]>,
	oracle: Oracle,
): void {
	const keys = Object.keys(axes);
	const n = keys.length;
	const cur: Record<string, string> = {};

	function walk(i: number): void {
		if (i === n) {
			const combo = { ...cur };

			try {
				assertMergeFree(variants(combo), oracle);
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`variant combo ${JSON.stringify(combo)}: ${detail}`);
			}

			return;
		}

		const key = keys[i]!;
		const values = axes[key]!;

		for (let j = 0, l = values.length; j < l; j++) {
			cur[key] = values[j]!;
			walk(i + 1);
		}
	}

	walk(0);
}