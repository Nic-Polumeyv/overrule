# Migrating off runtime tailwind-merge

The end state: no class string in the codebase needs merging, `cn` is a plain join, and the merge engine runs in dev and CI instead of shipping. This is the order that worked on a seven-app monorepo, 233 call sites, zero visual changes. The order matters.

A shadcn-style codebase is written in merge semantics on purpose. Variant systems restate properties so the merge can pick winners. Callers pass `h-8` against an `h-9` base and expect to win. Turn the merge off first and every one of those spots becomes a stylesheet-order coin flip, with no error anywhere. So the checks come first and the flip comes last.

## 1. Measure

```bash
npx overrule check src/ --css src/app.css
```

Every reported string is a place the runtime merge is currently doing work. `--css` judges with your compiled stylesheet, so custom utilities are known quantities instead of guesses. The count is your migration size.

## 2. Make variants disjoint

A variant config is merge-free when no property is set by both the base and a variant for the same modifier prefix. Contested tokens move out of the base and into every variant that does not override them. Verbose, but the string now means what it says.

Prove it instead of eyeballing it:

```ts
import { assertVariantsMergeFree } from 'overrule/test';
```

Point it at every variant function and keep the test forever. Every freshly pulled shadcn component arrives written in merge semantics and fails it until the overlaps are distributed. `declareVariants` from the root entry replaces cva or tailwind-variants for the common base-plus-axes shape, with no merge engine behind it.

If you want a stronger safety net for this step, capture the old `cn` output for every variant combination first, then assert the rewrite matches the baseline exactly. The referee being removed certifies the removal.

## 3. Rewrite the call sites

```bash
npx overrule fix src/ --css src/app.css
```

`fix` rewrites each conflicting string to the form the merge would have produced, losers removed. The rewrite target is by definition the string the merge was already producing, so it cannot change a pixel.

## 4. Make intentional overrides explicit

Some call sites conflict on purpose: the caller wants `rounded-full` to beat the component's `rounded-md`. Tailwind already has the native answer, the important modifier. `rounded-full!` wins through CSS itself, deterministically, with zero runtime. Important and normal classes live in different buckets, so the checker stays quiet about them: the precedence is explicit.

One trap. When a plain token gets the `!`, any responsive sibling on the same property needs it too. `text-2xl! md:text-3xl` renders 2xl at every width, because an important plain class beats a normal responsive one. Write `text-2xl! md:text-3xl!`.

## 5. Flip

```bash
npx overrule map src/ --css src/app.css --out conflicts.json
```

```ts
import { join, guard } from 'overrule';
import { createMapOracle } from 'overrule/map';
import map from './conflicts.json';

const cn = import.meta.env.DEV ? guard(join, createMapOracle(map)) : join;
```

`cn` is now a plain join. The guard warns on any new conflict the moment it renders in dev, judging with the map compiled from your own stylesheet. The DEV branch folds away in production and the oracle goes with it.

## 6. Keep the tripwires

The conflicts you find after the migration are the reason the checker exists. Rendered pages are not coverage: a static scan sees the marketing page nobody opened in dev.

- CI: `npx overrule check src/ --css src/app.css` fails the build on any new conflict.
- CI: `npx overrule cross src/ --css src/app.css --ack acks.json` gates on new table-versus-stylesheet disagreements only.
- Editor: the `overrule/eslint` plugin reports conflicts as you type, judging with the same `conflicts.json`, and its fix is the same rewrite as `fix`. See the README.
- Suite: `assertMergeFree` and `assertVariantsMergeFree` from `overrule/test` keep components honest.

Regenerate `conflicts.json` when the stylesheet changes. The map is compiled output, not configuration.
