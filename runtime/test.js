// Types live in test.d.ts, the hand-written public reference; this file
// borrows them via import() so the two cannot use different shapes silently.
import { findConflicts } from './index.js';

/**
 * Check a class string for conflicts. ok means the oracle would change
 * nothing: every token survives, so the string needs no runtime referee.
 * @param {string} classes
 * @param {import('./index.js').Oracle} oracle
 * @returns {{ ok: boolean, dropped: string[] }}
 */
export function mergeFree(classes, oracle) {
	const conflict = findConflicts(classes, oracle);
	return conflict ? { ok: false, dropped: conflict.dropped } : { ok: true, dropped: [] };
}

/**
 * Throws when a class string has conflicting tokens, listing exactly which ones lose.
 * @param {string} classes
 * @param {import('./index.js').Oracle} oracle
 * @returns {void}
 */
export function assertMergeFree(classes, oracle) {
	const conflict = findConflicts(classes, oracle);

	if (conflict) {
		throw new Error(`classes are not merge-free: "${conflict.dropped.join(' ')}" would be dropped from "${classes}"`);
	}
}

/**
 * Cartesian product of variant axes: { size: ['sm', 'lg'] } becomes [{ size: 'sm' }, { size: 'lg' }].
 * @param {Record<string, readonly string[]>} axes
 * @returns {Record<string, string>[]}
 */
export function combos(axes) {
	const keys = Object.keys(axes);
	const n = keys.length;

	if (n === 0) return [{}];

	/** @type {Record<string, string>[]} */
	const out = [];
	/** @type {Record<string, string>} */
	const cur = {};

	/** @param {number} i */
	function walk(i) {
		if (i === n) {
			out.push({ ...cur });
			return;
		}

		const key = keys[i];
		const values = axes[key];

		for (let j = 0, l = values.length; j < l; j++) {
			cur[key] = values[j];
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
 * @template {(props?: any) => string} F
 * @param {F} variants
 * @param {Record<string, readonly string[]>} axes
 * @param {import('./index.js').Oracle} oracle
 * @returns {void}
 */
export function assertVariantsMergeFree(variants, axes, oracle) {
	const keys = Object.keys(axes);
	const n = keys.length;
	/** @type {Record<string, string>} */
	const cur = {};

	/** @param {number} i */
	function walk(i) {
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

		const key = keys[i];
		const values = axes[key];

		for (let j = 0, l = values.length; j < l; j++) {
			cur[key] = values[j];
			walk(i + 1);
		}
	}

	walk(0);
}
