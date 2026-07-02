import type { Oracle } from './index.js';

/**
 * One compiled declaration group of a token. The bucket encodes the full
 * condition context (media queries, variants, pseudo pinning, importance)
 * as an opaque key; equality is its only operation, never parse it.
 */
export type DeclarationGroup = {
	bucket: string;
	/** CSS properties the group declares. Custom properties ("--x") count like any other. */
	props: readonly string[];
};

/**
 * The conflict map `overrule map` emits: every token in the project compiled
 * with the real stylesheet. `covers` lists shorthand relationships: a kept
 * declaration of property P also beats declarations of every property in
 * covers[P] within the same bucket.
 */
export type ConflictMap = {
	version: 1;
	covers: Record<string, readonly string[]>;
	tokens: Record<string, readonly DeclarationGroup[]>;
};

/**
 * An oracle judged by a conflict map instead of tailwind-merge's name tables,
 * so the verdicts come from the stylesheet that actually ships. Replays the
 * dead-token rule: processing right to left, a token is dropped only when it
 * declares something and every (bucket, prop) it declares is already claimed
 * by a kept token. Unknown tokens are never dropped and claim nothing; the
 * map has no evidence about them. Dropped tokens claim nothing either: their
 * declarations lost, so they beat nobody.
 */
export function createMapOracle(map: ConflictMap): Oracle {
	if (map.version !== 1) {
		throw new Error(
			`unsupported conflict map version ${JSON.stringify(map.version)}: this runtime reads version 1, regenerate with \`overrule map\``,
		);
	}
	const { covers, tokens } = map;

	return (classes) => {
		// Exact duplicates are one token: identical rules cannot beat themselves.
		// A repeated token judges from its LAST occurrence, the instance the
		// cascade actually reads, so "p-2 p-4 p-2" drops p-4.
		const raw = classes.split(/\s+/).filter((token) => token !== '');
		const last = new Map<string, number>();
		for (let i = 0; i < raw.length; i++) last.set(raw[i]!, i);
		const walk = [...last.keys()].sort((a, b) => last.get(a)! - last.get(b)!);
		// claimed: bucket -> properties won by kept tokens to the right.
		const claimed = new Map<string, Set<string>>();
		const dropped = new Set<string>();

		for (let i = walk.length - 1; i >= 0; i--) {
			const token = walk[i]!;
			// Object.hasOwn: the map is parsed JSON, so a token named "toString"
			// must not resolve through Object.prototype.
			const groups = Object.hasOwn(tokens, token) ? tokens[token]! : undefined;
			if (groups === undefined) continue;

			let declares = false;
			let beaten = true;
			for (const group of groups) {
				const won = claimed.get(group.bucket);
				for (const prop of group.props) {
					declares = true;
					if (!won?.has(prop)) beaten = false;
				}
			}

			if (declares && beaten) {
				dropped.add(token);
				continue;
			}

			for (const group of groups) {
				let won = claimed.get(group.bucket);
				if (won === undefined) claimed.set(group.bucket, (won = new Set()));
				for (const prop of group.props) {
					won.add(prop);
					if (Object.hasOwn(covers, prop)) for (const covered of covers[prop]!) won.add(covered);
				}
			}
		}

		// First-appearance order, not walk order: losers read in source order.
		return [...last.keys()].filter((token) => dropped.has(token));
	};
}
