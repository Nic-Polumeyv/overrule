import { defaultOracle, type Oracle } from './oracle.js';

export { createTwMergeOracle, defaultOracle, type Oracle } from './oracle.js';
export { declareVariants, type VariantProps } from './variants.js';

export type ClassValue = ClassValue[] | Record<string, unknown> | string | number | bigint | null | boolean | undefined;

export type Conflict = {
	/** The full class string that was checked. */
	input: string;
	/** Tokens that tailwind-merge would drop, meaning the cascade decides instead of you. */
	dropped: string[];
};

/**
 * Plain class join with clsx-compatible inputs: strings, numbers, nested
 * arrays, and { class: condition } dictionaries. No merging, no conflict
 * resolution. Pair it with guard() in dev to keep it honest.
 */
export function join(...inputs: ClassValue[]): string {
	let out = '';
	for (let i = 0; i < inputs.length; i++) out = append(out, inputs[i]);
	return out;
}

// clsx's value gate: strings and numbers render; bigint, functions, and
// symbols are dropped even though bigint sits in the type (clsx carries the
// same types-vs-runtime quirk). Arrays recurse by index, so a huge flat array
// never hits the engine's argument-spread limit.
function append(out: string, input: ClassValue): string {
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
 * when nothing conflicts. The default oracle is tailwind-merge.
 */
export function findConflicts(classes: string, oracle: Oracle = defaultOracle): Conflict | null {
	const dropped = oracle(classes);
	return dropped.length > 0 ? { input: classes, dropped } : null;
}

const reported = new Set<string>();

function warnOnce(conflict: Conflict): void {
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
 *   const cn = import.meta.env.DEV ? guard(base) : base;
 *
 * Bundlers eliminate the guard (and tailwind-merge with it) from production.
 */
export function guard<F extends (...args: never[]) => string>(
	joinFn: F,
	onConflict: (conflict: Conflict) => void = warnOnce,
	oracle: Oracle = defaultOracle,
): F {
	const guarded = (...args: never[]): string => {
		const out = joinFn(...args);
		const conflict = findConflicts(out, oracle);
		if (conflict) onConflict(conflict);
		return out;
	};
	return guarded as F;
}
