import type { ConflictMap } from './map-oracle.js';

/**
 * The overrule/eslint entry: a flat-config ESLint plugin with one rule,
 * no-conflicts. Verdicts come from the conflict map `overrule map` emits, so
 * the editor judges with the same compiled stylesheet as CI. Every static
 * literal is judged alone, the CLI scanner's model exactly; the fix is the
 * same rewrite `overrule fix` performs, losing tokens removed and exact
 * duplicates collapsed. Cross-argument conflicts are the runtime guard's
 * domain.
 */

/**
 * The call names judged by default, mirroring the CLI scanner. Spread it to
 * extend instead of replace: `functions: [...DEFAULT_FUNCTIONS, 'twMerge']`.
 */
export declare const DEFAULT_FUNCTIONS: readonly string[];

/** Options for the no-conflicts rule. `map` is required. */
export type NoConflictsOptions = {
	/**
	 * The conflict map: a path to the file `overrule map` emits, resolved from
	 * ESLint's cwd, or the parsed map itself.
	 */
	map: string | ConflictMap;
	/**
	 * Call expressions whose string arguments are judged, by callee name.
	 * Default: DEFAULT_FUNCTIONS.
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
