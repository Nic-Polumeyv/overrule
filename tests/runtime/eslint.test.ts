import { test, expect } from 'bun:test';
import { Linter } from 'eslint';

import type { ConflictMap } from '../../runtime/map-oracle.js';
import plugin from '../../runtime/eslint.js';

// The same hand-written stand-in shape as oracle-fixture.ts: enough tokens to
// contest realistically. border-grid is deliberately absent, the README case.
const map: ConflictMap = {
	version: 1,
	covers: {},
	tokens: {
		'p-2': [{ bucket: '', props: ['padding'] }],
		'p-4': [{ bucket: '', props: ['padding'] }],
		'sm:p-8': [{ bucket: 'sm', props: ['padding'] }],
		'h-8': [{ bucket: '', props: ['height'] }],
		'h-11': [{ bucket: '', props: ['height'] }],
		'text-sm': [{ bucket: '', props: ['font-size'] }],
		'text-lg': [{ bucket: '', props: ['font-size'] }],
		'border-red-500': [{ bucket: '', props: ['border-color'] }],
		flex: [{ bucket: '', props: ['display'] }],
	},
};

const linter = new Linter({ cwd: new URL('../..', import.meta.url).pathname });

const config = (options: unknown) => [
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
];

const lint = (code: string, options: unknown = { map }) =>
	linter.verify(code, config(options) as never, 'file.jsx');
const fix = (code: string, options: unknown = { map }) =>
	linter.verifyAndFix(code, config(options) as never, 'file.jsx');

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

test('a static expression container is judged, a dynamic one is not', () => {
	expect(lint('<div className={"p-2 p-4"} />')).toHaveLength(1);
	expect(lint('<div className={cond ? "p-2" : "p-4"} />')).toEqual([]);
});

test('unknown tokens are never flagged: the map has no evidence about them', () => {
	expect(lint('<div className="border-grid border-red-500" />')).toEqual([]);
});

test('different buckets never conflict', () => {
	expect(lint('<div className="p-2 sm:p-8" />')).toEqual([]);
});

test('the fix removes the loser from the attribute', () => {
	const result = fix('<div className="p-2 p-4" />');
	expect(result.fixed).toBe(true);
	expect(result.output).toBe('<div className="p-4" />');
});

test('exact duplicates judge from the last occurrence', () => {
	const result = fix('<div className="p-2 p-4 p-2" />');
	expect(result.output).toBe('<div className="p-2 p-2" />');
});

// ---- calls ----

test('an all-static call is judged as the joined string', () => {
	const messages = lint('const c = cn("p-2", "p-4");');
	expect(messages).toHaveLength(1);
	expect(messages[0].message).toContain('"p-2"');
});

test('fixing an all-static call drops the dead argument with its comma', () => {
	const result = fix('const c = cn("p-2", "p-4");');
	expect(result.output).toBe('const c = cn("p-4");');
});

test('mixed arguments are judged literal by literal', () => {
	const messages = lint('const c = cn("p-2 p-4", cond && "h-8 h-11");');
	expect(messages).toHaveLength(2);
	const result = fix('const c = cn("p-2 p-4", cond && "h-8 h-11");');
	expect(result.output).toBe('const c = cn("p-4", cond && "h-11");');
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

test('a member call judges by property name', () => {
	expect(lint('const c = ui.cn("p-2 p-4");')).toHaveLength(1);
});

test('the default function list mirrors the CLI scanner, cx included', () => {
	expect(lint('const c = cx("p-2 p-4");')).toHaveLength(1);
});

test('a generic member join stays quiet: separators are unknown tokens', () => {
	expect(lint('const s = parts.join(", ");')).toEqual([]);
});

test('a static template literal reports but is not rewritten', () => {
	const code = 'const c = cn(`p-2 p-4`);';
	expect(lint(code)).toHaveLength(1);
	const result = fix(code);
	expect(result.fixed).toBe(false);
	expect(result.output).toBe(code);
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

test('a missing map fails with the command that makes one', () => {
	expect(() => linter.verify('<div />', config(undefined).map((c) => ({ ...c, rules: { 'overrule/no-conflicts': 'error' } })) as never, 'file.jsx')).toThrow(
		/needs a map/,
	);
});

test('an unreadable map path fails with the command that makes one', () => {
	expect(() => lint('<div />', { map: 'does-not-exist.json' })).toThrow(/overrule map/);
});
