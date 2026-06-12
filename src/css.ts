import type { Oracle } from './oracle.js';

export type { Oracle } from './oracle.js';

/**
 * A conflict oracle derived from the compiled stylesheet instead of name
 * tables. tailwind-merge classifies classes by what they are called; the
 * compiler knows what they do. Each candidate is fed through Tailwind v4's
 * design system and judged by the declarations it actually produces: a token
 * loses only when every declaration it makes is overridden by a later token
 * in the same variant bucket. Custom utilities are first class by
 * construction, and tokens that feed surviving var() references (leading-*
 * into text-*, ring-* into shadow-*) are composing, not losing.
 *
 * This module is platform-neutral on purpose, like the runtime API: no Node,
 * no filesystem, nothing but the design system you hand it. Load that design
 * system however your environment allows. On Node, `overrule/css/node` does
 * it for you; anywhere else, Tailwind's own `__unstable__loadDesignSystem`
 * from the `tailwindcss` package takes your stylesheet as text.
 */

type AstNode = {
	kind: string;
	selector?: string;
	name?: string;
	params?: string;
	property?: string;
	value?: string;
	important?: boolean;
	nodes?: AstNode[];
};

/**
 * The slice of Tailwind's design system the oracle needs: candidatesToAst,
 * available since tailwindcss 4.2.
 */
export type DesignSystemLike = { candidatesToAst(classes: string[]): AstNode[][] };

type Decl = {
	/** Variant bucket plus importance. Declarations only contest within a bucket. */
	bucket: string;
	property: string;
	value: string;
};

/** At-rules that register or define things rather than scope declarations. */
const NON_SCOPING = new Set(['@property', '@keyframes', '@font-face', '@counter-style']);

function unescape(selector: string): string {
	return selector.replace(/\\(.)/g, '$1');
}

type RawDecl = { conditions: string[]; property: string; value: string; important: boolean };

/** Flatten a candidate's AST into declarations tagged with their condition stack. */
function collect(nodes: AstNode[], conditions: string[], candidate: string, out: RawDecl[]): void {
	for (const node of nodes) {
		if (node.kind === 'declaration' && node.property !== undefined) {
			out.push({ conditions, property: node.property, value: node.value ?? '', important: node.important === true });
		} else if (node.kind === 'rule' && node.nodes) {
			const selector = node.selector ?? '';
			const next = unescape(selector) === `.${candidate}` ? conditions : [...conditions, selector];
			collect(node.nodes, next, candidate, out);
		} else if (node.kind === 'at-rule' && node.nodes) {
			if (NON_SCOPING.has(node.name ?? '')) continue;
			const next = node.name === '@layer' ? conditions : [...conditions, `${node.name} ${node.params ?? ''}`];
			collect(node.nodes, next, candidate, out);
		} else if (node.nodes) {
			collect(node.nodes, conditions, candidate, out);
		}
	}
}

/**
 * Conditions commute when they constrain the same element: media queries and
 * plain pseudo-class or attribute selectors on &. A condition that reaches a
 * different box (a pseudo-element, or any selector with a combinator) makes
 * everything nested inside it apply there, so its position pins the stretch
 * boundaries and each stretch sorts on its own. Same reasoning as bucketOf
 * in parse.ts, applied to compiled output.
 */
function bucketOf(conditions: string[], important: boolean): string {
	const sensitive = (condition: string) =>
		!condition.startsWith('@') && (condition.includes('::') || /[\s>+~]/.test(condition));
	const normalized: string[] = [];
	let segment: string[] = [];
	for (const condition of conditions) {
		if (sensitive(condition)) {
			normalized.push(...segment.sort(), condition);
			segment = [];
		} else {
			segment.push(condition);
		}
	}
	normalized.push(...segment.sort());
	return normalized.join(' ') + (important ? ' !' : '');
}

/**
 * CSS shorthand coverage: which properties a declaration overrides besides
 * the one it names. This is CSS knowledge, not Tailwind knowledge, so it
 * does not rot with releases. Scoped to what utilities plausibly emit;
 * extend it when dogfooding finds a gap.
 */
const COVERED_BY: Record<string, string[]> = {};
function covered(child: string, ...parents: string[]): void {
	COVERED_BY[child] = parents;
}
for (const box of ['padding', 'margin', 'scroll-padding', 'scroll-margin']) {
	for (const side of ['top', 'right', 'bottom', 'left', 'inline', 'block']) covered(`${box}-${side}`, box);
	for (const axis of ['inline', 'block']) {
		covered(`${box}-${axis}-start`, `${box}-${axis}`, box);
		covered(`${box}-${axis}-end`, `${box}-${axis}`, box);
	}
}
for (const side of ['top', 'right', 'bottom', 'left']) covered(side, 'inset');
for (const axis of ['inline', 'block']) {
	covered(`inset-${axis}`, 'inset');
	covered(`inset-${axis}-start`, `inset-${axis}`, 'inset');
	covered(`inset-${axis}-end`, `inset-${axis}`, 'inset');
}
for (const aspect of ['width', 'style', 'color']) covered(`border-${aspect}`, 'border');
for (const side of ['top', 'right', 'bottom', 'left', 'inline', 'block']) {
	covered(`border-${side}`, 'border');
	for (const aspect of ['width', 'style', 'color']) {
		covered(`border-${side}-${aspect}`, `border-${side}`, `border-${aspect}`, 'border');
	}
}
for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'start-start', 'start-end', 'end-start', 'end-end']) {
	covered(`border-${corner}-radius`, 'border-radius');
}
covered('row-gap', 'gap');
covered('column-gap', 'gap');
covered('container-name', 'container');
covered('container-type', 'container');
covered('overflow-x', 'overflow');
covered('overflow-y', 'overflow');
covered('overscroll-behavior-x', 'overscroll-behavior');
covered('overscroll-behavior-y', 'overscroll-behavior');
covered('flex-grow', 'flex');
covered('flex-shrink', 'flex');
covered('flex-basis', 'flex');
covered('flex-direction', 'flex-flow');
covered('flex-wrap', 'flex-flow');
for (const longhand of ['font-size', 'line-height', 'font-weight', 'font-family', 'font-style', 'font-stretch', 'font-variant']) {
	covered(longhand, 'font');
}
for (const aspect of ['width', 'style', 'color', 'offset']) covered(`outline-${aspect}`, 'outline');
for (const aspect of ['line', 'style', 'color', 'thickness']) covered(`text-decoration-${aspect}`, 'text-decoration');
covered('column-width', 'columns');
covered('column-count', 'columns');
covered('grid-row-start', 'grid-row', 'grid-area');
covered('grid-row-end', 'grid-row', 'grid-area');
covered('grid-column-start', 'grid-column', 'grid-area');
covered('grid-column-end', 'grid-column', 'grid-area');
covered('grid-row', 'grid-area');
covered('grid-column', 'grid-area');
for (const longhand of ['background-color', 'background-image', 'background-position', 'background-size', 'background-repeat', 'background-attachment', 'background-origin', 'background-clip']) {
	covered(longhand, 'background');
}
for (const longhand of ['transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior']) {
	covered(longhand, 'transition');
}
for (const longhand of ['animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'animation-direction', 'animation-fill-mode', 'animation-play-state']) {
	covered(longhand, 'animation');
}
for (const longhand of ['list-style-type', 'list-style-position', 'list-style-image']) covered(longhand, 'list-style');

/** Whether a later declaration of `winner` overrides an earlier one of `loser`. */
function overrides(winner: string, loser: string): boolean {
	if (winner === loser) return true;
	const parents = COVERED_BY[loser];
	return parents !== undefined && parents.includes(winner);
}

/** null means the compiler produced nothing: not a class in this project. */
function declsOf(candidate: string, roots: AstNode[]): Decl[] | null {
	if (roots.length === 0) return null;
	const raw: RawDecl[] = [];
	collect(roots, [], candidate, raw);
	return raw.map((decl) => ({
		bucket: bucketOf(decl.conditions, decl.important),
		property: decl.property,
		value: decl.value,
	}));
}

const VAR_RE = /var\(\s*(--[^\s,)]+)/g;

/**
 * Build an oracle from a loaded design system. Synchronous and cached per
 * token, so guard() and the test helpers use it unchanged.
 *
 * Tokens the compiler does not recognize produce no CSS and are skipped, not
 * reported. Surfacing them as typos is on the roadmap.
 */
export function cssOracle(designSystem: DesignSystemLike): Oracle {
	if (typeof designSystem?.candidatesToAst !== 'function') {
		throw new Error('cssOracle needs a design system with candidatesToAst, which tailwindcss exposes from 4.2 on.');
	}

	const cache = new Map<string, Decl[] | null>();

	return (classes) => {
		const raw = classes.split(/\s+/).filter(Boolean);
		const tokens = [...new Set(raw)];
		const position = new Map(tokens.map((token) => [token, raw.lastIndexOf(token)]));

		const missing = tokens.filter((token) => !cache.has(token));
		if (missing.length > 0) {
			const asts = designSystem.candidatesToAst(missing);
			missing.forEach((token, i) => cache.set(token, declsOf(token, asts[i] ?? [])));
		}
		const known = tokens.filter((token) => cache.get(token) != null);

		// A declaration is beaten when a later token declares the same or a
		// covering property in the same bucket. Importance is part of the
		// bucket, so important and normal declarations never contest.
		const beatenBy = new Map<string, boolean[]>();
		for (const token of known) {
			const flags = cache.get(token)!.map((decl) =>
				known.some(
					(other) =>
						position.get(other)! > position.get(token)! &&
						cache.get(other)!.some((own) => own.bucket === decl.bucket && overrides(own.property, decl.property)),
				),
			);
			beatenBy.set(token, flags);
		}

		// Custom properties that surviving declarations still read. A token
		// whose only surviving output is an unread --tw-* variable is dead
		// anyway; one that feeds a surviving var() is composing, not losing.
		const read = new Set<string>();
		for (const token of known) {
			cache.get(token)!.forEach((decl, i) => {
				if (beatenBy.get(token)![i]) return;
				for (const match of decl.value.matchAll(VAR_RE)) read.add(`${decl.bucket} ${match[1]}`);
			});
		}

		return known.filter((token) => {
			const decls = cache.get(token)!;
			if (decls.length === 0) return false;
			return decls.every((decl, i) => {
				if (beatenBy.get(token)![i]) return true;
				if (decl.property.startsWith('--tw-')) return !read.has(`${decl.bucket} ${decl.property}`);
				return false;
			});
		});
	};
}
