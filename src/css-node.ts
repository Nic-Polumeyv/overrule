import { cssOracle, type DesignSystemLike, type Oracle } from './css.js';

/**
 * The Node loader for the css oracle. This is the only file in the package
 * that touches the filesystem at runtime, so the oracle itself stays
 * portable; loading goes through `@tailwindcss/node` to resolve imports,
 * plugins, and configs the way your build does.
 *
 *   const oracle = await createCssOracle({ css: readFileSync('src/app.css', 'utf8'), base: 'src' });
 *   assertVariantsMergeFree(buttonVariants, axes, oracle);
 */

export type CssOracleOptions = {
	/**
	 * CSS entry to compile against. Defaults to a bare `@import "tailwindcss"`,
	 * which knows nothing about your theme or custom utilities. Point it at
	 * your real entry for the full truth.
	 */
	css?: string;
	/** Directory for resolving imports, plugins, and configs. Defaults to process.cwd(). */
	base?: string;
};

/** Load a design system to share between cssOracle and typoOracle. */
export async function loadDesignSystem(options: CssOracleOptions = {}): Promise<DesignSystemLike> {
	let mod: typeof import('@tailwindcss/node');
	try {
		mod = await import('@tailwindcss/node');
	} catch {
		throw new Error(
			'createCssOracle compiles your classes with Tailwind itself. Install tailwindcss and @tailwindcss/node, both 4.2 or newer.',
		);
	}
	return (await mod.__unstable__loadDesignSystem(options.css ?? '@import "tailwindcss";', {
		base: options.base ?? process.cwd(),
	})) as unknown as DesignSystemLike;
}

export async function createCssOracle(options: CssOracleOptions = {}): Promise<Oracle> {
	return cssOracle(await loadDesignSystem(options));
}
