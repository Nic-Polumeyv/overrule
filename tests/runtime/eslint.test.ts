import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Linter } from 'eslint';

import type { ConflictMap } from '../../runtime/map-oracle.js';
import plugin, { DEFAULT_FUNCTIONS } from '../../runtime/eslint.js';
import { conflictMap } from './oracle-fixture.js';

// The shared fixture plus the two tokens only this suite contests. border-red-500
// stays paired with the absent border-grid, the README case.
const map: ConflictMap = {
	version: 1,
	covers: {},
	tokens: {
		...conflictMap.tokens,
		'sm:p-8': [{ bucket: 'sm', props: ['padding'] }],
		'border-red-500': [{ bucket: '', props: ['border-color'] }],
	},
};

const linter = new Linter({ cwd: new URL('../..', import.meta.url).pathname });

const config = (options: unknown) =>
	[
		{
			files: ['**/*.jsx'],
			plugins: { overrule: plugin },
			languageOptions: {
				ecmaVersion: 2022 as const,
				sourceType: 'module' as const,
				parserOptions: { ecmaFeatures: { jsx: true } },
			},
			rules: { 'overrule/no-conflicts': ['error', options] },
		},
	] as Linter.Config[];

const lint = (code: string, options: unknown = { map }) => linter.verify(code, config(options), 'file.jsx');
const fix = (code: string, options: unknown = { map }) => linter.verifyAndFix(code, config(options), 'file.jsx');

// ---- attributes ----

test('a clean class attribute passes', () => {
	expect(lint('<div className="p-2 h-8" />')).toEqual([]);
});

test('a conflicting attribute reports and names the loser', () => {
	const messages = lint('<div className="p-2 p-4" />');
	expect(messages).toHaveLength(1);
	expect(messages[0].message).toContain('"p-2"');
});

test('class counts like className', () => {
	expect(lint('<div class="text-sm text-lg" />')).toHaveLength(1);
});

test('expression containers are harvested, branch by branch', () => {
	expect(lint('<div className={"p-2 p-4"} />')).toHaveLength(1);
	expect(lint('<div className={cond ? "p-2 p-4" : "h-8"} />')).toHaveLength(1);
	expect(lint('<div className={cond ? "p-2" : "p-4"} />')).toEqual([]);
});

test('unknown tokens are never flagged: the map has no evidence about them', () => {
	expect(lint('<div className="border-grid border-red-500" />')).toEqual([]);
});

test('different buckets never conflict', () => {
	expect(lint('<div className="p-2 sm:p-8" />')).toEqual([]);
});

// ---- the fix is the without_losers rewrite ----

test('the fix removes the loser from the attribute', () => {
	const result = fix('<div className="p-2 p-4" />');
	expect(result.fixed).toBe(true);
	expect(result.output).toBe('<div className="p-4" />');
});

test('the fix collapses exact duplicates to their last occurrence, like `overrule fix`', () => {
	expect(fix('<div className="p-2 p-4 p-2" />').output).toBe('<div className="p-2" />');
	expect(fix('<div className="flex flex p-2 p-4" />').output).toBe('<div className="flex p-4" />');
});

// ---- calls: each literal judged alone, the CLI scanner model ----

test('single-token arguments are never candidates, matching `overrule check`', () => {
	expect(lint('const c = cn("p-2", "p-4");')).toEqual([]);
	expect(fix('const c = cn("p-2", "p-4");').output).toBe('const c = cn("p-2", "p-4");');
});

test('a conflicting literal in a call reports and fixes', () => {
	expect(lint('const c = cn("p-2 p-4");')).toHaveLength(1);
	expect(fix('const c = cn("p-2 p-4");').output).toBe('const c = cn("p-4");');
});

test('literals judge independently, dynamic wrappers and all', () => {
	const code = 'const c = cn("p-2 p-4", cond && "h-8 h-11");';
	expect(lint(code)).toHaveLength(2);
	expect(fix(code).output).toBe('const c = cn("p-4", cond && "h-11");');
});

test('branch-split literals are judged alone, never as one string', () => {
	expect(lint('const c = cn(cond ? "p-2" : "p-4");')).toEqual([]);
});

test('strings inside a variants config are harvested', () => {
	const messages = lint('const b = cva("flex", { variants: { size: { sm: "h-8 h-11" } } });');
	expect(messages).toHaveLength(1);
	const result = fix('const b = cva("flex", { variants: { size: { sm: "h-8 h-11" } } });');
	expect(result.output).toBe('const b = cva("flex", { variants: { size: { sm: "h-11" } } });');
});

test('a literal in a nested matched call is judged exactly once', () => {
	expect(lint('const c = cn("m-2", tv("p-2 p-4"));')).toHaveLength(1);
	expect(lint('<div className={cn("p-2 p-4")} />')).toHaveLength(1);
});

test('a member call judges by property name', () => {
	expect(lint('const c = ui.cn("p-2 p-4");')).toHaveLength(1);
});

test('a static template literal reports but is not rewritten', () => {
	const code = 'const c = cn(`p-2 p-4`);';
	expect(lint(code)).toHaveLength(1);
	const result = fix(code);
	expect(result.fixed).toBe(false);
	expect(result.output).toBe(code);
});

// ---- parity with the CLI scanner ----

test('DEFAULT_FUNCTIONS mirrors CALL_RE in src/scan.rs, same names, same order', () => {
	const rust = readFileSync(new URL('../../src/scan.rs', import.meta.url), 'utf8');
	const alternation = rust.match(/\(\?:([a-zA-Z|]+)\)\\s\*\\\(/);
	expect(alternation).not.toBeNull();
	expect([...DEFAULT_FUNCTIONS]).toEqual(alternation![1].split('|'));
});

// ---- options ----

test('attributes outside the list are ignored until opted in', () => {
	expect(lint('<div data-cls="p-2 p-4" />')).toEqual([]);
	expect(lint('<div data-cls="p-2 p-4" />', { map, attributes: ['data-cls'] })).toHaveLength(1);
});

test('functions outside the list are ignored until opted in', () => {
	expect(lint('const c = merge("p-2 p-4");')).toEqual([]);
	expect(lint('const c = merge("p-2 p-4");', { map, functions: ['merge'] })).toHaveLength(1);
});

test('a map path resolves from cwd and judges the same', () => {
	const messages = lint('<div className="p-2 p-4" />', { map: 'tests/fixtures/conflict-map.json' });
	expect(messages).toHaveLength(1);
});

// ---- failure modes name the rule and the fix ----

test('a missing map fails with the command that makes one', () => {
	const bare = config(undefined).map((c) => ({ ...c, rules: { 'overrule/no-conflicts': 'error' as const } }));
	expect(() => linter.verify('<div />', bare, 'file.jsx')).toThrow(/needs a map/);
});

test('an unreadable map path fails with the command that makes one', () => {
	expect(() => lint('<div />', { map: 'does-not-exist.json' })).toThrow(/overrule map/);
});

test('a wrong-version map names the rule and the version, object or file', () => {
	expect(() => lint('<div />', { map: { version: 2, covers: {}, tokens: {} } })).toThrow(
		/overrule\/no-conflicts.*version 2/,
	);
	expect(() => lint('<div />', { map: 'package.json' })).toThrow(/unsupported conflict map version/);
});
