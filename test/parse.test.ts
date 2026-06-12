import { describe, expect, test } from 'bun:test';
import { bucketOf, parse } from '../src/parse.js';

describe('parse', () => {
	test('bare utility', () => {
		expect(parse('h-9')).toEqual({ raw: 'h-9', variants: [], bucket: '', base: 'h-9', important: false });
	});

	test('single variant', () => {
		const p = parse('md:p-4');
		expect(p.variants).toEqual(['md']);
		expect(p.base).toBe('p-4');
	});

	test('data attribute variant keeps its brackets', () => {
		const p = parse('data-[state=closed]:opacity-0');
		expect(p.variants).toEqual(['data-[state=closed]']);
		expect(p.base).toBe('opacity-0');
	});

	test('arbitrary variant with nested brackets, quotes, and inner colons', () => {
		const p = parse("[&_svg:not([class*='size-'])]:size-4");
		expect(p.variants).toEqual(["[&_svg:not([class*='size-'])]"]);
		expect(p.base).toBe('size-4');
	});

	test('arbitrary property with colon and parens, plus trailing important', () => {
		const p = parse('md:[--cell-size:--spacing(12)]!');
		expect(p.variants).toEqual(['md']);
		expect(p.base).toBe('[--cell-size:--spacing(12)]');
		expect(p.important).toBe(true);
	});

	test('trailing important (v4)', () => {
		expect(parse('font-normal!')).toMatchObject({ base: 'font-normal', important: true });
	});

	test('leading important (v3)', () => {
		expect(parse('!m-0')).toMatchObject({ base: 'm-0', important: true });
	});

	test('slash modifiers stay in the base', () => {
		expect(parse('bg-primary/80').base).toBe('bg-primary/80');
		expect(parse('w-3/4').base).toBe('w-3/4');
		expect(parse('hover:bg-destructive/90!').base).toBe('bg-destructive/90');
	});

	test('stacked variants', () => {
		const p = parse('rtl:starting:translate-x-full');
		expect(p.variants).toEqual(['rtl', 'starting']);
		expect(p.base).toBe('translate-x-full');
	});

	test('round-trips tokens written in v4 syntax', () => {
		const corpus = [
			'h-9',
			'md:hover:p-4',
			'data-[state=open]:bg-muted',
			"[&_svg:not([class*='size-'])]:size-4",
			'md:[--cell-size:--spacing(12)]!',
			'group-data-[collapsible=icon]:p-2!',
			'max-md:inset-x-0',
			'bg-primary/80',
		];
		for (const raw of corpus) {
			const p = parse(raw);
			const rebuilt = [...p.variants, p.base].join(':') + (p.important ? '!' : '');
			expect(rebuilt).toBe(raw);
		}
	});
});

describe('bucketOf', () => {
	test('order-insensitive variants share a bucket', () => {
		expect(parse('hover:md:p-4').bucket).toBe(parse('md:hover:p-4').bucket);
	});

	test('pseudo-element variants do not', () => {
		expect(parse('before:hover:underline').bucket).not.toBe(parse('hover:before:underline').bucket);
	});

	test('arbitrary variants are treated as order-sensitive', () => {
		expect(parse('[&>svg]:hover:opacity-50').bucket).not.toBe(parse('hover:[&>svg]:opacity-50').bucket);
	});

	test('variants on opposite sides of a pseudo-element stay distinct', () => {
		expect(parse('focus:before:underline').bucket).not.toBe(parse('before:focus:underline').bucket);
		expect(parse('md:before:hover:m-1').bucket).not.toBe(parse('hover:md:before:m-1').bucket);
		expect(parse('md:hover:before:m-1').bucket).toBe(parse('hover:md:before:m-1').bucket);
	});

	test('importance separates buckets', () => {
		expect(parse('p-4').bucket).not.toBe(parse('p-4!').bucket);
		expect(parse('md:p-4!').bucket).toBe(parse('md:p-2!').bucket);
	});

	test('permutation invariance for plain variants', () => {
		expect(bucketOf(['sm', 'dark', 'hover'], false)).toBe(bucketOf(['hover', 'sm', 'dark'], false));
	});
});
