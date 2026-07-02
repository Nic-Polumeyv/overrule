export type ClassValue = ClassValue[] | Record<string, unknown> | string | number | bigint | null | boolean | undefined;

/**
 * A conflict oracle takes a class string and returns the tokens that lose.
 * An empty array means no token conflicts with another. The implementation
 * lives on overrule/map; the root entry stays free of it so importing join
 * pulls in no oracle at all.
 */
export type Oracle = (classes: string) => string[];

export type Conflict = {
	/** The full class string that was checked. */
	input: string;
	/** Tokens the oracle would drop, meaning the cascade decides instead of you. */
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
 * when nothing conflicts.
 */
export function findConflicts(classes: string, oracle: Oracle): Conflict | null {
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
 *   import { join, guard } from 'overrule';
 *   import { createMapOracle } from 'overrule/map';
 *   import map from './conflicts.json';
 *   const cn = import.meta.env.DEV ? guard(join, createMapOracle(map)) : join;
 *
 * The map comes from `overrule map`, so the verdicts come from your own
 * compiled stylesheet. The dev-only branch keeps all of it out of production.
 */
export function guard<F extends (...args: never[]) => string>(
	joinFn: F,
	oracle: Oracle,
	onConflict: (conflict: Conflict) => void = warnOnce,
): F {
	const guarded = (...args: never[]): string => {
		const out = joinFn(...args);
		const conflict = findConflicts(out, oracle);
		if (conflict) onConflict(conflict);
		return out;
	};
	return guarded as F;
}

export type VariantsSchema = Record<string, Record<string, string>>;

/** An axis keyed 'true'/'false' accepts real booleans, the way cva types it. */
type AxisValue<V> = V extends 'true' | 'false' ? boolean | V : V;

export type VariantFn<S extends VariantsSchema> = (
	props?: { [K in keyof S]?: AxisValue<keyof S[K]> | null | undefined } & { class?: string },
) => string;

// Own-property lookup: a selection like 'toString' must select nothing, not
// walk the prototype chain and inject function source into the class string.
function pick(m: Record<string, string>, s: string | boolean): string | undefined {
	const k = typeof s === 'boolean' ? String(s) : s;
	return Object.hasOwn(m, k) ? m[k] : undefined;
}

/**
 * Build a variants function from a config of class strings. No merging.
 *
 * The config is compiled once. Mutating base, variants, or defaultVariants
 * after declareVariants(...) is called is unsupported.
 */
export function declareVariants<S extends VariantsSchema>(config: {
	base?: string;
	variants?: S;
	defaultVariants?: { [K in keyof S]?: AxisValue<keyof S[K]> | null };
}): VariantFn<S> {
	// Unsupported config fails loudly instead of silently dropping styling.
	// The type layer already rejects it; this catches untyped callers.
	for (const key in config) {
		if (key !== 'base' && key !== 'variants' && key !== 'defaultVariants') {
			throw new Error(`declareVariants: unknown config key "${key}"; compoundVariants and slots are not supported`);
		}
	}

	const b = config.base ?? '';
	const v = config.variants as Record<string, Record<string, string>> | undefined;

	if (v == null) {
		return (b
			? ((p?: { class?: string }) => (p?.class ? b + ' ' + p.class : b))
			: ((p?: { class?: string }) => p?.class ?? '')) as VariantFn<S>;
	}

	const d = (config.defaultVariants ?? {}) as Record<string, string | boolean | null | undefined>;
	const a = Object.keys(v);
	const n = a.length;
	const m = new Array<Record<string, string>>(n);
	const f = new Array<string | boolean | null | undefined>(n);

	for (let i = 0; i < n; i++) {
		const k = a[i]!;
		m[i] = v[k]!;
		f[i] = d[k];
	}

	let z = b;

	for (let i = 0; i < n; i++) {
		const s = f[i];
		const x = s == null ? undefined : pick(m[i]!, s);
		if (x) z += z ? ' ' + x : x;
	}

	return ((p?: Record<string, string | boolean | null | undefined> & { class?: string }) => {
		if (p == null) return z;

		let o = b;

		for (let i = 0; i < n; i++) {
			let s = p[a[i]!];
			s = s === undefined ? f[i] : s;

			if (s != null) {
				const x = pick(m[i]!, s);
				if (x) o += o ? ' ' + x : x;
			}
		}

		const c = p.class;
		return c ? (o ? o + ' ' + c : c) : o;
	}) as VariantFn<S>;
}

/** Pull the axis props out of a variants function, without class. Use with typeof yourVariants. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariantProps<T extends (props?: any) => string> = Omit<NonNullable<Parameters<T>[0]>, 'class'>;
