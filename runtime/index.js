// Types live in index.d.ts, the hand-written public reference; this file
// borrows them via import() so the two cannot use different shapes silently.

/**
 * Plain class join with clsx-compatible inputs: strings, numbers, nested
 * arrays, and { class: condition } dictionaries. No merging, no conflict
 * resolution. Pair it with guard() in dev to keep it honest.
 * @param {...import('./index.js').ClassValue} inputs
 * @returns {string}
 */
export function join(...inputs) {
	let out = '';
	for (let i = 0; i < inputs.length; i++) out = append(out, inputs[i]);
	return out;
}

// clsx's value gate: strings and numbers render; bigint, functions, and
// symbols are dropped even though bigint sits in the type (clsx carries the
// same types-vs-runtime quirk). Arrays recurse by index, so a huge flat array
// never hits the engine's argument-spread limit.
/**
 * @param {string} out
 * @param {import('./index.js').ClassValue} input
 * @returns {string}
 */
function append(out, input) {
	if (!input || input === true) return out;

	if (typeof input === 'string' || typeof input === 'number') {
		return out ? out + ' ' + input : String(input);
	}

	if (typeof input !== 'object') return out;

	if (Array.isArray(input)) {
		for (let i = 0; i < input.length; i++) out = append(out, input[i]);
		return out;
	}

	for (const key in input) if (input[key]) out = out ? out + ' ' + key : key;
	return out;
}

/**
 * Returns the tokens the oracle considers losers in a class string, or null
 * when nothing conflicts.
 * @param {string} classes
 * @param {import('./index.js').Oracle} oracle
 * @returns {import('./index.js').Conflict | null}
 */
export function findConflicts(classes, oracle) {
	const dropped = oracle(classes);
	return dropped.length > 0 ? { input: classes, dropped } : null;
}

/** @type {Set<string>} */
const reported = new Set();

/** @param {import('./index.js').Conflict} conflict */
function warnOnce(conflict) {
	// The input is part of the signature: different class strings can drop the
	// same tokens, and each deserves its own warning.
	const signature = conflict.input + '\n' + [...conflict.dropped].sort().join(' ');
	if (reported.has(signature)) return;
	reported.add(signature);
	console.warn(
		`[overrule] "${conflict.dropped.join(' ')}" conflicts with other classes in "${conflict.input}". ` +
			'The cascade decides which wins. Make precedence explicit (trailing !) or remove the loser.',
	);
}

/**
 * Wraps a class join function and reports any class string whose tokens
 * conflict. The output passes through unchanged. Wire it up in dev only:
 *
 *   import { join, guard } from 'overrule';
 *   import { createMapOracle } from 'overrule/map';
 *   import map from './conflicts.json';
 *   const cn = import.meta.env.DEV ? guard(join, createMapOracle(map)) : join;
 *
 * The map comes from `overrule map`, so the verdicts come from your own
 * compiled stylesheet. The dev-only branch keeps all of it out of production.
 * @template {(...args: never[]) => string} F
 * @param {F} joinFn
 * @param {import('./index.js').Oracle} oracle
 * @param {(conflict: import('./index.js').Conflict) => void} [onConflict]
 * @returns {F}
 */
export function guard(joinFn, oracle, onConflict = warnOnce) {
	/** @type {(...args: never[]) => string} */
	const guarded = (...args) => {
		const out = joinFn(...args);
		const conflict = findConflicts(out, oracle);
		if (conflict) onConflict(conflict);
		return out;
	};
	return /** @type {F} */ (guarded);
}

// Own-property lookup: a selection like 'toString' must select nothing, not
// walk the prototype chain and inject function source into the class string.
/**
 * @param {Record<string, string>} m
 * @param {string | boolean} s
 * @returns {string | undefined}
 */
function pick(m, s) {
	const k = typeof s === 'boolean' ? String(s) : s;
	return Object.hasOwn(m, k) ? m[k] : undefined;
}

/**
 * Build a variants function from a config of class strings. No merging.
 *
 * The config is compiled once. Mutating base, variants, or defaultVariants
 * after declareVariants(...) is called is unsupported.
 * @template {import('./index.js').VariantsSchema} S
 * @param {import('./index.js').VariantsConfig<S>} config
 * @returns {import('./index.js').VariantFn<S>}
 */
export function declareVariants(config) {
	// Unsupported config fails loudly instead of silently dropping styling.
	// The type layer already rejects it; this catches untyped callers.
	for (const key in config) {
		if (key !== 'base' && key !== 'variants' && key !== 'defaultVariants') {
			throw new Error(`declareVariants: unknown config key "${key}"; compoundVariants and slots are not supported`);
		}
	}

	const b = config.base ?? '';
	const v = /** @type {Record<string, Record<string, string>> | undefined} */ (config.variants);

	if (v == null) {
		return /** @type {import('./index.js').VariantFn<S>} */ (
			b
				? (/** @type {{ class?: string } | undefined} */ p) => (p?.class ? b + ' ' + p.class : b)
				: (/** @type {{ class?: string } | undefined} */ p) => p?.class ?? ''
		);
	}

	const d = /** @type {Record<string, string | boolean | null | undefined>} */ (config.defaultVariants ?? {});
	const a = Object.keys(v);
	const n = a.length;
	/** @type {Record<string, string>[]} */
	const m = new Array(n);
	/** @type {(string | boolean | null | undefined)[]} */
	const f = new Array(n);

	for (let i = 0; i < n; i++) {
		const k = a[i];
		m[i] = v[k];
		f[i] = d[k];
	}

	let z = b;

	for (let i = 0; i < n; i++) {
		const s = f[i];
		const x = s == null ? undefined : pick(m[i], s);
		if (x) z += z ? ' ' + x : x;
	}

	return /** @type {import('./index.js').VariantFn<S>} */ (
		(/** @type {(Record<string, string | boolean | null | undefined> & { class?: string }) | undefined} */ p) => {
			if (p == null) return z;

			let o = b;

			for (let i = 0; i < n; i++) {
				let s = p[a[i]];
				s = s === undefined ? f[i] : s;

				if (s != null) {
					const x = pick(m[i], s);
					if (x) o += o ? ' ' + x : x;
				}
			}

			const c = p.class;
			return c ? (o ? o + ' ' + c : c) : o;
		}
	);
}
