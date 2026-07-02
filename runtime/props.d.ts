/**
 * Merge component prop objects into one: join class strings, merge style
 * objects, compose or chain same-named functions, and let the last value win
 * for everything else. The umbrella over join/mergeStyles/the function mergers.
 *
 * The class branch uses overrule's `join` (concatenate, never resolve), so
 * conflicting tokens are caught by guard()/the oracle, not silently merged away.
 *
 * `createMergeProps(options)` builds a merger. With no options it is platform-
 * neutral: a merged `style` stays a JS style object, no attribute is dropped,
 * and same-named functions are chained. Opt into framework idioms by passing options: serialize
 * style to a string (`styleAs: 'string'`), drop boolean attrs set to false
 * (`dropFalseAttrs`), compose DOM handlers (`isEventHandler`). Framework-specific
 * policy is the consumer's to assemble; overrule ships only the engine.
 */

// ---- the umbrella ----

type Props = Record<string, unknown>;

export interface MergePropsOptions {
	/** 'string' serializes a merged `style` to CSS text (Svelte/HTML attribute idiom). Default 'object' keeps a style object (React-friendly). */
	styleAs?: 'object' | 'string';
	/** Keys whose merged value is exactly `false` are deleted. Works around frameworks that keep boolean attributes set to false (Svelte's hidden/disabled). */
	dropFalseAttrs?: readonly string[];
	/** Return true for a key whose two function values are DOM event handlers: they compose and short-circuit on event.defaultPrevented. Other same-named functions are chained (all called). Default: chain everything. */
	isEventHandler?: (key: string) => boolean;
}

/**
 * Build a prop merger with the given options. With no options the merger is
 * platform-neutral: a merged `style` stays an object, no attribute is dropped,
 * and same-named functions are chained. Pass options to opt into framework
 * idioms (`styleAs`, `dropFalseAttrs`, `isEventHandler`).
 *
 * The return type tracks the options: `styleAs: 'string'` types the merged
 * `style` as a `string`, so the result spreads onto string-typed `style` props
 * with no cast. Pass options as a literal (or `as const`) so the inference holds.
 */
export declare function createMergeProps<const O extends MergePropsOptions = MergePropsOptions>(
	options?: O,
): MergeProps<O>;

/**
 * The merger createMergeProps returns. The result type intersects the inputs,
 * except `style`, which is replaced: its merged type comes from the options,
 * never from intersecting the inputs' own style types.
 */
export type MergeProps<O extends MergePropsOptions> = <T extends (Props | null | undefined)[]>(
	...args: T
) => Omit<UnionToIntersection<TupleTypes<T>>, 'style'> & { style?: MergedStyle<O> };

// Implementation of the MergeProps signature, not API: the input tuple folded
// to an intersection, nullish entries contributing nothing.
type TupleTypes<T> = { [P in keyof T]: T[P] } extends { [key: number]: infer V } ? NullToObject<V> : never;
type NullToObject<T> = T extends null | undefined ? Record<never, never> : T;
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

/** A merged `style` is a string when the options serialize it (`styleAs: 'string'`), otherwise a style object. */
type MergedStyle<O extends MergePropsOptions> = O extends { styleAs: 'string' } ? string : StyleObject;

// ---- style helpers ----

/** A JS-shaped style object: camelCase properties, `--custom` passthrough, vendor props PascalCased (WebkitBoxShadow). */
export type StyleObject = Record<string, string | number | null | undefined>;

/** Parse a CSS declaration string into a JS style object. Inverse of styleToString. */
export declare function styleToObject(css?: string | null): StyleObject;

/** Serialize a JS style object to CSS text. Inverse of styleToObject. Nullish values are skipped. */
export declare function styleToString(style: StyleObject): string;

/** Merge style objects and/or CSS strings into one style object. Later values win. */
export declare function mergeStyles(...styles: (string | StyleObject | null | undefined)[]): StyleObject;

// ---- function mergers ----

/** Combine functions into one that calls each with the same arguments, in order. Nullish entries are skipped. */
export declare function chain<Args extends unknown[]>(
	...callbacks: (((...args: Args) => void) | undefined | null)[]
): (...args: Args) => void;

/**
 * Compose DOM event handlers into one. If an earlier handler calls
 * event.preventDefault(), the handlers after it are skipped. It reads only
 * event.defaultPrevented off the argument it is handed, so it touches no globals
 * and stays platform-neutral.
 */
export declare function composeEventHandlers<E extends { defaultPrevented?: boolean } = { defaultPrevented?: boolean }>(
	...handlers: (((event: E) => void) | undefined | null)[]
): (event: E) => void;
