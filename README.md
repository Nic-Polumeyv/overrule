# overrule

Tailwind class conflicts are authoring mistakes. overrule catches them in dev and CI, fixes them in source, and lets you ship none of [tailwind-merge](https://github.com/dcastil/tailwind-merge).

When two classes set the same property, CSS does not care which one comes later in your class attribute. Stylesheet order decides, which is a coin flip you don't control. tailwind-merge fixes this at runtime by re-resolving every class string on every render, on every device. That works, but it ships its group tables and resolver to all your users to clean up strings that never change. And it makes mistakes: it silently deletes custom utilities it mis-classifies (a custom `border-grid` utility pattern-matches as a border color and vanishes the moment a real border color joins it), and dropping one token can take an unrelated one with it (a later `text-xs` removes `leading-snug`, because font size conflicts with line height).

The conflicts themselves are written once, by you. So resolve them once, in source, and use tailwind-merge for what it is actually good at: checking.

## Install

```bash
bun add -d overrule
# or
npm i -D overrule
```

## The guard

Wrap whatever join function builds your class props. In dev it warns the moment any rendered class string contains a conflict. In production it does not exist, and neither does tailwind-merge.

```ts
import { guard, join } from 'overrule';

export const cn = import.meta.env.DEV ? guard(join) : join;
```

```
[overrule] "h-9" conflicts with other classes in "inline-flex h-9 px-2 h-8".
The cascade decides which wins. Make precedence explicit (trailing !) or remove the loser.
```

`join` is included and clsx-compatible (strings, arrays, dictionaries, falsy values). Keep your own join function if you prefer; `guard` wraps anything that returns a class string.

## The test

Variant systems written for tailwind-merge restate properties on purpose: the base says `border-transparent`, the outline variant says `border-border`, and the merge picks the winner. Without the merge, those strings are coin flips. This makes "no combo needs merging" a test:

```ts
import { assertVariantsMergeFree } from 'overrule/test';

assertVariantsMergeFree(buttonVariants, {
	variant: ['default', 'outline', 'ghost'],
	size: ['default', 'sm', 'icon'],
});
```

It throws naming the combo and the exact tokens that would be dropped. Freshly pulled shadcn components fail it until you distribute the contested tokens into the variants. That is the point.

## The CLI

```bash
npx overrule check src/   # report conflicts inside class literals, exit 1 if any
npx overrule fix src/     # rewrite each one to its merged form
```

`fix` writes exactly what tailwind-merge resolves the string to, so the result is pixel-identical to what already rendered. `check` belongs in CI.

The CLI sees one literal at a time. Conflicts that only appear when a caller's classes meet a component's internals exist only at runtime, and that is what the guard is for.

## Making a conflict intentional

Sometimes the caller should win. Say so with Tailwind's important modifier, and every tool here stays quiet, because important and normal classes live in different buckets:

```svelte
<Button class="rounded-full!">
```

One rule worth knowing: when a plain token gets `!`, any responsive sibling that sets the same property needs it too. `text-2xl! md:text-3xl` renders 2xl at every width, because an important plain class beats a normal responsive one. Write `text-2xl! md:text-3xl!`.

## Does it work

overrule came out of removing tailwind-merge from a production monorepo with seven SvelteKit apps: 233 call sites converted with pixel-identical output, roughly 25KB of minified JavaScript dropped per app. The first time the CLI ran against that codebase, after the migration was supposedly done, it found two more real conflicts on pages nobody had rendered in dev.

## Prior art

[cva](https://github.com/joe-bell/cva) ships without merging, and [tailwind-variants](https://github.com/heroui-inc/tailwind-variants) has `twMerge: false`. The off switch was never the hard part. Turning it off safely on a codebase written in merge semantics is, and that is the part this package covers.

## License

MIT
