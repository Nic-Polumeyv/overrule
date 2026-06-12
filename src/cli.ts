#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Oracle } from './index.js';
import { applyFixes, scanPaths, type Finding } from './scan.js';

const USAGE = `overrule - catch Tailwind class conflicts before they ship

Usage:
  overrule check [paths...]   report class strings with conflicting tokens (exit 1 if any)
  overrule fix [paths...]     rewrite conflicting literals, losers removed
  overrule cross [paths...]   report every string where tailwind-merge and your stylesheet disagree

Options:
  --css <file>   judge with your compiled stylesheet instead of tailwind-merge's tables.
                 Point it at the CSS entry that imports tailwindcss; your theme, custom
                 utilities, and prefix all count. Tokens that compile to nothing get
                 listed too. cross uses a bare tailwindcss import when --css is missing.

Paths default to the current directory. node_modules, dist, and friends are skipped.

Conflicts between separate strings (a caller overriding a component) only exist
at runtime. Catch those with guard() from the overrule package.`;

const argv = process.argv.slice(2);
const command = argv[0];
const paths: string[] = [];
let cssEntry: string | undefined;
let wantsCss = false;
for (let i = 1; i < argv.length; i++) {
	if (argv[i] === '--css') {
		wantsCss = true;
		cssEntry = argv[++i];
		if (cssEntry === undefined) {
			console.error('--css needs a file path.');
			process.exit(1);
		}
	} else {
		paths.push(argv[i]!);
	}
}
if (paths.length === 0) paths.push('.');

if (command !== 'check' && command !== 'fix' && command !== 'cross') {
	console.log(USAGE);
	process.exit(command ? 1 : 0);
}

let oracle: Oracle | undefined;
let typos: Oracle | undefined;

if (wantsCss || command === 'cross') {
	const [{ loadDesignSystem }, { cssOracle, typoOracle }] = await Promise.all([
		import('./css-node.js'),
		import('./css.js'),
	]);
	const designSystem = await loadDesignSystem(
		cssEntry ? { css: readFileSync(cssEntry, 'utf8'), base: dirname(resolve(cssEntry)) } : {},
	);
	oracle = cssOracle(designSystem);
	if (wantsCss) typos = typoOracle(designSystem);
}

if (command === 'cross') {
	const tables = scanPaths(paths);
	const sheet = scanPaths(paths, oracle);
	type Entry = { file: string; line: number; literal: string; tables?: string[]; sheet?: string[] };
	const entries = new Map<string, Entry>();
	const entryFor = (finding: Finding): Entry => {
		const key = `${finding.file}:${finding.start}`;
		let entry = entries.get(key);
		if (!entry) entries.set(key, (entry = { file: finding.file, line: finding.line, literal: finding.literal }));
		return entry;
	};
	for (const finding of tables) entryFor(finding).tables = finding.dropped;
	for (const finding of sheet) entryFor(finding).sheet = finding.dropped;
	const signature = (dropped?: string[]) => [...(dropped ?? [])].sort().join(' ');
	const verdict = (dropped?: string[]) => (dropped?.length ? `drops ${dropped.join(' ')}` : 'drops nothing');
	const diffs = [...entries.values()].filter((entry) => signature(entry.tables) !== signature(entry.sheet));
	for (const entry of diffs) {
		console.log(`${entry.file}:${entry.line}`);
		console.log(`  in              "${entry.literal}"`);
		console.log(`  tailwind-merge  ${verdict(entry.tables)}`);
		console.log(`  stylesheet      ${verdict(entry.sheet)}`);
	}
	console.log(
		diffs.length === 0
			? `overrule: both oracles agree across ${entries.size} conflicting ${entries.size === 1 ? 'string' : 'strings'}.`
			: `\n${diffs.length} ${diffs.length === 1 ? 'disagreement' : 'disagreements'}. Each one is a bug in overrule or a tailwind-merge misclassification worth reporting.`,
	);
	process.exit(0);
}

const findings = scanPaths(paths, oracle);
const unknowns = typos ? scanPaths(paths, typos) : [];

if (findings.length === 0) {
	console.log('overrule: no class conflicts found.');
} else {
	for (const finding of findings) {
		console.log(`${finding.file}:${finding.line}`);
		console.log(`  drops  ${finding.dropped.join(' ')}`);
		console.log(`  in     "${finding.literal}"`);
		console.log(`  keeps  "${finding.fixed}"`);
	}
}

if (unknowns.length > 0) {
	console.log('\nunknown classes, these compile to nothing:');
	for (const unknown of unknowns) {
		console.log(`${unknown.file}:${unknown.line}`);
		console.log(`  unknown  ${unknown.dropped.join(' ')}`);
		console.log(`  in       "${unknown.literal}"`);
	}
	console.log('Unknown classes do not fail the run: a typo, or a class Tailwind never sees.');
}

if (command === 'check') {
	if (findings.length === 0) process.exit(0);
	console.log(`\n${findings.length} conflicting class ${findings.length === 1 ? 'string' : 'strings'}. Run "overrule fix" to resolve them in source.`);
	process.exit(1);
}

if (findings.length === 0) process.exit(0);
const changed = applyFixes(findings);
console.log(`\nFixed ${findings.length} ${findings.length === 1 ? 'string' : 'strings'} across ${changed} ${changed === 1 ? 'file' : 'files'}.`);
