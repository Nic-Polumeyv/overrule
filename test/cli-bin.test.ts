import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function run(args: string[], env: Record<string, string> = {}) {
	const proc = Bun.spawnSync(['bun', 'src/cli.ts', ...args], {
		cwd: ROOT,
		env: { ...process.env, GITHUB_ACTIONS: 'false', ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

describe('check --json', () => {
	test('machine output, same exit code', () => {
		const result = run(['check', '--json', 'test/fixtures']);
		expect(result.code).toBe(1);
		const data = JSON.parse(result.out);
		expect(data.findings).toHaveLength(3);
		expect(data.findings[0]).toHaveProperty('file');
		expect(data.findings[0]).toHaveProperty('fixed');
		expect(data.unknown).toEqual([]);
	});
});

describe('actions annotations', () => {
	test('check emits ::error lines under GITHUB_ACTIONS', () => {
		const result = run(['check', 'test/fixtures'], { GITHUB_ACTIONS: 'true' });
		expect(result.out).toContain('::error file=');
		expect(result.out).toContain('title=overrule');
	});
	test('no annotations outside GITHUB_ACTIONS', () => {
		const result = run(['check', 'test/fixtures']);
		expect(result.out).not.toContain('::error');
	});
});

describe('cross --ack', () => {
	test('a snapshot silences known disagreements, anything new exits 1', () => {
		const dir = mkdtempSync(joinPath(tmpdir(), 'overrule-cross-'));
		// The tables drop leading-snug after text-xs; the compiled CSS shows
		// they compose, so this literal is a permanent, correct disagreement.
		writeFileSync(joinPath(dir, 'demo.svelte'), '<div class="leading-snug text-xs">x</div>\n');

		const snapshot = run(['cross', dir, '--json']);
		expect(snapshot.code).toBe(0);
		const data = JSON.parse(snapshot.out);
		expect(data.disagreements).toHaveLength(1);
		expect(data.disagreements[0].tables).toEqual(['leading-snug']);
		expect(data.disagreements[0].sheet).toEqual([]);

		const ackPath = joinPath(dir, 'acks.json');
		writeFileSync(ackPath, snapshot.out);
		const gated = run(['cross', dir, '--ack', ackPath]);
		expect(gated.code).toBe(0);
		expect(gated.out).toContain('no new disagreements, 1 acknowledged');

		writeFileSync(ackPath, JSON.stringify({ disagreements: [] }));
		const fresh = run(['cross', dir, '--ack', ackPath]);
		expect(fresh.code).toBe(1);
		expect(fresh.out).toContain('leading-snug');
		expect(fresh.out).toContain('1 new disagreement');
	});

	test('--ack outside cross is an error', () => {
		const result = run(['check', '--ack', 'whatever.json', 'test/fixtures']);
		expect(result.code).toBe(1);
		expect(result.err).toContain('--ack only means something to cross');
	});
});
