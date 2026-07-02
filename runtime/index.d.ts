/**
 * The overrule runtime, root entry: join builds class strings, guard referees
 * them in dev, declareVariants compiles variant configs. No oracle lives here;
 * the map-backed one is on overrule/map, so importing join pulls in nothing else.
 */

/**
 * Everything join() accepts: strings, numbers, nested arrays, and
 * { class: condition } dictionaries. bigint is here for clsx type parity;
 * the runtime drops it, exactly as clsx does.
 */
export type ClassValue = ClassValue[] | Record<string, unknown> | string | number | bigint | null | boolean | undefined;

/**
 * Plain class join with clsx-compatible inputs: strings, numbers, nested
 * arrays, and { class: condition } dictionaries. No merging, no conflict
 * resolution. Pair it with guard() in dev to keep it honest.
 */
export declare function join(...inputs: ClassValue[]): string;

/**
 * A conflict oracle takes a class string and returns the tokens that lose.
 * An empty array means no token conflicts with another. The implementation
 * lives on overrule/map; the root entry stays free of it so importing join
 * pulls in no oracle at all.
 */
export type Oracle = (classes: string) => string[];

/** What findConflicts reports when an oracle drops tokens. */
export type Conflict = {
	/** The full class string that was checked. */
	input: string;
	/** Tokens the oracle would drop, meaning the cascade decides instead of you. */
	dropped: string[];
};

/**
 * Returns the tokens the oracle considers losers in a class string, or null
 * when nothing conflicts.
 */
export declare function findConflicts(classes: string, oracle: Oracle): Conflict | null;

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
 * The default reporter is console.warn, deduplicated per input/verdict pair.
 */
export declare function guard<F extends (...args: never[]) => string>(
	joinFn: F,
	oracle: Oracle,
	onConflict?: (conflict: Conflict) => void,
): F;

/** Variant axes: axis name to a map of axis value to class string. */
export type VariantsSchema = Record<string, Record<string, string>>;

/** An axis keyed 'true'/'false' accepts real booleans, the way cva types it. */
type AxisValue<V> = V extends 'true' | 'false' ? boolean | V : V;

/**
 * What declareVariants compiles: an optional base class string, the variant
 * axes, and per-axis defaults. compoundVariants and slots are not supported.
 */
export type VariantsConfig<S extends VariantsSchema> = {
	base?: string;
	variants?: S;
	defaultVariants?: { [K in keyof S]?: AxisValue<keyof S[K]> | null };
};

/**
 * What declareVariants returns: axis selections in, class string out. An
 * undefined selection defers to the axis default, an explicit null clears
 * the axis. A trailing class is appended, never merged.
 */
export type VariantFn<S extends VariantsSchema> = (
	props?: { [K in keyof S]?: AxisValue<keyof S[K]> | null | undefined } & { class?: string },
) => string;

/**
 * Build a variants function from a config of class strings. No merging.
 *
 * The config is compiled once. Mutating base, variants, or defaultVariants
 * after declareVariants(...) is called is unsupported.
 */
export declare function declareVariants<S extends VariantsSchema>(config: VariantsConfig<S>): VariantFn<S>;

/** Pull the axis props out of a variants function, without class. Use with typeof yourVariants. */
export type VariantProps<T extends (props?: any) => string> = Omit<NonNullable<Parameters<T>[0]>, 'class'>;
