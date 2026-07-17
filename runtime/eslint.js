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

// Mirrors CALL_RE in src/scan.rs, same names, same order; the two lists
// drifting apart is the exact bug class this tool exists to catch. Member
// calls match by property name because CALL_RE's \b matches `ui.cn(` too.
// Generic names like a stray `arr.join(', ')` are harmless on both sides:
// the oracle never drops tokens the map has no evidence about.
const DEFAULT_FUNCTIONS = ['cn', 'cx', 'clsx', 'tv', 'cva', 'join', 'declareVariants'];
const DEFAULT_ATTRIBUTES = ['class', 'className'];

// Oracle per resolved map path, invalidated by mtime: editor ESLint servers
// are long-lived, and a regenerated `overrule map` must take effect without
// a restart.
/** @type {Map<string, { mtime: number, oracle: import('./index.js').Oracle }>} */
const cache = new Map();

/** @param {string} path */
function oracleFromPath(path) {
	const mtime = statSync(path).mtimeMs;
	const hit = cache.get(path);
	if (hit !== undefined && hit.mtime === mtime) return hit.oracle;
	const oracle = createMapOracle(JSON.parse(readFileSync(path, 'utf8')));
	cache.set(path, { mtime, oracle });
	return oracle;
}

/**
 * @param {string | import('./map-oracle.js').ConflictMap} map
 * @param {string} cwd
 * @returns {import('./index.js').Oracle}
 */
function loadOracle(map, cwd) {
	if (typeof map !== 'string') return createMapOracle(map);
	const path = resolve(cwd, map);
	try {
		return oracleFromPath(path);
	} catch (error) {
		throw new Error(
			`overrule/no-conflicts: cannot read the conflict map at ${path}. ` +
				'Generate one with `overrule map src/ --css src/app.css --out conflicts.json`.',
			{ cause: error },
		);
	}
}

/**
 * The string a node is guaranteed to evaluate to, or null. Template literals
 * count only with zero expressions; a template with holes is judged by its
 * literal parts elsewhere, never as one string.
 * @param {AstNode} node
 * @returns {string | null}
 */
function staticString(node) {
	if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
	return null;
}

/**
 * Every static string node in a subtree, in source order. Walking past dynamic
 * expressions on purpose: `cond ? 'a' : 'b'` yields both branches, each judged
 * alone, exactly as the CLI scanner treats branch-split literals.
 * @param {unknown} node
 * @param {AstNode[]} out
 */
function collectStrings(node, out) {
	if (node === null || typeof node !== 'object') return;
	if (Array.isArray(node)) {
		for (const item of node) collectStrings(item, out);
		return;
	}
	const candidate = /** @type {AstNode} */ (node);
	if (typeof candidate.type !== 'string') return;
	if (staticString(candidate) !== null) {
		out.push(candidate);
		return;
	}
	for (const key in candidate) {
		if (key === 'parent' || key === 'loc' || key === 'range') continue;
		collectStrings(candidate[key], out);
	}
}

/**
 * Only a plain single-line literal is rewritten. A raw with backslashes means
 * escapes, where slicing text is not safe; class strings never need them.
 * @param {AstNode} node
 */
function fixableLiteral(node) {
	return node.type === 'Literal' && typeof node.value === 'string' && !node.raw.includes('\\');
}

/** @type {import('eslint').Rule.RuleModule} */
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
	create(untypedContext) {
		const context = /** @type {RuleContext} */ (/** @type {unknown} */ (untypedContext));
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
		// A literal is judged once. Traversal is outer-first, so a call harvests
		// its subtree before a nested call is visited; the nested visit skips.
		/** @type {Set<AstNode>} */
		const judged = new Set();

		/**
		 * Remove the dropped tokens from one literal. When every token goes, the
		 * argument goes with its comma; an empty string in a call is correct but
		 * reads like debris.
		 * @param {any} fixer
		 * @param {AstNode} node
		 * @param {string[]} dropped
		 */
		function removeDropped(fixer, node, dropped) {
			const inner = node.raw.slice(1, -1);
			const parts = inner.split(/(\s+)/);
			let out = '';
			for (let i = 0; i < parts.length; i++) {
				if (i % 2 === 0 && dropped.includes(parts[i])) {
					if (i + 1 < parts.length) i++;
					else out = out.replace(/\s+$/, '');
					continue;
				}
				out += parts[i];
			}
			if (out.trim() === '' && node.parent?.type === 'CallExpression' && node.parent.arguments.includes(node)) {
				const after = context.sourceCode.getTokenAfter(node);
				if (after?.value === ',') {
					// The comma's trailing spaces go too, or `cn('a', 'b')` fixes
					// to `cn( 'b')`.
					const text = context.sourceCode.getText();
					let end = after.range[1];
					while (text[end] === ' ') end++;
					return fixer.removeRange([node.range[0], end]);
				}
				const before = context.sourceCode.getTokenBefore(node);
				if (before?.value === ',') return fixer.removeRange([before.range[0], node.range[1]]);
				return fixer.remove(node);
			}
			return fixer.replaceText(node, node.raw[0] + out + node.raw[0]);
		}

		/**
		 * Judge one class string. fixNodes are the literals the string was read
		 * from; the fix rewrites exactly the ones carrying a losing token, and is
		 * offered only when all of them are plain literals.
		 * @param {string} input
		 * @param {AstNode} reportNode
		 * @param {AstNode[]} fixNodes
		 */
		function judge(input, reportNode, fixNodes) {
			const conflict = findConflicts(input, oracle);
			if (conflict === null) return;
			const targets = fixNodes.filter((node) => {
				const value = staticString(node);
				return value !== null && value.split(/\s+/).some((token) => conflict.dropped.includes(token));
			});
			/** @type {any} */
			const report = {
				node: reportNode,
				messageId: 'conflict',
				data: { dropped: conflict.dropped.join(' ') },
			};
			if (targets.length > 0 && targets.every(fixableLiteral)) {
				report.fix = (/** @type {any} */ fixer) => targets.map((node) => removeDropped(fixer, node, conflict.dropped));
			}
			context.report(report);
		}

		/** @param {AstNode} node */
		function judgeNode(node) {
			if (judged.has(node)) return;
			judged.add(node);
			const value = staticString(node);
			if (value !== null) judge(value, node, [node]);
		}

		return {
			/** @param {any} node */
			JSXAttribute(node) {
				if (node.name.type !== 'JSXIdentifier' || !attributes.has(node.name.name)) return;
				const value = node.value;
				if (value == null) return;
				if (value.type === 'Literal') judgeNode(value);
				else if (value.type === 'JSXExpressionContainer' && staticString(value.expression) !== null) {
					judgeNode(value.expression);
				}
			},
			/** @param {any} node */
			CallExpression(node) {
				const callee = node.callee;
				const name =
					callee.type === 'Identifier'
						? callee.name
						: callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
							? callee.property.name
							: null;
				if (name === null || !functions.has(name)) return;

				const args = /** @type {AstNode[]} */ (node.arguments);
				if (args.length > 0 && args.every((arg) => staticString(arg) !== null && !judged.has(arg))) {
					// All-static call: the joined string is exactly what join()
					// returns, so it is judged as one and cross-argument losers
					// surface too. Anything else falls back to literal-by-literal.
					for (const arg of args) judged.add(arg);
					judge(args.map((arg) => /** @type {string} */ (staticString(arg))).join(' '), node, args);
					return;
				}
				/** @type {AstNode[]} */
				const literals = [];
				collectStrings(args, literals);
				for (const literal of literals) judgeNode(literal);
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
