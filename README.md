# overrule

tailwind-merge as a dev tool, not a dependency.

Somewhere in your bundle right now, tailwind-merge is re-litigating an argument you settled the day you wrote the code: `h-9` or `h-8`? It runs on every render, on every one of your users' devices, and it usually picks the right winner. Usually. It also deletes custom utilities it mis-classifies (a custom `border-grid` utility reads as a border color and silently vanishes when a real one shows up), and it takes innocent bystanders with it (a later `text-xs` removes `leading-snug`, because font size conflicts with line height).

Here's the thing: class conflicts are not a runtime problem. CSS ignores the order of your class attribute, so when two classes set the same property, stylesheet order picks the winner. That is a coin flip, and tailwind-merge exists to rig it. But you wrote the conflict once. Resolve it once, in source, and demote tailwind-merge to the job it is genuinely great at: checking your work.

overrule is the safety net that makes turning the merge off survivable: a dev guard, a test assertion, and a codemod. Production ships none of them.

## Install

```bash
bun add -d overrule
# or
npm i -D overrule
```

## The guard

Wrap whatever function builds your class strings. In dev it warns the moment a rendered string contains a conflict. In production it does not exist, and neither does tailwind-merge.

```ts
import { guard, join } from 'overrule';

export const cn = import.meta.env.DEV ? guard(join) : join;
```

```
[overrule] "h-9" conflicts with other classes in "inline-flex h-9 px-2 h-8".
The cascade decides which wins. Make precedence explicit (trailing !) or remove the loser.
```

The bundled `join` is clsx-compatible, but `guard` wraps anything that returns a class string.

## The test

Variant systems written for tailwind-merge restate properties on purpose: the base says `border-transparent`, the outline variant says `border-border`, and the merge picks the winner. This assertion makes "no combo needs merging" something your test suite enforces:

```ts
import { assertVariantsMergeFree } from 'overrule/test';

assertVariantsMergeFree(buttonVariants, {
	variant: ['default', 'outline', 'ghost'],
	size: ['default', 'sm', 'icon'],
});
```

Failures name the combo and the exact tokens that would be dropped. Freshly pulled shadcn components fail until you distribute the contested tokens into the variants. That is the point.

## The CLI

```bash
npx overrule check src/   # report conflicts inside class literals, exit 1 if any
npx overrule fix src/     # rewrite each one to its merged form
```

`fix` writes exactly what tailwind-merge already resolved the string to, so it cannot change a pixel. `check` belongs in CI. The CLI sees one literal at a time; conflicts between a caller and a component's internals only exist at runtime, which is what the guard is for.

## The tokenizer

The checks are built on a small tokenizer, exported as `overrule/parse`. It splits variants on top-level colons, handles importance in both syntaxes, keeps arbitrary values intact through nested brackets and quotes, and order-normalizes variants into a bucket key. Two tokens can only conflict when their buckets match.

```ts
import { parse } from 'overrule/parse';

parse('md:hover:p-4!');
// {
//   raw: 'md:hover:p-4!',
//   variants: ['md', 'hover'],
//   bucket: 'hover:md!',
//   base: 'p-4',
//   important: true,
// }
```

It never guesses what a utility means. That job belongs to the oracle, and the stylesheet-derived oracle on the roadmap builds on these buckets.

## When the caller should win

The component says `rounded-md`. You say:

```svelte
<Button class="rounded-full!" />
```

Overruled. Tailwind's important modifier is native, deterministic, and invisible to every check here, because important and normal classes never conflict. One rule to keep in your pocket: when a plain token gets `!`, responsive siblings on the same property need it too. `text-2xl! md:text-3xl` renders 2xl at every width; write `text-2xl! md:text-3xl!`.

## Does it work

overrule came out of deleting tailwind-merge from a production monorepo: seven SvelteKit apps, 233 call sites converted with pixel-identical output, roughly 25KB of minified JavaScript dropped per app. The first time the CLI ran against that codebase, after the migration was supposedly done, it caught two more conflicts on pages nobody had rendered in dev.

## Prior art

[cva](https://github.com/joe-bell/cva) ships without merging, and [tailwind-variants](https://github.com/heroui-inc/tailwind-variants) has `twMerge: false`. The off switch was never the hard part. Surviving it is.

## License

MIT
