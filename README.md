# overrule

tailwind-merge as a dev tool, kept out of your production bundle. The CLI is Rust now.

`check` reports class strings whose tokens fight and exits 1. `fix` rewrites each one to the form the merge would have produced, so it cannot change a pixel. `cross` compares the name tables against your compiled stylesheet and prints every disagreement. Same contract as the 0.3.x npm CLI, byte for byte where the engines agree: same text output, same JSON shapes, same exit codes, and ack snapshots interop both ways.

The runtime half ships from the same npm package and stays JavaScript, because dev-bundle work is JavaScript's turf. See [Runtime](#runtime).

## Install

```bash
bun add -d overrule
# or
npm i -D overrule
```

The package is a native binary behind a 30-line shim: npm picks the right prebuilt from optionalDependencies (linux x64/arm64 plus x64 musl, macOS x64/arm64, windows x64/arm64) and `npx overrule` hands over to it. Any other platform builds from source with `cargo build --release`.

## Run

```bash
npx overrule check src/                       # report conflicts, exit 1 if any
npx overrule fix src/                         # rewrite them, losers removed
npx overrule check src/ --css src/app.css     # judge with your stylesheet
npx overrule cross src/ --css src/app.css     # tables vs stylesheet
npx overrule cross src/ --ack acks.json       # CI gate: new disagreements only
```

`--css` and `cross` compile your classes with Tailwind itself, so they need node plus tailwindcss and @tailwindcss/node, 4.2 or newer, reachable from the CSS entry's project or from the directory you run in. Plain `check` and `fix` need nothing.

## Runtime

The npm package is the JavaScript runtime too. The manifest declares `sideEffects: false` and the default oracle is built on first use, so importing `join` alone pulls no tailwind-merge into any bundle, Rollup or esbuild alike. Wire the guard in dev and it vanishes in prod:

```ts
import { join, guard } from 'overrule';
const cn = import.meta.env.DEV ? guard(join) : join;
```

`join` concatenates clsx-style inputs and resolves nothing. `guard` wraps it and warns when a class string carries tokens that fight, so the conflict shows at dev time instead of leaving it to the cascade. `overrule/test` runs the same check in your suite through `assertMergeFree` and `assertVariantsMergeFree`. `declareVariants` builds a variant function from class strings with no merge engine behind it. The first three trace back to the [v0.3.1 tag](https://github.com/Nic-Polumeyv/overrule/tree/v0.3.1); the rest is newer.

### overrule/props

`createMergeProps(options)` builds a function that composes component prop objects without tailwind-merge, one layer up from `join`. Class strings go through `join`, so conflicts still surface through `guard` and the oracle instead of resolving silently. Style objects and strings merge, same-named functions compose or chain, everything else is last value wins.

```ts
import { createMergeProps } from 'overrule/props';
const mergeProps = createMergeProps();
const props = mergeProps({ class: 'px-2', onclick: open }, { class: 'px-4', onclick: track });
```

With no options the merger is platform-neutral: a merged `style` stays an object, no attribute is dropped, functions are chained. Options opt into framework idioms: `styleAs: 'string'` serializes `style` to a string, `dropFalseAttrs` removes named boolean attrs when they merge to false, and `isEventHandler` marks which same-named functions compose with preventDefault (the rest chain). Framework-specific policy — the Svelte/bits-ui combination, say — is the consumer's to assemble from these options; overrule ships only the engine. The primitives ship too: `composeEventHandlers`, `chain`, `mergeStyles`, `styleToObject`, `styleToString`. Nothing rides along as a dependency, because the CSS parse and serialize are inline.

## What moved, what stayed

| v0.3.1 | now | notes |
| --- | --- | --- |
| src/parse.ts | src/parse.rs | direct port |
| src/oracle.ts | src/oracle.rs | tailwind-fuse plays tailwind-merge, see below |
| src/scan.ts | src/scan.rs | direct port, plus rayon: files are judged in parallel |
| src/css.ts | src/css.rs | direct port of the judging logic, pure like the original |
| src/css-node.ts | src/bridge.rs + bridge/dump-asts.mjs | see below |
| src/cli.ts | src/main.rs | check, fix, cross, --css, --json, --ack, annotations |
| join, guard, overrule/test | the npm package | they ship in consumers' dev bundles and stay JavaScript |

## The two design calls

**tailwind-fuse instead of tailwind-merge.** The tables side needs a merge engine and tailwind-merge is JavaScript. tailwind-fuse is the Rust port of it, so it slots into the same seam. But its tables lag: it cannot tell ring color from ring width through an arbitrary value, so `focus-visible:ring-ring/50 ... focus-visible:ring-[3px]` (the shadcn focus ring) false-flags, and it lumps v4's `bg-size-[...]` and `bg-position-[...]` together. It also only parses the v3 leading `!`, so the oracle rewrites `font-normal!` to `!font-normal` before judging to keep important and normal classes out of each other's way. None of this is fixable here without forking the crate. It is the same lesson this tool is built on: name tables drift, and `cross` makes the drift visible. Until the fuse tables catch up, judge with `--css` in CI and treat the bare tables as a quick local pass.

**The stylesheet oracle still compiles with Tailwind itself.** Reimplementing the compiler in Rust would recreate exactly the drift this tool exists to catch. So the judging logic (css.rs) is a pure port and the compiling is one batched `node` call: collect every token the scan will see, hand the batch to bridge/dump-asts.mjs, judge the ASTs in Rust. One subprocess per run, ~100ms. The script resolves @tailwindcss/node from the scanned project first, hopping through @tailwindcss/vite and friends for isolated installs like bun and pnpm, then from the invocation directory as the escape hatch for library packages that rightly declare no tailwind at all.

## Test parity

Every test from the npm package maps here. `bun install` once so the cross test can compile; without it that one test skips.

| v0.3.1 | now |
| --- | --- |
| parse.test.ts, 16 cases | src/parse.rs, all 16 |
| oracle.test.ts, engine behavior | src/oracle.rs, plus the findConflicts cases from guard.test.ts |
| cli.test.ts, scanner and fix | src/scan.rs units + tests/scan.rs, fixed cross-checked against tw_merge |
| css.test.ts, 22 cases | src/css.rs, all judging cases against pregenerated ASTs; the platform-neutrality test lives in src/lib.rs |
| cli-bin.test.ts, binary end to end | tests/cli.rs, including the cross --ack gate against a real Tailwind compile |
| join.test.ts, guard.test.ts, assert.test.ts | runtime/join.test.ts, guard.test.ts, merge-free.test.ts; props and declare-variants suites are newer |

tests/fixtures/asts*.json are candidatesToAst dumps from the tailwindcss in node_modules; `node tests/fixtures/generate.mjs` regenerates them after a bump.

## Numbers

84,300 files (a production monorepo duplicated 100x), warm cache:

- npm CLI (node): 1.52s
- this, single-threaded: 1.15s
- this, rayon: 0.28s

The single-threaded delta is small because the merge engine dominates, not the language. The parallel delta is the actual argument for Rust here, and it cost ten lines.

## Porting notes worth remembering

- The attr regex excludes BOTH quote types from the content on purpose. A Svelte interpolation `{cond ? 'a' : 'b'}` inside a double-quoted attribute always carries the other quote, so the exclusion is what keeps branch-split literals from being judged as one string. Relaxing it produced a false conflict across ternary branches within the hour.
- libuv sorts scandir results, Rust's read_dir does not. The walker sorts entries by name so findings come out in the npm CLI's order and outputs stay diffable.
- Byte indexing is safe everywhere the scanner slices, because every delimiter it looks for is ASCII and an ASCII byte in UTF-8 is always a real character.
- The Oracle trait takes &self, so the token collector in the CLI holds its set behind a Mutex. It was a RefCell until scan_paths went parallel; the compiler rejected it the same minute.

## Prior art

[tailwind-merge](https://github.com/dcastil/tailwind-merge) is the engine this whole idea demotes to a checker, and [tailwind-fuse](https://github.com/gaucho-labs/tailwind-fuse) carries its tables into Rust. Credit where due: the checking is only possible because they wrote the tables.

## License

MIT
