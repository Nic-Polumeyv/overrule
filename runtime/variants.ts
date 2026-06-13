/** A variants schema: each axis maps option names to class strings. */
type VariantsSchema = Record<string, Record<string, string>>;

/**
 * Build a variants function from a config of class strings. No merging.
 *
 * The returned function takes one option per axis and joins base, the chosen
 * variant classes, and a trailing caller class into one string. It never
 * resolves conflicts, and that is the point. The strings are meant to be
 * disjoint: base and variants must not set the same property for the same
 * modifier prefix, so the join is the whole job and tailwind-merge ships
 * nowhere. Prove the disjointness with assertVariantsMergeFree in a test and
 * overrule check in CI.
 *
 * An axis left undefined falls back to defaultVariants. Pass null to opt an
 * axis out and it emits nothing. The caller class is appended last and is not
 * checked here; the dev guard and the CLI cover it.
 *
 *   const button = declareVariants({
 *     base: 'inline-flex items-center',
 *     variants: {
 *       variant: { solid: 'bg-primary text-white', ghost: 'bg-transparent' },
 *       size: { sm: 'h-8 px-2', lg: 'h-10 px-4' },
 *     },
 *     defaultVariants: { variant: 'solid', size: 'sm' },
 *   });
 *
 *   button();                          // base, solid, sm
 *   button({ size: 'lg' });            // base, solid, lg
 *   button({ variant: null });         // base, sm, no variant classes
 *   button({ class: 'rounded-full' }); // base, solid, sm, rounded-full
 */
export function declareVariants<S extends VariantsSchema>(config: {
	base?: string;
	variants?: S;
	defaultVariants?: { [K in keyof S]?: keyof S[K] };
}): (props?: { [K in keyof S]?: keyof S[K] | null | undefined } & { class?: string }) => string {
	const variants = config.variants;
	return (props) => {
		let out = config.base ?? '';
		if (variants) {
			for (const axis in variants) {
				const key = axis as keyof S;
				const raw = props?.[key];
				const selected = raw === undefined ? config.defaultVariants?.[key] : raw;
				const classes = selected == null ? undefined : variants[key][selected as string];
				if (classes) out += (out ? ' ' : '') + classes;
			}
		}
		if (props?.class) out += (out ? ' ' : '') + props.class;
		return out;
	};
}

/** Pull the axis props out of a variants function, without class. Use with typeof yourVariants. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VariantProps<T extends (props?: any) => string> = Omit<NonNullable<Parameters<T>[0]>, 'class'>;
