import type { ConflictMap } from './map-oracle.js';

/**
 * The overrule/eslint entry: a flat-config ESLint plugin with one rule,
 * no-conflicts. Verdicts come from the conflict map `overrule map` emits, so
 * the editor judges with the same compiled stylesheet as CI. The fix removes
 * the losing tokens, the same rewrite `overrule fix` performs.
 */

/** Options for the no-conflicts rule. `map` is required. */
export type NoConflictsOptions = {
	/**
	 * The conflict map: a path to the file `overrule map` emits, resolved from
	 * ESLint's cwd, or the parsed map itself.
	 */
	map: string | ConflictMap;
	/**
	 * Call expressions whose string arguments are judged, by callee name.
	 * Default: cn, clsx, join, cva, tv, declareVariants.
	 */
	functions?: readonly string[];
	/** JSX attributes whose values are judged. Default: class, className. */
	attributes?: readonly string[];
};

/**
 * Deliberately structural, not eslint's Rule.RuleModule: naming that type here
 * would make eslint's type package load-bearing for every consumer of this
 * package. The shape satisfies flat config's plugins field as-is.
 */
declare const plugin: {
	meta: { name: 'overrule' };
	rules: {
		'no-conflicts': {
			meta: Record<string, unknown>;
			create: (context: any) => any;
		};
	};
};

export default plugin;
