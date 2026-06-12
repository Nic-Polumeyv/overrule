import { describe, expect, test } from 'bun:test';
import { mkdtempSync, cpSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { applyFixes, scanPaths, scanSource } from '../src/scan.js';

const FIXTURES = new URL('./fixtures', import.meta.url).pathname;

describe('scanSource', () => {
	test('finds conflicts in attributes and cn calls, skips clean and resolved strings', () => {
		const svelte = readFileSync(joinPath(FIXTURES, 'button.svelte'), 'utf8');
		const findings = scanSource(svelte);
		expect(findings.map((f) => f.dropped.join(' ')).sort()).toEqual(['h-9', 'px-4']);
	});
	test('tsx attributes, important stays silent, template literal without interpolation scanned', () => {
		const tsx = readFileSync(joinPath(FIXTURES, 'widget.tsx'), 'utf8');
		const findings = scanSource(tsx);
		expect(findings).toHaveLength(1);
		expect(findings[0].dropped).toEqual(['gap-2']);
	});
	test('template literals with interpolation are ignored', () => {
		expect(scanSource('cn(`h-9 h-8 ${extra}`)')).toHaveLength(0);
	});
	test('line numbers point at the literal', () => {
		const findings = scanSource('a\nb\n<div class="p-1 p-2">');
		expect(findings[0].line).toBe(3);
	});
});

describe('scanPaths + applyFixes', () => {
	test('fix rewrites to merged form and a second scan is clean', () => {
		const dir = mkdtempSync(joinPath(tmpdir(), 'overrule-'));
		cpSync(FIXTURES, dir, { recursive: true });
		const findings = scanPaths([dir]);
		expect(findings.length).toBe(3);
		const changed = applyFixes(findings);
		expect(changed).toBe(2);
		expect(scanPaths([dir])).toHaveLength(0);
		const fixedSvelte = readFileSync(joinPath(dir, 'button.svelte'), 'utf8');
		expect(fixedSvelte).toContain('flex h-8 items-center');
		expect(fixedSvelte).toContain('px-2 text-sm');
		expect(fixedSvelte).toContain('rounded-md border');
	});
});
