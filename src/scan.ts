import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join as joinPath } from 'node:path';
import { findConflicts, type Oracle } from './index.js';

const SCAN_EXTS = new Set(['.svelte', '.tsx', '.jsx', '.vue', '.astro', '.html', '.ts', '.js', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.svelte-kit', '.next', '.output', '.vercel']);

export type Finding = {
	file: string;
	line: number;
	/** The class string as written. */
	literal: string;
	/** Tokens the cascade may silently discard. */
	dropped: string[];
	/** The literal with the losers removed, used by fix. */
	fixed: string;
	/** Offsets of the literal's content within the file. */
	start: number;
	end: number;
};

export function* walk(root: string): Generator<string> {
	const stat = statSync(root);
	if (stat.isFile()) {
		if (SCAN_EXTS.has(extname(root))) yield root;
		return;
	}
	for (const entry of readdirSync(root)) {
		if (SKIP_DIRS.has(entry)) continue;
		const path = joinPath(root, entry);
		const entryStat = statSync(path);
		if (entryStat.isDirectory()) yield* walk(path);
		else if (SCAN_EXTS.has(extname(path))) yield path;
	}
}

type Literal = { content: string; start: number; end: number };

/**
 * The literal with losing tokens removed and exact duplicates collapsed into
 * their last occurrence. Same survivors tailwind-merge keeps, so the rewrite
 * cannot change a pixel; the test suite cross-checks this against twMerge.
 */
function withoutLosers(literal: string, dropped: string[]): string {
	const losers = new Set(dropped);
	const tokens = literal.split(/\s+/).filter(Boolean);
	const lastIndex = new Map<string, number>();
	tokens.forEach((token, index) => lastIndex.set(token, index));
	return tokens.filter((token, index) => !losers.has(token) && lastIndex.get(token) === index).join(' ');
}

const ATTR_RE = /\bclass(?:Name)?=(["'])([^"']+?)\1/g;
const CALL_RE = /\b(?:cn|cx|clsx|tv|cva)\s*\(/g;

/** Collect string literals inside a call's balanced parens, at any nesting depth. */
function literalsInCall(src: string, openParen: number): { literals: Literal[]; end: number } {
	const literals: Literal[] = [];
	let depth = 1;
	let i = openParen + 1;
	while (i < src.length && depth > 0) {
		const ch = src[i];
		if (ch === '(') depth++;
		else if (ch === ')') depth--;
		else if (ch === '"' || ch === "'" || ch === '`') {
			const quote = ch;
			const start = i + 1;
			i++;
			while (i < src.length && src[i] !== quote) {
				if (src[i] === '\\') i++;
				i++;
			}
			const content = src.slice(start, i);
			if (!(quote === '`' && content.includes('${'))) literals.push({ content, start, end: i });
		}
		i++;
	}
	return { literals, end: i };
}

export function scanSource(src: string, oracle?: Oracle): Omit<Finding, 'file'>[] {
	const literals: Literal[] = [];

	for (const match of src.matchAll(ATTR_RE)) {
		const start = match.index + match[0].indexOf(match[2], match[0].indexOf('=') + 1);
		literals.push({ content: match[2], start, end: start + match[2].length });
	}
	for (const match of src.matchAll(CALL_RE)) {
		const { literals: inCall } = literalsInCall(src, match.index + match[0].length - 1);
		literals.push(...inCall);
	}

	const seen = new Set<number>();
	const lineOf = (offset: number) => src.slice(0, offset).split('\n').length;
	const findings: Omit<Finding, 'file'>[] = [];
	for (const literal of literals) {
		if (seen.has(literal.start)) continue;
		seen.add(literal.start);
		if (!/\S\s+\S/.test(literal.content)) continue;
		const conflict = findConflicts(literal.content, oracle);
		if (!conflict) continue;
		findings.push({
			line: lineOf(literal.start),
			literal: literal.content,
			dropped: conflict.dropped,
			fixed: withoutLosers(literal.content, conflict.dropped),
			start: literal.start,
			end: literal.end,
		});
	}
	return findings;
}

export function scanPaths(paths: string[], oracle?: Oracle): Finding[] {
	const findings: Finding[] = [];
	for (const path of paths) {
		for (const file of walk(path)) {
			const src = readFileSync(file, 'utf8');
			for (const finding of scanSource(src, oracle)) findings.push({ file, ...finding });
		}
	}
	return findings;
}

/** Rewrite each conflicting literal to its merged form. Returns count of files changed. */
export function applyFixes(findings: Finding[]): number {
	const byFile = new Map<string, Finding[]>();
	for (const finding of findings) {
		const list = byFile.get(finding.file) ?? [];
		list.push(finding);
		byFile.set(finding.file, list);
	}
	for (const [file, list] of byFile) {
		let src = readFileSync(file, 'utf8');
		for (const finding of [...list].sort((a, b) => b.start - a.start)) {
			src = src.slice(0, finding.start) + finding.fixed + src.slice(finding.end);
		}
		writeFileSync(file, src);
	}
	return byFile.size;
}
