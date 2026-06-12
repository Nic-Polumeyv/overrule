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
  --json         machine output. Findings for check and fix, disagreements for cross.
  --ack <file>   cross only. A snapshot from cross --json listing acknowledged
                 disagreements; anything not in it prints and exits 1. This is how
                 cross becomes a CI gate instead of an investigation.

Inside GitHub Actions, check and cross also emit ::error annotations, so findings
land on the pull request diff.

Paths default to the current directory. node_modules, dist, and friends are skipped.

Conflicts between separate strings (a caller overriding a component) only exist
at runtime. Catch those with guard() from the overrule package.`;

const argv = process.argv.slice(2);
const command = argv[0];
const paths: string[] = [];
let cssEntry: string | undefined;
let wantsCss = false;
let json = false;
let ackFile: string | undefined;
for (let i = 1; i < argv.length; i++) {
	if (argv[i] === '--css') {
		wantsCss = true;
		cssEntry = argv[++i];
		if (cssEntry === undefined) {
			console.error('--css needs a file path.');
			process.exit(1);
		}
	} else if (argv[i] === '--json') {
		json = true;
	} else if (argv[i] === '--ack') {
		ackFile = argv[++i];
		if (ackFile === undefined) {
			console.error('--ack needs a file path.');
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
if (ackFile !== undefined && command !== 'cross') {
	console.error('--ack only means something to cross.');
	process.exit(1);
}

const inActions = process.env.GITHUB_ACTIONS === 'true';
const escapeData = (value: string) => value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProp = (value: string) => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
const annotate = (file: string, line: number, message: string) =>
	console.log(`::error file=${escapeProp(file)},line=${line},title=overrule::${escapeData(message)}`);

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
	const sorted = (dropped?: string[]) => [...(dropped ?? [])].sort().join(' ');
	const verdict = (dropped?: string[]) => (dropped?.length ? `drops ${dropped.join(' ')}` : 'drops nothing');
	let diffs = [...entries.values()].filter((entry) => sorted(entry.tables) !== sorted(entry.sheet));

	let acknowledged = 0;
	if (ackFile !== undefined) {
		const parsed: unknown = JSON.parse(readFileSync(ackFile, 'utf8'));
		const list = Array.isArray(parsed) ? parsed : ((parsed as { disagreements?: Entry[] }).disagreements ?? []);
		// The signature ignores file and line on purpose: an acknowledged
		// string stays acknowledged when it moves or gets copied.
		const signature = (entry: Entry) => `${entry.literal}\n${sorted(entry.tables)}\n${sorted(entry.sheet)}`;
		const known = new Set((list as Entry[]).map(signature));
		const fresh = diffs.filter((entry) => !known.has(signature(entry)));
		acknowledged = diffs.length - fresh.length;
		diffs = fresh;
	}

	if (json) {
		const disagreements = diffs.map(({ file, line, literal, tables: t, sheet: s }) => ({
			file,
			line,
			literal,
			tables: t ?? [],
			sheet: s ?? [],
		}));
		console.log(JSON.stringify({ disagreements }, null, '\t'));
		process.exit(ackFile !== undefined && diffs.length > 0 ? 1 : 0);
	}

	for (const entry of diffs) {
		console.log(`${entry.file}:${entry.line}`);
		console.log(`  in              "${entry.literal}"`);
		console.log(`  tailwind-merge  ${verdict(entry.tables)}`);
		console.log(`  stylesheet      ${verdict(entry.sheet)}`);
		if (inActions) {
			annotate(
				entry.file,
				entry.line,
				`oracles disagree on "${entry.literal}": tailwind-merge ${verdict(entry.tables)}, stylesheet ${verdict(entry.sheet)}`,
			);
		}
	}
	if (ackFile !== undefined) {
		console.log(
			diffs.length === 0
				? `overrule: no new disagreements, ${acknowledged} acknowledged.`
				: `\n${diffs.length} new ${diffs.length === 1 ? 'disagreement' : 'disagreements'}, ${acknowledged} acknowledged. Inspect each one, then refresh the snapshot with cross --json.`,
		);
		process.exit(diffs.length > 0 ? 1 : 0);
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

if (json) {
	if (command === 'fix') applyFixes(findings);
	console.log(
		JSON.stringify(
			{
				findings: findings.map(({ file, line, literal, dropped, fixed }) => ({ file, line, literal, dropped, fixed })),
				unknown: unknowns.map(({ file, line, literal, dropped }) => ({ file, line, literal, tokens: dropped })),
			},
			null,
			'\t',
		),
	);
	process.exit(command === 'check' && findings.length > 0 ? 1 : 0);
}

if (findings.length === 0) {
	console.log('overrule: no class conflicts found.');
} else {
	for (const finding of findings) {
		console.log(`${finding.file}:${finding.line}`);
		console.log(`  drops  ${finding.dropped.join(' ')}`);
		console.log(`  in     "${finding.literal}"`);
		console.log(`  keeps  "${finding.fixed}"`);
		if (inActions && command === 'check') {
			annotate(
				finding.file,
				finding.line,
				`"${finding.dropped.join(' ')}" conflicts in "${finding.literal}". The cascade decides which wins; "${finding.fixed}" is the resolved form.`,
			);
		}
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
