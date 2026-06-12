import { describe, expect, test } from 'bun:test';
import { assertMergeFree, assertVariantsMergeFree, combos, mergeFree } from '../src/test.js';

// Trimmed from a real shadcn button: base and variants restate the same properties.
const mergeAuthored = (props?: Record<string, string>) => {
	const base = 'rounded-md border border-transparent text-sm font-medium inline-flex items-center';
	const variants: Record<string, string> = {
		default: 'bg-primary text-primary-foreground',
		outline: 'border-border bg-background',
	};
	const sizes: Record<string, string> = {
		default: 'h-9 px-2.5',
		xs: 'h-6 px-2 text-xs rounded-[8px]',
	};
	return `${base} ${variants[props?.variant ?? 'default']} ${sizes[props?.size ?? 'default']}`;
};

// The same button after distributing the contested tokens into the variants.
const disjoint = (props?: Record<string, string>) => {
	const base = 'border font-medium inline-flex items-center';
	const variants: Record<string, string> = {
		default: 'border-transparent bg-primary text-primary-foreground',
		outline: 'border-border bg-background',
	};
	const sizes: Record<string, string> = {
		default: 'rounded-md text-sm h-9 px-2.5',
		xs: 'rounded-[8px] text-xs h-6 px-2',
	};
	return `${base} ${variants[props?.variant ?? 'default']} ${sizes[props?.size ?? 'default']}`;
};

const axes = { variant: ['default', 'outline'], size: ['default', 'xs'] } as const;

describe('mergeFree / assertMergeFree', () => {
	test('clean string passes', () => {
		expect(mergeFree('flex items-center gap-2').ok).toBe(true);
		expect(() => assertMergeFree('flex items-center gap-2')).not.toThrow();
	});
	test('conflicting string lists its losers', () => {
		const result = mergeFree('p-4 p-2');
		expect(result.ok).toBe(false);
		expect(result.dropped).toEqual(['p-4']);
		expect(() => assertMergeFree('p-4 p-2')).toThrow('p-4');
	});
});

describe('combos', () => {
	test('cartesian product over axes', () => {
		expect(combos(axes)).toHaveLength(4);
		expect(combos({})).toEqual([{}]);
	});
});

describe('assertVariantsMergeFree', () => {
	test('disjoint variants pass every combo', () => {
		expect(() => assertVariantsMergeFree(disjoint, axes)).not.toThrow();
	});
	test('merge-authored variants fail with the combo and tokens', () => {
		expect(() => assertVariantsMergeFree(mergeAuthored, axes)).toThrow(/variant.*xs.*rounded-md|rounded-md.*xs/s);
	});
});
