# Roadmap

What overrule is moving toward, in version order. Dates are not promises.

## 0.2.x, hardening

Small releases driven by real use.

- **Node job in CI.** The test suite runs under bun, but the CLI's contract is npx on Node. CI should run `node dist/cli.js check test/fixtures` against a build on every push so that promise is checked by a machine, not by memory.
- **CI-friendly check output.** A `--json` flag for tooling, and GitHub Actions annotations (`::error file=...,line=...`) so `overrule check` failures show up inline on pull requests instead of buried in a log.
- **Export the tokenizer as `overrule/parse`.** The class tokenizer (variants, importance in both syntaxes, arbitrary values that survive nested brackets and quotes, order-normalized bucket keys) ships in the package but is not exported yet. It is useful on its own and it is the foundation the 0.3.0 oracle builds on.
- **Whatever dogfooding finds.** The package came out of a production monorepo migration; adopting the published package back into that monorepo (guard in the component library, the variants assertion in its test suite, `overrule check` in CI) will surface API friction before strangers hit it.

## 0.3.0, the stylesheet-derived oracle

The headline. tailwind-merge classifies classes by name, which is why it silently deletes custom utilities it mis-classifies. The project's compiled CSS already knows the truth about every class, custom utilities included.

- **`createCssOracle()`** built on Tailwind v4's compile API: feed it the candidate classes, read back which declarations each one actually produces. Two tokens conflict when they declare the same properties in the same variant bucket. No name heuristics, no tables to maintain, correct for any Tailwind version and any custom utility by construction.
- **Cross-check mode.** Run both oracles and report disagreements. Every disagreement is either a bug here or a tailwind-merge misclassification worth reporting upstream with a reproduction.
- **Typo detection for free.** A token that compiles to nothing is not a class. Neither tailwind-merge nor anything else in this niche catches misspelled utilities; an oracle that reads the compiler's output gets this as a side effect.
- Open questions to settle during the work: batching candidates through the compile API so large codebases stay fast, and what counts as "the same condition" when variants compile to media queries versus selectors.

## 0.4.0, adoption surface

- **Per-framework wiring recipes** in the docs: the exact `guard` setup for SvelteKit, Next, Vite-anything, including the dev-flag idiom for each bundler. Recipes over plugins; a plugin is a maintenance surface a paragraph can replace.
- Revisit that choice only if the recipes turn out to be genuinely error-prone in practice.

## 1.0.0

A promise, not a feature list. It happens when:

- the guard and test APIs have gone unchanged through real external use,
- the CSS oracle has survived an extended cross-check against tailwind-merge,
- and the production codebase this came from has run on it long enough to trust it.

## Non-goals

- **Runtime merging.** That is the thing this exists to remove.
- **Composition-aware static analysis.** Conflicts between a caller's classes and a component's internals only exist at runtime; the guard owns them. Pretending a scanner can see them would require modeling every component system, and it would lie at the edges.
- **An ESLint plugin, for now.** `overrule check` in CI covers the enforcement story without binding to a linter's release cycle.
