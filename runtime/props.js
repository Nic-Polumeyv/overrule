// Types live in props.d.ts, the hand-written public reference; this file
// borrows them via import() so the two cannot use different shapes silently.
import { join } from './index.js';

/** @typedef {Record<string, unknown>} Props */
/** @typedef {(...args: any[]) => unknown} AnyFn */

// ---- function mergers ----

/**
 * Combine functions into one that calls each with the same arguments, in order. Nullish entries are skipped.
 * @template {unknown[]} Args
 * @param {...(((...args: Args) => void) | undefined | null)} callbacks
 * @returns {(...args: Args) => void}
 */
export function chain(...callbacks) {
	return (...args) => {
		for (const callback of callbacks) callback?.(...args);
	};
}

/**
 * Compose DOM event handlers into one. If an earlier handler calls
 * event.preventDefault(), the handlers after it are skipped. It reads only
 * event.defaultPrevented off the argument it is handed, so it touches no globals
 * and stays platform-neutral.
 * @template {{ defaultPrevented?: boolean }} [E={ defaultPrevented?: boolean }]
 * @param {...(((event: E) => void) | undefined | null)} handlers
 * @returns {(event: E) => void}
 */
export function composeEventHandlers(...handlers) {
	return (
		/**
		 * @this {unknown}
		 * @param {E} event
		 */
		function (event) {
			for (const handler of handlers) {
				if (!handler) continue;
				if (event && event.defaultPrevented) return;
				handler.call(this, event);
			}
		}
	);
}

// ---- style helpers (dependency-free) ----

const STR_SPLITTERS = ['-', '_', '/', '.'];

/**
 * @param {string} str
 * @returns {string[]}
 */
function splitByCase(str) {
	/** @type {string[]} */
	const parts = [];
	let buff = '';
	/** @type {boolean | undefined} */
	let prevUpper;

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

/**
 * @param {string} str
 * @returns {string}
 */
function pascalCase(str) {
	if (!str) return '';
	return splitByCase(str)
		.map((p) => p[0].toUpperCase() + p.slice(1))
		.join('');
}

/**
 * @param {string} str
 * @returns {string}
 */
function camelCase(str) {
	const p = pascalCase(str);
	return p ? p[0].toLowerCase() + p.slice(1) : '';
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isVendorPrefixed(name) {
	return name.startsWith('-webkit-') || name.startsWith('-moz-') || name.startsWith('-ms-') || name.startsWith('-o-');
}

// Property-name conversions are pure and the name universe is tiny (low
// hundreds), while parses/serializes recur per frame. Past the cap new names
// compute uncached; nothing is evicted.
const NAME_CACHE_MAX = 1000;
/** @type {Map<string, string>} */
const objectKeyCache = new Map();
/** @type {Map<string, string>} */
const cssPropCache = new Map();

/**
 * CSS declaration name to style-object key: `--` passthrough, allowlisted vendor PascalCase, else camelCase.
 * @param {string} name
 * @returns {string}
 */
function toObjectKey(name) {
	const hit = objectKeyCache.get(name);
	if (hit !== undefined) return hit;
	const key = name.startsWith('--') ? name : isVendorPrefixed(name) ? pascalCase(name) : camelCase(name);
	if (objectKeyCache.size < NAME_CACHE_MAX) objectKeyCache.set(name, key);
	return key;
}

/**
 * @param {string} m
 * @returns {string}
 */
function kebabChar(m) {
	return '-' + m.toLowerCase();
}

/**
 * Style-object key to CSS property name: `--` passthrough, else each ASCII uppercase becomes -lower.
 * @param {string} key
 * @returns {string}
 */
function toCssProp(key) {
	const hit = cssPropCache.get(key);
	if (hit !== undefined) return hit;
	const prop = key.startsWith('--') ? key : key.replace(/[A-Z]/g, kebabChar);
	if (cssPropCache.size < NAME_CACHE_MAX) cssPropCache.set(key, prop);
	return prop;
}

/**
 * Remove CSS block comments outside quoted strings. Comments behave like whitespace in declaration text.
 * @param {string} css
 * @returns {string}
 */
function stripComments(css) {
	// generated styles carry no comments: without '/*' the rebuild is identity
	if (!css.includes('/*')) return css;

	let out = '';
	let quote = '';

	for (let i = 0; i < css.length; i++) {
		const c = css[i];

		if (quote) {
			out += c;
			if (c === quote) quote = '';
			continue;
		}

		if (c === '"' || c === "'") {
			quote = c;
			out += c;
			continue;
		}

		if (c === '/' && css[i + 1] === '*') {
			if (out && !/\s$/.test(out)) out += ' ';
			i += 2;
			while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
			if (i < css.length) i++;
			if (out && !/\s$/.test(out)) out += ' ';
			continue;
		}

		out += c;
	}

	return out;
}

const QUOTE_OR_PAREN = /["'(]/;

/**
 * Split a declaration list on top-level `;`, ignoring `;` inside parens or quotes (so url(...) and quoted values survive).
 * @param {string} css
 * @returns {string[]}
 */
function splitDeclarations(css) {
	// no quotes or parens: every ';' is top-level; a stray ')' never changes depth
	if (!QUOTE_OR_PAREN.test(css)) {
		const parts = css.split(';');
		// the scanner never emits the empty segment after a trailing ';'
		if (parts[parts.length - 1] === '') parts.pop();
		return parts;
	}

	/** @type {string[]} */
	const out = [];
	let depth = 0;
	let quote = '';
	let start = 0;

	for (let i = 0; i < css.length; i++) {
		const c = css[i];
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

/**
 * Parse a CSS declaration string into a JS style object. Inverse of styleToString.
 * @param {string | null} [css]
 * @returns {import('./props.js').StyleObject}
 */
export function styleToObject(css) {
	/** @type {import('./props.js').StyleObject} */
	const out = {};
	if (!css) return out;

	for (const decl of splitDeclarations(stripComments(css))) {
		const colon = decl.indexOf(':');
		if (colon === -1) continue;
		const name = decl.slice(0, colon).trim();
		if (!name) continue;
		const value = decl.slice(colon + 1).trim();

		out[toObjectKey(name)] = value;
	}

	return out;
}

/**
 * Serialize a JS style object to CSS text. Inverse of styleToObject. Nullish values are skipped.
 * @param {import('./props.js').StyleObject} style
 * @returns {string}
 */
export function styleToString(style) {
	let out = '';
	for (const key in style) {
		const value = style[key];
		if (value == null) continue;
		out += `${out ? ' ' : ''}${toCssProp(key)}: ${value};`;
	}
	return out;
}

/**
 * Merge style objects and/or CSS strings into one style object. Later values win.
 * @param {...(string | import('./props.js').StyleObject | null | undefined)} styles
 * @returns {import('./props.js').StyleObject}
 */
export function mergeStyles(...styles) {
	/** @type {import('./props.js').StyleObject | undefined} */
	let out;
	for (const style of styles) {
		if (typeof style === 'string') {
			// parse output is fresh and plain (never an own __proto__ key): adopt or copy in place
			if (out === undefined) out = styleToObject(style);
			else Object.assign(out, styleToObject(style));
		} else if (style && typeof style === 'object') {
			// [[Set]] would route an own '__proto__' key to the prototype setter;
			// spread keeps it an own data key, so that shape stays on the old path
			if (Object.prototype.hasOwnProperty.call(style, '__proto__')) out = { ...out, ...style };
			else if (out === undefined) out = Object.assign({}, style);
			else Object.assign(out, style);
		}
	}
	return out ?? {};
}

// ---- the umbrella ----

/** @returns {boolean} */
function returnFalse() {
	return false;
}

/**
 * @param {readonly (Props | null | undefined)[]} args
 * @param {import('./props.js').MergePropsOptions} options
 * @returns {Props}
 */
function mergePropsImpl(args, options) {
	const styleAs = options.styleAs ?? 'object';
	const isEventHandler = options.isEventHandler ?? returnFalse;
	/** @type {Props} */
	const result = { ...args[0] };

	for (let i = 1; i < args.length; i++) {
		const props = args[i];
		if (!props) continue;

		for (const key of Object.keys(props)) {
			const a = result[key];
			const b = props[key];

			if (typeof a === 'function' && typeof b === 'function') {
				result[key] = isEventHandler(key)
					? composeEventHandlers(/** @type {AnyFn} */ (a), /** @type {AnyFn} */ (b))
					: chain(/** @type {AnyFn} */ (a), /** @type {AnyFn} */ (b));
			} else if (key === 'class' || key === 'className') {
				result[key] = join(
					/** @type {import('./index.js').ClassValue} */ (a),
					/** @type {import('./index.js').ClassValue} */ (b),
				);
			} else if (key === 'style') {
				result[key] = mergeStyles(
					/** @type {string | import('./props.js').StyleObject} */ (a),
					/** @type {string | import('./props.js').StyleObject} */ (b),
				);
			} else {
				result[key] = b !== undefined ? b : a;
			}
		}

		// symbol keys (e.g. Svelte attachments): last defined value wins
		for (const key of Object.getOwnPropertySymbols(props)) {
			const b = /** @type {Record<symbol, unknown>} */ (props)[key];
			if (b !== undefined) /** @type {Record<symbol, unknown>} */ (result)[key] = b;
		}
	}

	if (styleAs === 'string' && result.style && typeof result.style === 'object') {
		result.style = styleToString(/** @type {import('./props.js').StyleObject} */ (result.style));
	}

	const dropFalse = options.dropFalseAttrs;
	if (dropFalse) for (const key of dropFalse) if (result[key] === false) delete result[key];

	return result;
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
 * @template {import('./props.js').MergePropsOptions} [const O=import('./props.js').MergePropsOptions]
 * @param {O} [options]
 * @returns {import('./props.js').MergeProps<O>}
 */
export function createMergeProps(options = /** @type {O} */ ({})) {
	// style is replaced, not intersected: the merged style's type comes from
	// the options, never from intersecting the inputs' own style types.
	return /** @type {import('./props.js').MergeProps<O>} */ (
		/** @param {...(Props | null | undefined)} args */
		function mergeProps(...args) {
			return mergePropsImpl(args, options);
		}
	);
}
