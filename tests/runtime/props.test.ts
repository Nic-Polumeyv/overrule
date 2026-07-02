import { test, expect } from 'bun:test';

import {
	createMergeProps,
	chain,
	composeEventHandlers,
	mergeStyles,
	styleToObject,
	styleToString,
} from '../../runtime/props.js';

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

test('styleToObject ignores block comments outside quoted strings', () => {
	expect(styleToObject('/* lead */ color: red; /* middle */ background: blue;')).toEqual({
		color: 'red',
		background: 'blue',
	});
	expect(styleToObject('color: red /* inline */; content: "/* not a comment */";')).toEqual({
		color: 'red',
		content: '"/* not a comment */"',
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

// ---- createMergeProps: neutral (no options) ----

test('class strings are joined, not resolved', () => {
	const merge = createMergeProps();
	expect(merge({ class: 'px-2' }, { class: 'px-4' }).class).toBe('px-2 px-4');
});

test('className is joined too (React-shaped props)', () => {
	const merge = createMergeProps();
	expect(merge({ className: 'a' }, { className: 'b' }).className).toBe('a b');
});

test('last value wins, but undefined does not clobber an earlier value', () => {
	const merge = createMergeProps();
	expect(merge({ id: 'x' }, { id: 'y' }).id).toBe('y');
	expect(merge({ id: 'x' }, { id: undefined } as { id?: string }).id).toBe('x');
});

test('with no options, style stays an object and functions are chained', () => {
	const merge = createMergeProps();
	const calls: string[] = [];
	const merged = merge(
		{ style: 'color: red', onclick: () => calls.push('a') },
		{ style: { fontWeight: 'bold' }, onclick: () => calls.push('b') },
	);
	expect(merged.style).toEqual({ color: 'red', fontWeight: 'bold' });
	(merged.onclick as () => void)();
	expect(calls).toEqual(['a', 'b']);
});

test('symbol keys take the last defined value', () => {
	const merge = createMergeProps();
	const sym = Symbol('attach');
	const merged = merge({ [sym]: 1 }, { [sym]: 2 });
	expect((merged as Record<symbol, unknown>)[sym]).toBe(2);
});

// ---- createMergeProps: options ----

test('styleAs:"string" serializes a merged style to CSS text', () => {
	const merge = createMergeProps({ styleAs: 'string' });
	expect(merge({ style: 'color: red' }, { style: { fontWeight: 'bold' } }).style).toBe('color: red; font-weight: bold;');
});

test('styleAs:"string" types the merged style as string (no cast needed)', () => {
	const merge = createMergeProps({ styleAs: 'string' });
	const merged = merge({ style: 'color: red' }, { style: { fontWeight: 'bold' } });
	// Type-level assertion: this only compiles under tsc if `merged.style` is `string | undefined`.
	const style: string | undefined = merged.style;
	expect(style).toBe('color: red; font-weight: bold;');
});

test('dropFalseAttrs removes keys that merge to false but keeps true', () => {
	const merge = createMergeProps({ dropFalseAttrs: ['hidden', 'disabled'] });
	expect(merge({ hidden: true }, { hidden: false })).not.toHaveProperty('hidden');
	expect(merge({ disabled: false }, { disabled: true }).disabled).toBe(true);
});

test('isEventHandler composes matching handlers with preventDefault short-circuit', () => {
	const merge = createMergeProps({ isEventHandler: (key) => key.length > 2 && key.startsWith('on') && key === key.toLowerCase() });
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

test('functions a rule does not flag as handlers are chained (all called)', () => {
	const merge = createMergeProps({ isEventHandler: (key) => key.length > 2 && key.startsWith('on') && key === key.toLowerCase() });
	const calls: string[] = [];
	const merged = merge(
		{ onValueChange: () => calls.push('a') },
		{ onValueChange: () => calls.push('b') },
	);
	(merged.onValueChange as () => void)();
	expect(calls).toEqual(['a', 'b']);
});

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

// ---- boundary pins: the cases a plausible rewrite gets wrong ----

test('styleToString keeps zero and empty-string values, skipping only nullish', () => {
	expect(styleToString({ margin: 0, content: '', color: null })).toBe('margin: 0; content: ;');
});

test('null clobbers an earlier value; only undefined defers', () => {
	const merge = createMergeProps();
	expect(merge({ id: 'x' }, { id: null } as { id: string | null }).id).toBeNull();
	// A null handler disables the earlier one by design: last wins for every
	// non-undefined scalar, functions included.
	expect(
		merge({ onclick: () => {} }, { onclick: null } as { onclick: (() => void) | null }).onclick,
	).toBeNull();
});

test('chained functions receive every argument and never short-circuit', () => {
	const merge = createMergeProps();
	const calls: unknown[][] = [];
	const merged = merge(
		{ notify: (...args: unknown[]) => calls.push(args) },
		{ notify: (...args: unknown[]) => calls.push(args) },
	);
	(merged.notify as (...args: unknown[]) => void)({ defaultPrevented: true }, 'extra');
	expect(calls).toEqual([
		[{ defaultPrevented: true }, 'extra'],
		[{ defaultPrevented: true }, 'extra'],
	]);
});

test('dropFalseAttrs deletes exactly false, not other falsy values', () => {
	const merge = createMergeProps({ dropFalseAttrs: ['hidden', 'disabled'] });
	expect(merge({ hidden: 0 }).hidden).toBe(0);
	expect(merge({ disabled: '' }).disabled).toBe('');
});

test('an undefined symbol value does not clobber an earlier one', () => {
	const merge = createMergeProps();
	const sym = Symbol('attach');
	expect((merge({ [sym]: 1 }, { [sym]: undefined }) as Record<symbol, unknown>)[sym]).toBe(1);
});

test('styleAs:"string" leaves an unmerged string style untouched', () => {
	const merge = createMergeProps({ styleAs: 'string' });
	expect(merge({ style: 'color:red' }).style).toBe('color:red');
});
