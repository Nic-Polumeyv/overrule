import { twMerge } from 'tailwind-merge';

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
	for (const input of inputs) {
		if (!input || input === true) continue;
		let part = '';
		if (typeof input === 'object') {
			if (Array.isArray(input)) part = join(...input);
			else for (const key in input) if (input[key]) part += (part ? ' ' : '') + key;
		} else {
			part = String(input);
		}
		if (part) out += (out ? ' ' : '') + part;
	}
	return out;
}

/**
 * Returns the tokens tailwind-merge would remove from a class string, or null
 * when merging changes nothing. Duplicate tokens are not conflicts.
 */
export function findConflicts(classes: string): Conflict | null {
	const kept = new Set(twMerge(classes).split(' '));
	const dropped = [...new Set(classes.split(/\s+/))].filter((token) => token && !kept.has(token));
	return dropped.length > 0 ? { input: classes, dropped } : null;
}

const reported = new Set<string>();

function warnOnce(conflict: Conflict): void {
	const signature = [...conflict.dropped].sort().join(' ');
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
export function guard<F extends (...args: never[]) => string>(joinFn: F, onConflict: (conflict: Conflict) => void = warnOnce): F {
	const guarded = (...args: never[]): string => {
		const out = joinFn(...args);
		const conflict = findConflicts(out);
		if (conflict) onConflict(conflict);
		return out;
	};
	return guarded as F;
}
