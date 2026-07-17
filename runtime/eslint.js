// Types live in eslint.d.ts, the hand-written public reference. The d.ts stays
// structurally loose on purpose: typing against eslint's Rule.RuleModule would
// make eslint's types load-bearing for everyone who imports this package. The
// local typedefs below are the honest internal shapes.

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { findConflicts } from './index.js';
import { createMapOracle } from './map-oracle.js';

/**
 * ESTree plus JSX, held loosely: the rule reads a handful of well-known keys
 * and never mutates. Tight AST types would drag in a parser's type package.
 * @typedef {Record<string, any> & { type: string }} AstNode
 */

/**
 * The slice of ESLint's RuleContext the rule actually uses.
 * @typedef {{ options: any[], cwd?: string, sourceCode: any, report: (descriptor: any) => void }} RuleContext
 */

/**
 * Mirrors CALL_RE in src/scan.rs, same names, same order; a test greps the
 * Rust source and fails if the two lists drift. Member calls match by
 * property name because CALL_RE's \b matches `ui.cn(` too. Generic names like
 * a stray `arr.join(', ')` are harmless on both sides: the oracle never drops
 * tokens the map has no evidence about.
 */
export const DEFAULT_FUNCTIONS = ['cn', 'cx', 'clsx', 'tv', 'cva', 'join', 'declareVariants'];
const DEFAULT_ATTRIBUTES = ['class', 'className'];

// Oracle per resolved map path, invalidated by mtime plus size: editor ESLint
// servers are long-lived, and a regenerated `overrule map` must take effect
// without a restart. Size is in the key because a rewrite can land inside the
// filesystem's mtime granularity.
/** @type {Map<string, { mtime: number, size: number, oracle: import('./index.js').Oracle }>} */
const cache = new Map();

/** @param {unknown} error */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * @param {string | import('./map-oracle.js').ConflictMap} map
 * @param {string} cwd
 * @returns {import('./index.js').Oracle}
 */
function loadOracle(map, cwd) {
	if (typeof map !== 'string') {
		try {
			return createMapOracle(map);
		} catch (error) {
			// The version error names the fix already; the prefix names the rule
			// that threw it, which a multi-plugin flat config otherwise hides.
			throw new Error(`overrule/no-conflicts: ${message(error)}`, { cause: error });
		}
	}
	const path = resolve(cwd, map);
	let stat;
	try {
		stat = statSync(path);
	} catch (error) {
		throw new Error(
			`overrule/no-conflicts: cannot read the conflict map at ${path}. ` +
				'Generate one with `overrule map src/ --css src/app.css --out conflicts.json`.',
			{ cause: error },
		);
	}
	const hit = cache.get(path);
	if (hit !== undefined && hit.mtime === stat.mtimeMs && hit.size === stat.size) return hit.oracle;
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		// A read or parse failure with a cached oracle is `overrule map`
		// rewriting the file mid-lint; keep judging with the previous map and
		// the next lint re-reads. With no cache there is nothing to fall back to.
		if (hit !== undefined) return hit.oracle;
		throw new Error(`overrule/no-conflicts: the conflict map at ${path} did not parse: ${message(error)}`, {
			cause: error,
		});
	}
	let oracle;
	try {
		oracle = createMapOracle(parsed);
	} catch (error) {
		throw new Error(`overrule/no-conflicts: the conflict map at ${path}: ${message(error)}`, { cause: error });
	}
	cache.set(path, { mtime: stat.mtimeMs, size: stat.size, oracle });
	return oracle;
}

/**
 * The string a node is guaranteed to evaluate to, or null. Template literals
 * count only with zero expressions; a template with holes is judged by its
 * literal parts, never as one string.
 * @param {AstNode} node
 * @returns {string | null}
 */
function staticString(node) {
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
	return null;
}

/**
 * Every static string node in a subtree, in source order, stopping at nodes
 * the skip predicate claims. Walking past dynamic expressions on purpose:
 * `cond ? 'a' : 'b'` yields both branches, each judged alone, exactly as the
 * CLI scanner treats branch-split literals.
 * @param {unknown} node
 * @param {AstNode[]} out
 * @param {(node: AstNode) => boolean} skip
 */
function collectStrings(node, out, skip) {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) collectStrings(item, out, skip);
		return;
	}
	const candidate = /** @type {AstNode} */ (node);
	if (typeof candidate.type !== 'string' || skip(candidate)) return;
	if (staticString(candidate) !== null) {
		out.push(candidate);
		return;
	}
	for (const key in candidate) {
		if (key === 'parent' || key === 'loc' || key === 'range') continue;
		collectStrings(candidate[key], out, skip);
	}
}

/**
 * The literal with losing tokens removed and exact duplicates collapsed into
 * their last occurrence. A direct port of without_losers in src/scan.rs, so
 * this fix and `overrule fix` emit the same bytes for the same literal.
 * @param {string} literal
 * @param {string[]} dropped
 */
function withoutLosers(literal, dropped) {
	const tokens = literal.split(/\s+/).filter((token) => token !== '');
	/** @type {Map<string, number>} */
	const last = new Map();
	tokens.forEach((token, index) => last.set(token, index));
	return tokens.filter((token, index) => !dropped.includes(token) && last.get(token) === index).join(' ');
}

/**
 * Only a plain literal is rewritten. A raw with backslashes means escapes,
 * where re-quoting sliced text is not safe; class strings never need them.
 * @param {AstNode} node
 */
function fixableLiteral(node) {
	return node.type === 'Literal' && typeof node.value === 'string' && !node.raw.includes('\\');
}

const noConflicts = {
	meta: {
		type: 'problem',
		fixable: 'code',
		docs: {
			description: 'class strings must be merge-free: no token beaten by the rest of its string',
			url: 'https://github.com/Nic-Polumeyv/overrule#eslint',
		},
		messages: {
			conflict:
				'"{{dropped}}" conflicts with other classes here. The cascade decides which wins. ' +
				'Make precedence explicit (trailing !) or remove the loser.',
		},
		schema: [
			{
				type: 'object',
				properties: {
					map: { anyOf: [{ type: 'string' }, { type: 'object' }] },
					functions: { type: 'array', items: { type: 'string' }, uniqueItems: true },
					attributes: { type: 'array', items: { type: 'string' }, uniqueItems: true },
				},
				required: ['map'],
				additionalProperties: false,
			},
		],
	},
	/** @param {RuleContext} context */
	create(context) {
		// The schema cannot demand an options object that was never passed, so a
		// bare 'error' severity lands here; fail with the fix, not a TypeError.
		const options = context.options[0];
		if (options?.map == null) {
			throw new Error(
				"overrule/no-conflicts needs a map: { map: './conflicts.json' }, the file `overrule map` emits.",
			);
		}
		const oracle = loadOracle(options.map, context.cwd ?? process.cwd());
		const functions = new Set(options.functions ?? DEFAULT_FUNCTIONS);
		const attributes = new Set(options.attributes ?? DEFAULT_ATTRIBUTES);

		/** @param {AstNode} node */
		function matchedCall(node) {
			if (node.type !== 'CallExpression') return false;
			const callee = node.callee;
			const name =
				callee.type === 'Identifier'
					? callee.name
					: callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
						? callee.property.name
						: null;
			return name !== null && functions.has(name);
		}

		/**
		 * Judge one literal alone, the CLI scanner's model exactly: single-token
		 * literals are never candidates, and the fix is the without_losers
		 * rewrite. Cross-argument conflicts are the runtime guard's domain.
		 * @param {AstNode} node
		 */
		function judgeNode(node) {
			const value = staticString(node);
			if (value === null) return;
			const tokens = value.split(/\s+/).filter((token) => token !== '');
			if (tokens.length < 2) return;
			const conflict = findConflicts(value, oracle);
			if (conflict === null) return;
			/** @type {any} */
			const report = {
				node,
				messageId: 'conflict',
				data: { dropped: conflict.dropped.join(' ') },
			};
			if (fixableLiteral(node)) {
				report.fix = (/** @type {any} */ fixer) =>
					fixer.replaceText(node, node.raw[0] + withoutLosers(value, conflict.dropped) + node.raw[0]);
			}
			context.report(report);
		}

		/** @param {unknown} root */
		function harvest(root) {
			/** @type {AstNode[]} */
			const literals = [];
			// Nested matched calls are skipped: their own visit judges them, so
			// no literal is walked or reported twice.
			collectStrings(root, literals, matchedCall);
			for (const literal of literals) judgeNode(literal);
		}

		return {
			/** @param {any} node */
			JSXAttribute(node) {
				if (node.name.type !== 'JSXIdentifier' || !attributes.has(node.name.name)) return;
				const value = node.value;
				if (value == null) return;
				if (value.type === 'Literal') judgeNode(value);
				else if (value.type === 'JSXExpressionContainer') harvest(value.expression);
			},
			/** @param {any} node */
			CallExpression(node) {
				if (matchedCall(node)) harvest(node.arguments);
			},
		};
	},
};

/**
 * The flat-config plugin. One rule, no bundled config: the map path is
 * project-specific, so there is nothing meaningful to preconfigure.
 */
const plugin = {
	meta: { name: 'overrule' },
	rules: { 'no-conflicts': noConflicts },
};

export default plugin;
