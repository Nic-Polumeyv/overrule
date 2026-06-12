import { describe, expect, test } from 'bun:test';
import { findConflicts, guard, join } from '../src/index.js';

describe('findConflicts', () => {
	test('reports the losing token', () => {
		expect(findConflicts('h-9 px-4 h-8')?.dropped).toEqual(['h-9']);
	});
	test('duplicates are not conflicts', () => {
		expect(findConflicts('h-8 px-4 h-8')).toBeNull();
	});
	test('trailing ! resolves the conflict', () => {
		expect(findConflicts('font-medium font-normal!')).toBeNull();
	});
	test('different modifier buckets do not conflict', () => {
		expect(findConflicts('inline-flex max-lg:hidden')).toBeNull();
		expect(findConflicts('p-4 sm:p-6 hover:p-8')).toBeNull();
	});
	test('same modifier bucket conflicts', () => {
		expect(findConflicts('sm:p-4 sm:p-6')?.dropped).toEqual(['sm:p-4']);
	});
	test('font-size drops line-height', () => {
		expect(findConflicts('text-sm leading-snug text-xs')?.dropped).toEqual(expect.arrayContaining(['text-sm', 'leading-snug']));
	});
});

describe('guard', () => {
	test('passes output through unchanged and reports conflicts', () => {
		const conflicts: string[][] = [];
		const cn = guard(join, (c) => conflicts.push(c.dropped));
		expect(cn('h-9', 'h-8')).toBe('h-9 h-8');
		expect(conflicts).toEqual([['h-9']]);
	});
	test('silent on clean input', () => {
		const conflicts: string[][] = [];
		const cn = guard(join, (c) => conflicts.push(c.dropped));
		expect(cn('flex items-center', 'gap-2')).toBe('flex items-center gap-2');
		expect(conflicts).toEqual([]);
	});
	test('default reporter warns once per signature', () => {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (message: string) => warnings.push(message);
		try {
			const cn = guard(join);
			cn('w-4 w-8');
			cn('px-1 w-4 w-8');
			cn('gap-1 gap-2');
		} finally {
			console.warn = original;
		}
		expect(warnings.length).toBe(2);
		expect(warnings[0]).toContain('w-4');
	});
});
