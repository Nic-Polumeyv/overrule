import { test, expect } from 'bun:test';

import { createMergeProps, mergeStyles, styleToObject, styleToString, type StyleObject } from '../../runtime/props.js';

// Characterization pins for the props module. Every expectation below was
// captured by running the implementation as of 707dbbe; quirks are pinned on
// purpose. A failure here means observable behavior changed, not a bug fixed.

// ---- styleToObject: declaration splitting and trimming ----

test('basic declarations, with and without spaces', () => {
	expect(styleToObject('color: red; background-color: blue')).toEqual({ color: 'red', backgroundColor: 'blue' });
	expect(styleToObject('color:red;background-color:blue')).toEqual({ color: 'red', backgroundColor: 'blue' });
	expect(styleToObject('color: red;')).toEqual({ color: 'red' });
});

test('names and values are trimmed; inner whitespace survives', () => {
	expect(styleToObject('\n\tcolor  :  red ;\n background-color:blue  ;\t')).toEqual({
		color: 'red',
		backgroundColor: 'blue',
	});
});

test('empty and degenerate declarations', () => {
	expect(styleToObject(';;')).toEqual({});
	expect(styleToObject('; ;')).toEqual({});
	expect(styleToObject('color:')).toEqual({ color: '' });
	expect(styleToObject(': red')).toEqual({});
	expect(styleToObject('no-colon')).toEqual({});
	expect(styleToObject('')).toEqual({});
	expect(styleToObject('   ')).toEqual({});
	expect(styleToObject(null)).toEqual({});
	expect(styleToObject(undefined)).toEqual({});
});

test('duplicate property: later declaration wins', () => {
	expect(styleToObject('color: red; color: blue')).toEqual({ color: 'blue' });
});

test('value keeps every colon after the first', () => {
	expect(styleToObject('background: url(a:b):c')).toEqual({ background: 'url(a:b):c' });
});

// ---- styleToObject: name conversion (splitByCase/camelCase quirks) ----

test('all four separators split: - _ / .', () => {
	expect(styleToObject('font_size: 1px; font/weight: 2; font.family: x')).toEqual({
		fontSize: '1px',
		fontWeight: '2',
		fontFamily: 'x',
	});
});

test('digits are caseless: they never open a new segment by themselves', () => {
	expect(styleToObject('grid-row2: 1; x2y: 2; row-2-col: 3')).toEqual({ gridRow2: '1', x2y: '2', row2Col: '3' });
});

test('UPPERCASE names mangle: only the first char is lowered (quirk)', () => {
	expect(styleToObject('COLOR: red; BACKGROUND-COLOR: blue')).toEqual({ cOLOR: 'red', bACKGROUNDCOLOR: 'blue' });
});

test('leading-cap and mixed-cap runs (quirk: acronym runs keep their tail)', () => {
	expect(styleToObject('Color: red')).toEqual({ color: 'red' });
	expect(styleToObject('fooBAR-baz: v; HTMLDiv-color: w')).toEqual({ fooBARBaz: 'v', hTMLDivColor: 'w' });
});

test('unicode names: case detection is toLowerCase-based, code points intact', () => {
	expect(styleToObject('straße-color: a; 色: b; ünïcode-tëst: c')).toEqual({
		straßeColor: 'a',
		色: 'b',
		ünïcodeTëst: 'c',
	});
	expect(styleToObject('𝒜-prop: v')).toEqual({ '𝒜Prop': 'v' });
});

test('a name of only separators becomes the empty-string key (quirk)', () => {
	expect(styleToObject('-: x')).toEqual({ '': 'x' });
});

// ---- styleToObject: vendor prefix allowlist ----

test('allowlisted vendor prefixes PascalCase: -webkit- -moz- -ms- -o-', () => {
	expect(
		styleToObject('-webkit-box-shadow: 0 0 red; -moz-appearance: none; -ms-flex: 1; -o-transform: rotate(1deg)'),
	).toEqual({ WebkitBoxShadow: '0 0 red', MozAppearance: 'none', MsFlex: '1', OTransform: 'rotate(1deg)' });
});

test('non-allowlisted prefixes camelCase and lose the leading dash (quirk)', () => {
	expect(styleToObject('-khtml-opacity: .5; -epub-writing-mode: tb')).toEqual({
		khtmlOpacity: '.5',
		epubWritingMode: 'tb',
	});
});

test('the allowlist is case-sensitive (quirk)', () => {
	expect(styleToObject('-O-transform: x; -WEBKIT-COLOR: y')).toEqual({ oTransform: 'x', wEBKITCOLOR: 'y' });
});

// ---- styleToObject: custom properties ----

test('custom properties keep case; values are trimmed but inner spaces kept', () => {
	expect(styleToObject('--x: 1px; --My-Var:  keep  inner  ; --UPPER_case: v; --Foo-BAR: x')).toEqual({
		'--x': '1px',
		'--My-Var': 'keep  inner',
		'--UPPER_case': 'v',
		'--Foo-BAR': 'x',
	});
	expect(styleToObject('--: x')).toEqual({ '--': 'x' });
	expect(styleToObject('---x: v')).toEqual({ '---x': 'v' });
});

// ---- styleToObject: quotes and parens (splitDeclarations) ----

test('quoted values shield ; : { } and comment markers', () => {
	expect(styleToObject('content: "a; b: {c} /* d */"; color: red')).toEqual({
		content: '"a; b: {c} /* d */"',
		color: 'red',
	});
	expect(styleToObject("content: 'x;y'; color: red")).toEqual({ content: "'x;y'", color: 'red' });
	expect(styleToObject('content: "it\'s; fine"; color: red')).toEqual({ content: '"it\'s; fine"', color: 'red' });
});

test('parens shield semicolons: data URLs and nested calc', () => {
	expect(styleToObject('background: url(data:image/png;base64,AAA==); color: red')).toEqual({
		background: 'url(data:image/png;base64,AAA==)',
		color: 'red',
	});
	expect(styleToObject('width: calc(100% - calc(10px + 2px)); height: 5px')).toEqual({
		width: 'calc(100% - calc(10px + 2px))',
		height: '5px',
	});
});

test('unbalanced parens: stray ) is ignored, unclosed ( eats the rest', () => {
	expect(styleToObject('width: a)b; color: red')).toEqual({ width: 'a)b', color: 'red' });
	expect(styleToObject('background: url(a;b')).toEqual({ background: 'url(a;b' });
});

test('unterminated quote eats the rest of the string (quirk)', () => {
	expect(styleToObject('content: "abc; color: red')).toEqual({ content: '"abc; color: red' });
});

test('backslash escapes are not honored inside quotes (quirk)', () => {
	expect(styleToObject('content: "a\\"b; c"; color: red')).toEqual({ content: '"a\\"b', 'c"; color': 'red' });
});

// ---- styleToObject: comments (stripComments) ----

test('block comments outside quotes are stripped', () => {
	expect(styleToObject('/* lead */ color: red /* mid */; background: blue /* trail */')).toEqual({
		color: 'red',
		background: 'blue',
	});
});

test('a comment inside a name or value becomes a single space (quirk)', () => {
	expect(styleToObject('col/*x*/or: red')).toEqual({ 'col or': 'red' });
	expect(styleToObject('color: re/*x*/d')).toEqual({ color: 're d' });
});

test('unterminated comments swallow the rest', () => {
	expect(styleToObject('color: red; /* oops')).toEqual({ color: 'red' });
	expect(styleToObject('color: re/*d')).toEqual({ color: 're' });
});

test('comment markers inside quotes are preserved', () => {
	expect(styleToObject('content: "/* not */"; color: red')).toEqual({ content: '"/* not */"', color: 'red' });
});

// ---- styleToObject: prototype safety ----

test('__proto__ in CSS camelCases to "proto"; constructor is an own key', () => {
	const r = styleToObject('__proto__: injected; constructor: x');
	expect(Object.keys(r)).toEqual(['proto', 'constructor']);
	expect(Object.getOwnPropertyDescriptor(r, '__proto__')).toBeUndefined();
	expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
	expect(Object.getOwnPropertyDescriptor(r, 'constructor')?.value).toBe('x');
});

// ---- styleToString ----

test('camelCase keys kebab; key order is insertion order', () => {
	expect(styleToString({ backgroundColor: 'red', color: 'blue' })).toBe('background-color: red; color: blue;');
});

test('custom properties pass through; vendor PascalCase round-trips', () => {
	expect(styleToString({ '--x': '1px', '--Foo-BAR': 'v' })).toBe('--x: 1px; --Foo-BAR: v;');
	expect(styleToString({ WebkitBoxShadow: '0 0', MozAppearance: 'none', MsFlex: '1', OTransform: 'x' })).toBe(
		'-webkit-box-shadow: 0 0; -moz-appearance: none; -ms-flex: 1; -o-transform: x;',
	);
});

test('zero and empty string render; only nullish is skipped', () => {
	expect(styleToString({ margin: 0, content: '', a: null, b: undefined })).toBe('margin: 0; content: ;');
	expect(styleToString({ opacity: 0.5, zIndex: 50 })).toBe('opacity: 0.5; z-index: 50;');
});

test('every uppercase ASCII letter gets a dash, even leading or consecutive (quirk)', () => {
	expect(styleToString({ ABc: 'x', fooBARBaz: 'y' })).toBe('-a-bc: x; foo-b-a-r-baz: y;');
});

test('non-ASCII uppercase is not kebabed; keys and values are not trimmed', () => {
	expect(styleToString({ straßeColor: 'v', 色: 'w' })).toBe('straße-color: v; 色: w;');
	expect(styleToString({ grid2Col: 'x' })).toBe('grid2-col: x;');
	expect(styleToString({ color: '  padded  ' })).toBe('color:   padded  ;');
	expect(styleToString({ 'col or': 'red' })).toBe('col or: red;');
});

test('empty object serializes to the empty string', () => {
	expect(styleToString({})).toBe('');
});

test('inherited enumerable keys serialize after own keys (for-in, quirk)', () => {
	const obj = Object.assign(Object.create({ color: 'inherited' }), { margin: '0' }) as StyleObject;
	expect(styleToString(obj)).toBe('margin: 0; color: inherited;');
});

test('string-object-string round-trip is stable', () => {
	expect(styleToString(styleToObject('margin-top: 4px; --gap: 8px; -webkit-transform: scale(2);'))).toBe(
		'margin-top: 4px; --gap: 8px; -webkit-transform: scale(2);',
	);
});

// ---- mergeStyles ----

test('later wins across string and object inputs; key order is first-seen', () => {
	expect(mergeStyles('color: red; margin: 0', { color: 'blue' }, 'color: green')).toEqual({
		color: 'green',
		margin: '0',
	});
	expect(Object.keys(mergeStyles({ a: '1', b: '2' }, { c: '3', a: '9' }))).toEqual(['a', 'b', 'c']);
});

test('an explicit undefined value clobbers and stays an own key (quirk)', () => {
	const r = mergeStyles({ color: 'red' }, { color: undefined });
	expect(Object.prototype.hasOwnProperty.call(r, 'color')).toBe(true);
	expect(r.color).toBeUndefined();
});

test('null values clobber and are kept', () => {
	expect(mergeStyles({ color: 'red' }, { color: null })).toEqual({ color: null });
});

test('non-string non-object entries are skipped; empty string is a no-op', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	expect(mergeStyles(0 as any, false as any, true as any, { a: '1' })).toEqual({ a: '1' });
	expect(mergeStyles({ color: 'red' }, '')).toEqual({ color: 'red' });
});

test('an own __proto__ key on an input stays an own data key (spread parity)', () => {
	const evil = JSON.parse('{"__proto__": "x"}') as StyleObject;
	const r = mergeStyles({ color: 'red' }, evil);
	expect(Object.getOwnPropertyDescriptor(r, '__proto__')).toEqual({
		value: 'x',
		writable: true,
		enumerable: true,
		configurable: true,
	});
	expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
	expect(Object.keys(r)).toEqual(['color', '__proto__']);
	expect(r.color).toBe('red');
});

test('arrays copy by index; getters run once; enumerable symbols copy', () => {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	expect(mergeStyles(['a', 'b'] as any)).toEqual({ 0: 'a', 1: 'b' } as unknown as StyleObject);
	let gets = 0;
	const withGetter = Object.defineProperty({}, 'color', {
		get() {
			gets++;
			return 'lazy';
		},
		enumerable: true,
	}) as StyleObject;
	expect(mergeStyles(withGetter).color).toBe('lazy');
	expect(gets).toBe(1);
	const sym = Symbol('s');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const r = mergeStyles({ [sym]: 'v', color: 'red' } as any);
	expect((r as Record<symbol, unknown>)[sym]).toBe('v');
});

// ---- createMergeProps with the consumer's exact options ----

const merge = createMergeProps({
	styleAs: 'string',
	dropFalseAttrs: ['hidden', 'disabled'],
	isEventHandler: (k) => k.length > 2 && k.startsWith('on') && k === k.toLowerCase(),
});

test('a style never merged against stays byte-identical', () => {
	expect(merge({ style: 'color:red' }, { id: 'x' }).style).toBe('color:red');
});

test('a style that hits the merge path is normalized, even alone (quirk)', () => {
	expect(merge({ id: 'x' }, { style: 'color:red' }).style).toBe('color: red;');
	expect(merge({ style: 'color:red' }, { style: '' }).style).toBe('color: red;');
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	expect(merge({ style: 'color:red' }, { style: 0 } as any).style).toBe('color: red;');
});

test('a lone style object in args[0] is still serialized', () => {
	expect(merge({ style: { color: 'red', zIndex: 50 } }).style).toBe('color: red; z-index: 50;');
});

test('string plus object merge serializes; undefined value erases at serialize time', () => {
	expect(merge({ style: 'color: red' }, { style: { fontWeight: 'bold' } }).style).toBe(
		'color: red; font-weight: bold;',
	);
	expect(merge({ style: 'color:red' }, { style: { color: undefined } }).style).toBe('');
});

test('undefined values still create own keys (quirk)', () => {
	expect(Object.prototype.hasOwnProperty.call(merge({}, { foo: undefined } as Record<string, unknown>), 'foo')).toBe(
		true,
	);
	expect(Object.prototype.hasOwnProperty.call(merge({ foo: undefined } as Record<string, unknown>), 'foo')).toBe(true);
});

test('dropFalseAttrs applies even when nothing merged', () => {
	expect(Object.keys(merge({ disabled: false, id: 'x' }))).toEqual(['id']);
});

test('two function-valued class props chain instead of joining (quirk)', () => {
	const calls: string[] = [];
	const r = merge(
		{ class: () => calls.push('a') } as Record<string, unknown>,
		{ class: () => calls.push('b') } as Record<string, unknown>,
	);
	expect(typeof r.class).toBe('function');
	(r.class as unknown as () => void)();
	expect(calls).toEqual(['a', 'b']);
});

test('a function class against a string class joins, dropping the function (quirk)', () => {
	expect(merge({ class: () => {} } as Record<string, unknown>, { class: 'x' }).class).toBe('x');
});

test('undefined symbol values: kept from args[0], skipped from later args (quirk)', () => {
	const sym = Symbol('attach');
	expect(
		Object.prototype.hasOwnProperty.call(merge({ [sym]: undefined } as Record<string | symbol, unknown>), sym),
	).toBe(true);
	expect(
		Object.prototype.hasOwnProperty.call(
			merge({} as Record<string | symbol, unknown>, { [sym]: undefined } as Record<string | symbol, unknown>),
			sym,
		),
	).toBe(false);
});

test('nullish args are skipped; zero args yield an empty object', () => {
	expect(merge(null, { a: 1 }, undefined)).toEqual({ a: 1 });
	expect(merge()).toEqual({});
});

test('realistic three-object merge, exact result', () => {
	const r = merge(
		{
			class: 'inline-flex items-center gap-2 rounded-md text-sm',
			'data-slot': 'trigger',
			style: { position: 'absolute', left: '13.5px', top: '842px', '--origin': 'left top', zIndex: 50 },
			hidden: false,
			id: 'trigger-1',
		},
		{ class: 'px-4', 'data-state': 'open', style: 'pointer-events: auto; left: 20px', tabindex: 0 },
		{ 'aria-expanded': 'true' },
	);
	expect(r as Record<string, unknown>).toEqual({
		class: 'inline-flex items-center gap-2 rounded-md text-sm px-4',
		'data-slot': 'trigger',
		style: 'position: absolute; left: 20px; top: 842px; --origin: left top; z-index: 50; pointer-events: auto;',
		id: 'trigger-1',
		'data-state': 'open',
		tabindex: 0,
		'aria-expanded': 'true',
	});
	expect(Object.keys(r)).toEqual([
		'class',
		'data-slot',
		'style',
		'id',
		'data-state',
		'tabindex',
		'aria-expanded',
	]);
});

test('consumer isEventHandler: lowercase on* composes, camelCase on* chains', () => {
	const calls: string[] = [];
	const event = {
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
	};
	const composed = merge(
		{
			onclick: (e: typeof event) => {
				calls.push('first');
				e.preventDefault();
			},
		},
		{ onclick: () => calls.push('second') },
	);
	(composed.onclick as (e: typeof event) => void)(event);
	expect(calls).toEqual(['first']);

	const chained = merge({ onValueChange: () => calls.push('a') }, { onValueChange: () => calls.push('b') });
	(chained.onValueChange as () => void)();
	expect(calls).toEqual(['first', 'a', 'b']);
});
