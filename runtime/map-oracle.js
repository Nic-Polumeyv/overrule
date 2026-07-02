// Types live in map-oracle.d.ts, the hand-written public reference; this file
// borrows them via import() so the two cannot use different shapes silently.

/**
 * An oracle judged by a conflict map instead of tailwind-merge's name tables,
 * so the verdicts come from the stylesheet that actually ships. Replays the
 * dead-token rule: processing right to left, a token is dropped only when it
 * declares something and every (bucket, prop) it declares is already claimed
 * by a kept token. Unknown tokens are never dropped and claim nothing; the
 * map has no evidence about them. Dropped tokens claim nothing either: their
 * declarations lost, so they beat nobody.
 * @param {import('./map-oracle.js').ConflictMap} map
 * @returns {import('./index.js').Oracle}
 */
export function createMapOracle(map) {
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
		/** @type {Map<string, number>} */
		const last = new Map();
		for (let i = 0; i < raw.length; i++) last.set(raw[i], i);
		const walk = [...last.keys()].sort(
			(a, b) => /** @type {number} */ (last.get(a)) - /** @type {number} */ (last.get(b)),
		);
		// claimed: bucket -> properties won by kept tokens to the right.
		/** @type {Map<string, Set<string>>} */
		const claimed = new Map();
		/** @type {Set<string>} */
		const dropped = new Set();

		for (let i = walk.length - 1; i >= 0; i--) {
			const token = walk[i];
			// Object.hasOwn: the map is parsed JSON, so a token named "toString"
			// must not resolve through Object.prototype.
			const groups = Object.hasOwn(tokens, token) ? tokens[token] : undefined;
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
					if (Object.hasOwn(covers, prop)) for (const covered of covers[prop]) won.add(covered);
				}
			}
		}

		// First-appearance order, not walk order: losers read in source order.
		return [...last.keys()].filter((token) => dropped.has(token));
	};
}
