import { createMapOracle, type ConflictMap } from '../../runtime/map-oracle.js';

// A hand-written stylesheet map stands in for a generated one: enough tokens
// for every contract in these tests to contest realistically, nothing else.
// The raw map is exported too; the eslint suite feeds it through rule options.
export const conflictMap: ConflictMap = {
	version: 1,
	covers: {},
	tokens: {
		'p-2': [{ bucket: '', props: ['padding'] }],
		'p-4': [{ bucket: '', props: ['padding'] }],
		'm-2': [{ bucket: '', props: ['margin'] }],
		'mt-1': [{ bucket: '', props: ['margin-top'] }],
		'mt-2': [{ bucket: '', props: ['margin-top'] }],
		'mt-3': [{ bucket: '', props: ['margin-top'] }],
		'text-sm': [{ bucket: '', props: ['font-size'] }],
		'text-lg': [{ bucket: '', props: ['font-size'] }],
		'text-base': [{ bucket: '', props: ['font-size'] }],
		'text-white': [{ bucket: '', props: ['color'] }],
		'text-black': [{ bucket: '', props: ['color'] }],
		'text-red-500': [{ bucket: '', props: ['color'] }],
		'bg-black': [{ bucket: '', props: ['background-color'] }],
		'bg-transparent': [{ bucket: '', props: ['background-color'] }],
		'h-8': [{ bucket: '', props: ['height'] }],
		'h-11': [{ bucket: '', props: ['height'] }],
		'px-2': [{ bucket: '', props: ['padding-inline'] }],
		'px-4': [{ bucket: '', props: ['padding-inline'] }],
		flex: [{ bucket: '', props: ['display'] }],
		'inline-flex': [{ bucket: '', props: ['display'] }],
		'items-center': [{ bucket: '', props: ['align-items'] }],
		'gap-2': [{ bucket: '', props: ['gap'] }],
	},
};

export const mapOracle = createMapOracle(conflictMap);
