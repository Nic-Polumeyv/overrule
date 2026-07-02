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
 * Plain class join, clsx-compatible. No merging, no conflict resolution:
 * pair it with guard() in dev to keep it honest.
 *
 * @example
 * ```ts
 * join('flex', ['px-2', { 'font-bold': isBold }]); // 'flex px-2 font-bold'
 * ```
 */
export declare function join(...inputs: ClassValue[]): string;

/**
 * A conflict oracle takes a class string and returns the tokens that lose;
 * an empty array means every token survives. Implementations come from
 * overrule/map, never from here.
 */
export type Oracle = (classes: string) => string[];

/** One checked class string and the tokens an oracle would drop from it. */
export type Conflict = {
	/** The full class string that was checked. */
	input: string;
	/** Tokens the oracle would drop, meaning the cascade decides instead of you. */
	dropped: string[];
};

/**
 * Check one class string against an oracle.
 *
 * @returns The conflict with its losing tokens, or null when nothing conflicts.
 */
export declare function findConflicts(classes: string, oracle: Oracle): Conflict | null;

/**
 * Wrap a class join so every string it produces is checked. The output passes
 * through unchanged.
 *
 * @param onConflict Reporter for each conflict. Defaults to console.warn,
 * deduplicated per input and verdict pair.
 * @example
 * ```ts
 * import { join, guard } from 'overrule';
 * import { createMapOracle } from 'overrule/map';
 * import map from './conflicts.json';
 *
 * // conflicts.json comes from `overrule map`, so verdicts come from your own
 * // compiled stylesheet. The DEV branch keeps all of it out of production.
 * const cn = import.meta.env.DEV ? guard(join, createMapOracle(map)) : join;
 * ```
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
 * Compile a variants config into a function. No merging: keep base and
 * variants disjoint, and let assertVariantsMergeFree from overrule/test prove
 * it. The config is compiled once; mutating it afterwards is unsupported.
 *
 * @throws On unknown config keys such as compoundVariants, instead of
 * silently dropping styling.
 * @example
 * ```ts
 * const button = declareVariants({
 * 	base: 'inline-flex items-center',
 * 	variants: { size: { sm: 'h-8 px-2', lg: 'h-11 px-4' } },
 * 	defaultVariants: { size: 'sm' },
 * });
 * button();                              // 'inline-flex items-center h-8 px-2'
 * button({ size: 'lg', class: 'mt-2' }); // 'inline-flex items-center h-11 px-4 mt-2'
 * ```
 */
export declare function declareVariants<S extends VariantsSchema>(config: VariantsConfig<S>): VariantFn<S>;

/**
 * The axis props of a variants function, without class.
 *
 * @example
 * ```ts
 * type ButtonProps = VariantProps<typeof button>; // { size?: 'sm' | 'lg' | null }
 * ```
 */
export type VariantProps<T extends (props?: any) => string> = Omit<NonNullable<Parameters<T>[0]>, 'class'>;
