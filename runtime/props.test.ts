import { test, expect } from 'bun:test';

import {
	mergeProps,
	createMergeProps,
	sveltePreset,
	chain,
	composeEventHandlers,
	mergeStyles,
	styleToObject,
	styleToString,
} from './props.js';

// ---- chain ----

test('chain calls every callback in order with the same args', () => {
	const calls: string[] = [];
	const fn = chain(
		(x: string) => calls.push('a:' + x),
		undefined,
		(x: string) => calls.push('b:' + x),
	);
	fn('hi');
	expect(calls).toEqual(['a:hi', 'b:hi']);
});

// ---- composeEventHandlers ----

test('composeEventHandlers stops once a handler prevents default', () => {
	const calls: string[] = [];
	const event = {
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	};
	const handler = composeEventHandlers<typeof event>(
		(e) => {
			calls.push('first');
			e.preventDefault();
		},
		() => calls.push('second'),
	);
	handler(event);
	expect(calls).toEqual(['first']);
});

test('composeEventHandlers runs all handlers when nothing prevents default', () => {
	const calls: string[] = [];
	const handler = composeEventHandlers<{ defaultPrevented?: boolean }>(
		() => calls.push('first'),
		() => calls.push('second'),
	);
	handler({ defaultPrevented: false });
	expect(calls).toEqual(['first', 'second']);
});

// ---- style helpers ----

test('styleToObject parses customs, vendor prefixes, and values with semicolons', () => {
	expect(styleToObject('background: url(a;b); --x: 1px; -webkit-box-shadow: 0 0 red')).toEqual({
		background: 'url(a;b)',
		'--x': '1px',
		WebkitBoxShadow: '0 0 red',
	});
});

test('styleToString hyphenates camelCase, leaves customs, and skips nullish', () => {
	expect(
		styleToString({ backgroundColor: 'red', '--x': '1px', WebkitBoxShadow: '0 0', color: undefined }),
	).toBe('background-color: red; --x: 1px; -webkit-box-shadow: 0 0;');
});

test('styleToString and styleToObject round-trip', () => {
	const css = 'margin-top: 4px; --gap: 8px; -webkit-transform: scale(2);';
	expect(styleToString(styleToObject(css))).toBe('margin-top: 4px; --gap: 8px; -webkit-transform: scale(2);');
});

test('mergeStyles merges strings and objects with later values winning', () => {
	expect(mergeStyles('color: red; margin: 0', { color: 'blue' }, null)).toEqual({ color: 'blue', margin: '0' });
});

// ---- mergeProps (neutral default) ----

test('class strings are joined, not resolved', () => {
	expect(mergeProps({ class: 'px-2' }, { class: 'px-4' }).class).toBe('px-2 px-4');
});

test('className is joined too (React-shaped props)', () => {
	expect(mergeProps({ className: 'a' }, { className: 'b' }).className).toBe('a b');
});

test('last value wins, but undefined does not clobber an earlier value', () => {
	expect(mergeProps({ id: 'x' }, { id: 'y' }).id).toBe('y');
	expect(mergeProps({ id: 'x' }, { id: undefined }).id).toBe('x');
});

test('neutral mergeProps keeps style an object and chains functions', () => {
	const calls: string[] = [];
	const merged = mergeProps(
		{ style: 'color: red', onclick: () => calls.push('a') },
		{ style: { fontWeight: 'bold' }, onclick: () => calls.push('b') },
	);
	expect(merged.style).toEqual({ color: 'red', fontWeight: 'bold' });
	(merged.onclick as () => void)();
	expect(calls).toEqual(['a', 'b']);
});

test('symbol keys take the last defined value', () => {
	const sym = Symbol('attach');
	const merged = mergeProps({ [sym]: 1 }, { [sym]: 2 });
	expect((merged as Record<symbol, unknown>)[sym]).toBe(2);
});

// ---- sveltePreset ----

test('sveltePreset serializes style to a string', () => {
	const merge = createMergeProps(sveltePreset);
	expect(merge({ style: 'color: red' }, { style: { fontWeight: 'bold' } }).style).toBe('color: red; font-weight: bold;');
});

test('sveltePreset drops hidden/disabled when false but keeps them when true', () => {
	const merge = createMergeProps(sveltePreset);
	expect(merge({ hidden: true }, { hidden: false })).not.toHaveProperty('hidden');
	expect(merge({ disabled: false }, { disabled: true }).disabled).toBe(true);
});

test('sveltePreset composes lowercase on* handlers with preventDefault', () => {
	const merge = createMergeProps(sveltePreset);
	const calls: string[] = [];
	const event = {
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	};
	const merged = merge(
		{
			onclick: (e: typeof event) => {
				calls.push('first');
				e.preventDefault();
			},
		},
		{ onclick: () => calls.push('second') },
	);
	(merged.onclick as (e: typeof event) => void)(event);
	expect(calls).toEqual(['first']);
});

test('sveltePreset chains camelCase callbacks (no preventDefault short-circuit)', () => {
	const merge = createMergeProps(sveltePreset);
	const calls: string[] = [];
	const merged = merge(
		{ onValueChange: () => calls.push('a') },
		{ onValueChange: () => calls.push('b') },
	);
	(merged.onValueChange as () => void)();
	expect(calls).toEqual(['a', 'b']);
});

// ---- createMergeProps with a custom handler rule ----

test('createMergeProps honors a custom isEventHandler (React onClick)', () => {
	const merge = createMergeProps({ isEventHandler: (key) => /^on[A-Z]/.test(key) });
	const calls: string[] = [];
	const event = {
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	};
	const merged = merge(
		{
			onClick: (e: typeof event) => {
				calls.push('first');
				e.preventDefault();
			},
		},
		{ onClick: () => calls.push('second') },
	);
	(merged.onClick as (e: typeof event) => void)(event);
	expect(calls).toEqual(['first']);
});
