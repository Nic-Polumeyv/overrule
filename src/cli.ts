#!/usr/bin/env node
import { applyFixes, scanPaths } from './scan.js';

const USAGE = `overrule - catch Tailwind class conflicts before they ship

Usage:
  overrule check [paths...]   report class strings tailwind-merge would change (exit 1 if any)
  overrule fix [paths...]     rewrite conflicting literals to their merged form

Paths default to the current directory. node_modules, dist, and friends are skipped.

Conflicts between separate strings (a caller overriding a component) only exist
at runtime. Catch those with guard() from the overrule package.`;

const [command, ...rest] = process.argv.slice(2);
const paths = rest.length > 0 ? rest : ['.'];

if (command !== 'check' && command !== 'fix') {
	console.log(USAGE);
	process.exit(command ? 1 : 0);
}

const findings = scanPaths(paths);

if (findings.length === 0) {
	console.log('overrule: no class conflicts found.');
	process.exit(0);
}

for (const finding of findings) {
	console.log(`${finding.file}:${finding.line}`);
	console.log(`  drops  ${finding.dropped.join(' ')}`);
	console.log(`  in     "${finding.literal}"`);
	console.log(`  keeps  "${finding.fixed}"`);
}

if (command === 'check') {
	console.log(`\n${findings.length} conflicting class ${findings.length === 1 ? 'string' : 'strings'}. Run "overrule fix" to resolve them in source.`);
	process.exit(1);
}

const changed = applyFixes(findings);
console.log(`\nFixed ${findings.length} ${findings.length === 1 ? 'string' : 'strings'} across ${changed} ${changed === 1 ? 'file' : 'files'}.`);
