export type VariantsSchema = Record<string, Record<string, string>>;

export type VariantFn<S extends VariantsSchema> = (
	props?: { [K in keyof S]?: keyof S[K] | null | undefined } & { class?: string },
) => string;

/**
 * Build a variants function from a config of class strings. No merging.
 *
 * The config is compiled once. Mutating base, variants, or defaultVariants
 * after declareVariants(...) is called is unsupported.
 */
export function declareVariants<S extends VariantsSchema>(config: {
	base?: string;
	variants?: S;
	defaultVariants?: { [K in keyof S]?: keyof S[K] };
}): VariantFn<S> {
	const b = config.base ?? '';
	const v = config.variants as Record<string, Record<string, string>> | undefined;

	if (v == null) {
		return (b
			? ((p?: { class?: string }) => (p?.class ? b + ' ' + p.class : b))
			: ((p?: { class?: string }) => p?.class ?? '')) as VariantFn<S>;
	}

	const d = (config.defaultVariants ?? {}) as Record<string, string | undefined>;
	const a = Object.keys(v);
	const n = a.length;
	const m = new Array<Record<string, string>>(n);
	const f = new Array<string | undefined>(n);

	for (let i = 0; i < n; i++) {
		const k = a[i]!;
		m[i] = v[k]!;
		f[i] = d[k];
	}

	let z = b;

	for (let i = 0; i < n; i++) {
		const s = f[i];
		const x = s == null ? undefined : m[i]![s];
		if (x) z += z ? ' ' + x : x;
	}

	return ((p?: Record<string, string | null | undefined> & { class?: string }) => {
		if (p == null) return z;

		let o = b;

		for (let i = 0; i < n; i++) {
			let s = p[a[i]!];
			s = s === undefined ? f[i] : s;

			if (s != null) {
				const x = m[i]![s];
				if (x) o += o ? ' ' + x : x;
			}
		}

		const c = p.class;
		return c ? (o ? o + ' ' + c : c) : o;
	}) as VariantFn<S>;
}

/** Pull the axis props out of a variants function, without class. Use with typeof yourVariants. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariantProps<T extends (props?: any) => string> = Omit<NonNullable<Parameters<T>[0]>, 'class'>;