/**
 * Tokenizer for Tailwind class tokens. Structure only, no semantics: it
 * separates variants from the base utility and normalizes importance so an
 * oracle can decide what conflicts with what. It never guesses what a
 * utility means.
 */

export type Parsed = {
	/** The token as written. */
	raw: string;
	/** Variant prefixes in source order, e.g. ['md', 'hover'] or ['data-[state=open]']. */
	variants: string[];
	/**
	 * Canonical bucket key: variants order-normalized, importance included.
	 * Two tokens can only conflict when their buckets match.
	 */
	bucket: string;
	/** The utility itself, with arbitrary values and slash modifiers intact. */
	base: string;
	/** Trailing ! (the v4 position) or leading ! (the legacy position v4 still accepts). */
	important: boolean;
};

/**
 * Variant order matters only for pseudo-element-like variants: hover:before:
 * and before:hover: style different boxes, while hover:md: and md:hover: are
 * the same rule. This is CSS pseudo-element knowledge, not Tailwind version
 * knowledge, so it does not rot with releases. Arbitrary variants are treated
 * as order-sensitive too, because they can contain pseudo-element selectors
 * and structure alone cannot tell.
 */
const ORDER_SENSITIVE = new Set([
	'*',
	'**',
	'after',
	'backdrop',
	'before',
	'details-content',
	'file',
	'first-letter',
	'first-line',
	'marker',
	'placeholder',
	'selection',
]);

function isOrderSensitive(variant: string): boolean {
	return variant.startsWith('[') || ORDER_SENSITIVE.has(variant);
}

/** Split a token on top-level colons, ignoring colons inside [], (), and quotes. */
function splitTopLevel(token: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < token.length; i++) {
		const ch = token[i];
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === '[' || ch === '(') depth++;
		else if (ch === ']' || ch === ')') depth--;
		else if (ch === ':' && depth === 0) {
			parts.push(token.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(token.slice(start));
	return parts;
}

/**
 * Order-normalize variants into a bucket key. Variants commute only within
 * the stretch between order-sensitive ones: hover before a pseudo-element
 * reaches a different box than hover after it. So each stretch sorts on its
 * own and the order-sensitive variants pin the boundaries.
 */
export function bucketOf(variants: string[], important: boolean): string {
	const normalized: string[] = [];
	let segment: string[] = [];
	for (const variant of variants) {
		if (isOrderSensitive(variant)) {
			normalized.push(...segment.sort(), variant);
			segment = [];
		} else {
			segment.push(variant);
		}
	}
	normalized.push(...segment.sort());
	return normalized.join(':') + (important ? '!' : '');
}

export function parse(raw: string): Parsed {
	const parts = splitTopLevel(raw);
	const variants = parts.slice(0, -1);
	let base = parts[parts.length - 1];
	let important = false;
	if (base.endsWith('!')) {
		important = true;
		base = base.slice(0, -1);
	} else if (base.startsWith('!')) {
		important = true;
		base = base.slice(1);
	}
	return { raw, variants, bucket: bucketOf(variants, important), base, important };
}
