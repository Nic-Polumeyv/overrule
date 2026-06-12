# Roadmap

What overrule is moving toward, in version order. Dates are not promises.

## 0.3.x, hardening the oracle

0.3.0 shipped the stylesheet-derived oracle. `createCssOracle` compiles candidates with Tailwind v4's own design system and judges by the declarations they actually produce: no name heuristics, no tables to maintain, custom utilities first class by construction. `overrule cross` prints every place the compiled CSS and tailwind-merge's tables disagree, and `--css` swaps the oracle under `check` and `fix`. Tokens that compile to nothing get reported as the typos they usually are. What is left in this line:

- **CI-friendly check output.** A `--json` flag for tooling, and GitHub Actions annotations (`::error file=...,line=...`) so `overrule check` failures show up inline on pull requests instead of buried in a log.
- **Acknowledged divergences.** `cross` exits 0 today because some disagreements are permanent and correct (the tables kill tokens that v4 composes through custom properties). A way to acknowledge the known ones turns `cross` into a CI gate that fails only on NEW disagreements.
- **Single-token literals.** The scanner skips them so `cn('active')` does not get flagged, which also hides single-token typos from the unknown-class report. Needs a decision, not just code.
- **Whatever dogfooding finds.** The first soak is done: seven production apps plus their component library, full agreement except one true positive. The next ones run continuously.

## 0.4.0, adoption surface

- **Per-framework wiring recipes** in the docs: the exact `guard` setup for SvelteKit, Next, Vite-anything, including the dev-flag idiom for each bundler. Recipes over plugins; a plugin is a maintenance surface a paragraph can replace.
- **The browser recipe for the css oracle.** `overrule/css` imports nothing on purpose; feed it a design system loaded from your stylesheet text (`?inline` in Vite) and the guard judges with your real CSS in the browser, in dev only.
- Revisit the no-plugin choice only if the recipes turn out to be genuinely error-prone in practice.

## 1.0.0

A promise, not a feature list. It happens when:

- the guard and test APIs have gone unchanged through real external use,
- the CSS oracle has survived an extended cross-check against tailwind-merge,
- and the production codebase this came from has run on it long enough to trust it.

## Non-goals

- **Runtime merging.** That is the thing this exists to remove.
- **Composition-aware static analysis.** Conflicts between a caller's classes and a component's internals only exist at runtime; the guard owns them. Pretending a scanner can see them would require modeling every component system, and it would lie at the edges.
- **An ESLint plugin, for now.** `overrule check` in CI covers the enforcement story without binding to a linter's release cycle.
