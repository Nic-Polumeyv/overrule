import { join, type ClassValue } from './index.js';

/**
 * Merge component prop objects into one: join class strings, merge style
 * objects, compose or chain same-named functions, and let the last value win
 * for everything else. The umbrella over join/mergeStyles/the function mergers.
 *
 * The class branch uses overrule's `join` (concatenate, never resolve), so
 * conflicting tokens are caught by guard()/the oracle, not silently merged away.
 *
 * mergeProps is platform-neutral by default: a merged `style` stays a JS style
 * object and no attribute is dropped, matching react-aria. Opt into framework
 * idioms (serialize style to a string, drop boolean attrs set to false, compose
 * DOM handlers) with options, or bake them into a merger via createMergeProps.
 * sveltePreset reproduces the bits-ui/Svelte behavior.
 */

type Props = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (...args: any[]) => unknown;

/** A JS-shaped style object: camelCase properties, `--custom` passthrough, vendor props PascalCased (WebkitBoxShadow). */
export type StyleObject = Record<string, string | number | null | undefined>;

export interface MergePropsOptions {
	/** 'string' serializes a merged `style` to CSS text (Svelte/HTML attribute idiom). Default 'object' keeps a style object (React-friendly). */
	styleAs?: 'object' | 'string';
	/** Keys whose merged value is exactly `false` are deleted. Works around frameworks that keep boolean attributes set to false (Svelte's hidden/disabled). */
	dropFalseAttrs?: readonly string[];
	/** Return true for a key whose two function values are DOM event handlers: they compose and short-circuit on event.defaultPrevented. Other same-named functions are chained (all called). Default: chain everything. */
	isEventHandler?: (key: string) => boolean;
}

// ---- function mergers ----

/** Combine functions into one that calls each with the same arguments, in order. Nullish entries are skipped. */
export function chain<Args extends unknown[]>(
	...callbacks: (((...args: Args) => void) | undefined | null)[]
): (...args: Args) => void {
	return (...args: Args): void => {
		for (const callback of callbacks) callback?.(...args);
	};
}

/**
 * Compose DOM event handlers into one. If an earlier handler calls
 * event.preventDefault(), the handlers after it are skipped. It reads only
 * event.defaultPrevented off the argument it is handed, so it touches no globals
 * and stays platform-neutral.
 */
export function composeEventHandlers<E extends { defaultPrevented?: boolean } = { defaultPrevented?: boolean }>(
	...handlers: (((event: E) => void) | undefined | null)[]
): (event: E) => void {
	return function (this: unknown, event: E): void {
		for (const handler of handlers) {
			if (!handler) continue;
			if (event && event.defaultPrevented) return;
			handler.call(this, event);
		}
	};
}

// ---- style helpers (dependency-free) ----

const STR_SPLITTERS = ['-', '_', '/', '.'];

function splitByCase(str: string): string[] {
	const parts: string[] = [];
	let buff = '';
	let prevUpper: boolean | undefined;

	for (const char of str) {
		if (STR_SPLITTERS.includes(char)) {
			if (buff) parts.push(buff);
			buff = '';
			prevUpper = undefined;
			continue;
		}

		const isUpper = char >= '0' && char <= '9' ? undefined : char !== char.toLowerCase();

		if (prevUpper === false && isUpper) {
			if (buff) parts.push(buff);
			buff = char;
		} else if (prevUpper === true && !isUpper && buff.length > 1) {
			parts.push(buff.slice(0, -1));
			buff = buff.slice(-1) + char;
		} else {
			buff += char;
		}

		prevUpper = isUpper;
	}

	if (buff) parts.push(buff);
	return parts;
}

function pascalCase(str: string): string {
	if (!str) return '';
	return splitByCase(str)
		.map((p) => p[0]!.toUpperCase() + p.slice(1))
		.join('');
}

function camelCase(str: string): string {
	const p = pascalCase(str);
	return p ? p[0]!.toLowerCase() + p.slice(1) : '';
}

function isVendorPrefixed(name: string): boolean {
	return name.startsWith('-webkit-') || name.startsWith('-moz-') || name.startsWith('-ms-') || name.startsWith('-o-');
}

/** Split a declaration list on top-level `;`, ignoring `;` inside parens or quotes (so url(...) and quoted values survive). */
function splitDeclarations(css: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let quote = '';
	let start = 0;

	for (let i = 0; i < css.length; i++) {
		const c = css[i]!;
		if (quote) {
			if (c === quote) quote = '';
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === '(') {
			depth++;
		} else if (c === ')') {
			if (depth > 0) depth--;
		} else if (c === ';' && depth === 0) {
			out.push(css.slice(start, i));
			start = i + 1;
		}
	}

	if (start < css.length) out.push(css.slice(start));
	return out;
}

/** Parse a CSS declaration string into a JS style object. Inverse of styleToString. */
export function styleToObject(css?: string | null): StyleObject {
	const out: StyleObject = {};
	if (!css) return out;

	for (const decl of splitDeclarations(css)) {
		const colon = decl.indexOf(':');
		if (colon === -1) continue;
		const name = decl.slice(0, colon).trim();
		if (!name) continue;
		const value = decl.slice(colon + 1).trim();

		if (name.startsWith('--')) out[name] = value;
		else if (isVendorPrefixed(name)) out[pascalCase(name)] = value;
		else out[camelCase(name)] = value;
	}

	return out;
}

/** Serialize a JS style object to CSS text. Inverse of styleToObject. Nullish values are skipped. */
export function styleToString(style: StyleObject): string {
	let out = '';
	for (const key in style) {
		const value = style[key];
		if (value == null) continue;
		const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
		out += `${out ? ' ' : ''}${prop}: ${value};`;
	}
	return out;
}

/** Merge style objects and/or CSS strings into one style object. Later values win. */
export function mergeStyles(...styles: (string | StyleObject | null | undefined)[]): StyleObject {
	let out: StyleObject = {};
	for (const style of styles) {
		const obj = typeof style === 'string' ? styleToObject(style) : style && typeof style === 'object' ? style : null;
		if (obj) out = { ...out, ...obj };
	}
	return out;
}

// ---- the umbrella ----

type TupleTypes<T> = { [P in keyof T]: T[P] } extends { [key: number]: infer V } ? NullToObject<V> : never;
type NullToObject<T> = T extends null | undefined ? Record<never, never> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never;

function returnFalse(): boolean {
	return false;
}

function mergePropsImpl(args: readonly (Props | null | undefined)[], options: MergePropsOptions): Props {
	const styleAs = options.styleAs ?? 'object';
	const isEventHandler = options.isEventHandler ?? returnFalse;
	const result: Props = { ...args[0] };

	for (let i = 1; i < args.length; i++) {
		const props = args[i];
		if (!props) continue;

		for (const key of Object.keys(props)) {
			const a = result[key];
			const b = props[key];

			if (typeof a === 'function' && typeof b === 'function') {
				result[key] = isEventHandler(key)
					? composeEventHandlers(a as AnyFn, b as AnyFn)
					: chain(a as AnyFn, b as AnyFn);
			} else if (key === 'class' || key === 'className') {
				result[key] = join(a as ClassValue, b as ClassValue);
			} else if (key === 'style') {
				result[key] = mergeStyles(a as string | StyleObject, b as string | StyleObject);
			} else {
				result[key] = b !== undefined ? b : a;
			}
		}

		// symbol keys (e.g. Svelte attachments): last defined value wins
		for (const key of Object.getOwnPropertySymbols(props)) {
			const b = (props as Record<symbol, unknown>)[key];
			if (b !== undefined) (result as Record<symbol, unknown>)[key] = b;
		}
	}

	if (styleAs === 'string' && result.style && typeof result.style === 'object') {
		result.style = styleToString(result.style as StyleObject);
	}

	const dropFalse = options.dropFalseAttrs;
	if (dropFalse) for (const key of dropFalse) if (result[key] === false) delete result[key];

	return result;
}

/** Build a mergeProps configured with the given options. Pass sveltePreset for bits-ui/Svelte semantics. */
export function createMergeProps(options: MergePropsOptions = {}) {
	return function mergeProps<T extends (Props | null | undefined)[]>(
		...args: T
	): UnionToIntersection<TupleTypes<T>> & { style?: string | StyleObject } {
		return mergePropsImpl(args, options) as UnionToIntersection<TupleTypes<T>> & { style?: string | StyleObject };
	};
}

/** Platform-neutral prop merger: a merged `style` stays an object, no attribute is dropped, same-named functions are chained. */
export const mergeProps = createMergeProps();

/**
 * Options reproducing Svelte/bits-ui prop-merging: a merged `style` is serialized
 * to a CSS string, `hidden`/`disabled` are dropped when set to false (Svelte keeps
 * them otherwise), and lowercase on* handlers (onclick) compose with preventDefault
 * while camelCase callbacks (onValueChange) are chained.
 */
export const sveltePreset: MergePropsOptions = {
	styleAs: 'string',
	dropFalseAttrs: ['hidden', 'disabled'],
	isEventHandler: (key) => key.length > 2 && key.startsWith('on') && key === key.toLowerCase(),
};
