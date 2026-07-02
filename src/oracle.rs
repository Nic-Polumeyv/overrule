//! The conflict oracle seam. An oracle takes a class string and returns the
//! tokens that lose; an empty vec means no token conflicts with another. The
//! trait exists so the stylesheet-derived oracle can replace the name-based
//! tables, same seam as the npm package.

use rustc_hash::FxHashSet;

/// Decides which tokens in a class string lose to a later token.
pub trait Oracle {
    /// The losing tokens, deduplicated, in first-appearance order.
    fn losers(&self, classes: &str) -> Vec<String>;
}

/// Any closure with the right shape is an oracle, so tests can inject fakes
/// without ceremony.
impl<F: Fn(&str) -> Vec<String>> Oracle for F {
    fn losers(&self, classes: &str) -> Vec<String> {
        self(classes)
    }
}

/// The default oracle. tailwind-fuse's group tables (a Rust port of
/// tailwind-merge's) decide which tokens survive; anything they would remove
/// is a conflict. Duplicates are not conflicts.
///
/// tailwind-fuse can drift from tailwind-merge proper, which can drift from
/// what your stylesheet does. That is not a reason to reimplement either: it
/// is what `cross` exists to catch.
pub struct TwFuseOracle;

impl Oracle for TwFuseOracle {
    fn losers(&self, classes: &str) -> Vec<String> {
        // tailwind-fuse 0.3.2 misfiles a family of v4 utilities; `patch_for`
        // names each one. A misfiled token would contest a group it does not
        // belong to, so every token the table claims is pulled from the fuse
        // pass and rejudged against its true group in a synthetic pass. The
        // substring guard keeps literals without a patched namespace on the
        // untouched fast path.
        if !MARKERS.iter().any(|marker| classes.contains(marker)) {
            return judge(classes);
        }
        let tokens: Vec<&str> = classes.split_whitespace().collect();
        let parsed: Vec<crate::parse::Parsed> = tokens
            .iter()
            .map(|token| crate::parse::parse(token))
            .collect();
        let patches: Vec<Option<Patch>> =
            parsed.iter().map(|style| patch_for(&style.base)).collect();
        if patches.iter().all(Option::is_none) {
            return judge(classes);
        }
        // The fuse pass judges the unclaimed tokens as before. Ghosts stay in
        // it too: their own verdicts belong to the fuse tables, they only
        // project defeats into the synthetic pass.
        let mut rest = String::new();
        for (token, patch) in tokens.iter().zip(&patches) {
            if patch.as_ref().is_none_or(|patch| patch.ghost) {
                if !rest.is_empty() {
                    rest.push(' ');
                }
                rest.push_str(token);
            }
        }
        let mut lost: FxHashSet<String> = judge(&rest).into_iter().collect();
        // The synthetic pass replays tailwind-merge's algorithm on the claimed
        // tokens: right to left, a kept token closes its own group and the
        // groups it conquers for its variant bucket, and a token whose group is
        // already closed loses and closes nothing. A later duplicate keeps the
        // same spelling alive, so duplicates are not conflicts, same as the
        // fuse pass. The raw variant list mirrors fuse's collision identity, so
        // the transition-behavior entry judges exactly as the dedicated pass it
        // replaces did.
        let mut closed: FxHashSet<(&[String], bool, &str)> = FxHashSet::default();
        let mut survivors: FxHashSet<&str> = FxHashSet::default();
        let mut contested: Vec<&str> = Vec::new();
        for ((token, style), patch) in tokens.iter().zip(&parsed).zip(&patches).rev() {
            let Some(patch) = patch else { continue };
            if closed.contains(&(style.variants.as_slice(), style.important, patch.group)) {
                if !patch.ghost {
                    contested.push(token);
                }
                continue;
            }
            survivors.insert(token);
            closed.insert((style.variants.as_slice(), style.important, patch.group));
            for conquered in patch.conquers {
                closed.insert((style.variants.as_slice(), style.important, conquered));
            }
        }
        for token in contested {
            if !survivors.contains(token) {
                lost.insert(token.to_string());
            }
        }
        let mut seen: FxHashSet<&str> = FxHashSet::default();
        tokens
            .iter()
            .copied()
            .filter(|token| seen.insert(*token) && lost.contains(*token))
            .map(str::to_string)
            .collect()
    }
}

/// One cheap screen per patched namespace; a literal without any of these
/// cannot contain a token `patch_for` claims.
const MARKERS: &[&str] = &[
    "transition-discrete",
    "transition-normal",
    "ring",
    "outline-",
    "bg-",
    "font-",
    "text-shadow-",
    "overflow-",
];

/// A synthetic collision group for a token class the fuse tables misfile.
/// `conquers` mirrors tailwind-merge's conflictingClassGroups: a kept token of
/// this group also defeats earlier tokens of those groups. A ghost is filed
/// correctly by fuse and keeps its own verdicts there; it joins the synthetic
/// pass only because one of its conquests lives here.
struct Patch {
    group: &'static str,
    conquers: &'static [&'static str],
    ghost: bool,
}

impl Patch {
    const fn of(group: &'static str) -> Option<Patch> {
        Some(Patch {
            group,
            conquers: &[],
            ghost: false,
        })
    }
}

/// The false-positive table, verified token by token against tailwind-merge
/// 3.6.0. Each entry claims the whole true group, not just the misfiled
/// spellings, so within-group conflicts survive the pull. Paren shorthand
/// values stay unclaimed everywhere: fuse cannot parse them, so they never
/// contest anything and cannot false-flag.
fn patch_for(base: &str) -> Option<Patch> {
    // fuse routes the v4 transition-behavior utilities through its
    // `transition` catch-all to transition-property.
    if base == "transition-discrete" || base == "transition-normal" {
        return Patch::of("transition-behavior");
    }
    // fuse lumps every overflow utility into one group; tailwind-merge keeps
    // overflow-x and overflow-y apart, and only a later plain overflow defeats
    // them. line-clamp defeats plain overflow in both engines, so with plain
    // overflow judged here, that defeat has to follow it in.
    if let Some(value) = base.strip_prefix("overflow-x-") {
        return OVERFLOWS.contains(&value).then_some(Patch {
            group: "overflow-x",
            conquers: &[],
            ghost: false,
        });
    }
    if let Some(value) = base.strip_prefix("overflow-y-") {
        return OVERFLOWS.contains(&value).then_some(Patch {
            group: "overflow-y",
            conquers: &[],
            ghost: false,
        });
    }
    if let Some(value) = base.strip_prefix("overflow-") {
        return OVERFLOWS.contains(&value).then_some(Patch {
            group: "overflow",
            conquers: &["overflow-x", "overflow-y"],
            ghost: false,
        });
    }
    if let Some(value) = base.strip_prefix("line-clamp-") {
        if is_number(value) || value == "none" || arbitrary(value).is_some() {
            return Some(Patch {
                group: "line-clamp",
                conquers: &["overflow"],
                ghost: true,
            });
        }
        return None;
    }
    // fuse only reads integer ring widths; bare `ring` and arbitrary values
    // fall through to ring-color. tailwind-merge: bare, numeric, and
    // length-valued arbitrary rings are widths, only color-valued ones are
    // colors.
    if base == "ring" {
        return Patch::of("ring-width");
    }
    if let Some(value) = base.strip_prefix("ring-") {
        if is_number(value) {
            return Patch::of("ring-width");
        }
        if arbitrary(value).is_some_and(is_length) {
            return Patch::of("ring-width");
        }
        return None;
    }
    // outline-hidden (v4) falls through fuse's style list to outline-color.
    // Bare `outline` is outline-width to tailwind-merge, not style, so it
    // stays with the fuse tables.
    if let Some(value) = base.strip_prefix("outline-") {
        if matches!(
            value,
            "solid" | "dashed" | "dotted" | "double" | "none" | "hidden"
        ) {
            return Patch::of("outline-style");
        }
        return None;
    }
    if let Some(value) = base.strip_prefix("bg-") {
        return bg_patch(value);
    }
    // v4 font-stretch reads as a weight to fuse. An unknown stretch value is a
    // family name to tailwind-merge and falls through to the family entry.
    if let Some(value) = base.strip_prefix("font-stretch-")
        && (FONT_STRETCHES.contains(&value) || is_percent(value) || arbitrary(value).is_some())
    {
        return Patch::of("font-stretch");
    }
    // fuse files every font-* it does not know as a weight; tailwind-merge
    // reserves weights for the named scale and unlabeled arbitrary values,
    // everything else is a font family. font-features-* is neither and has no
    // fuse group to repair; it stays unclaimed.
    if let Some(value) = base.strip_prefix("font-") {
        if FONT_WEIGHTS.contains(&value) {
            return None;
        }
        if let Some(content) = arbitrary(value) {
            return match label_of(content) {
                Some("family-name") => Patch::of("font-family"),
                _ => None,
            };
        }
        if value.starts_with('(') || value.starts_with("features-") {
            return None;
        }
        return Patch::of("font-family");
    }
    // text-shadow-* (v4.1) reads as text-color to fuse. tailwind-merge splits
    // it further: named sizes and shadow-valued arbitraries are text-shadow,
    // the rest are text-shadow colors.
    if let Some(value) = base.strip_prefix("text-shadow-") {
        if value == "none" || is_tshirt_size(value) {
            return Patch::of("text-shadow");
        }
        if let Some(content) = arbitrary(value) {
            return match label_of(content) {
                Some("shadow") => Patch::of("text-shadow"),
                Some(_) => Patch::of("text-shadow-color"),
                None if is_shadow(content) => Patch::of("text-shadow"),
                None => Patch::of("text-shadow-color"),
            };
        }
        if value.starts_with('(') {
            return None;
        }
        return Patch::of("text-shadow-color");
    }
    None
}

/// tailwind-merge's background groups for the spellings fuse misfiles as
/// bg-color: v4 gradient syntax and the size and position forms. The named
/// sizes and positions come along so the arbitrary values still contest them.
fn bg_patch(value: &str) -> Option<Patch> {
    if value == "none" {
        return Patch::of("background-image");
    }
    if let Some(rest) = value.strip_prefix("linear-") {
        if arbitrary(rest).is_some() {
            return Patch::of("background-image");
        }
        let rest = strip_modifier(rest);
        if let Some(direction) = rest.strip_prefix("to-")
            && matches!(direction, "t" | "tr" | "r" | "br" | "b" | "bl" | "l" | "tl")
        {
            return Patch::of("background-image");
        }
        if is_integer(rest) {
            return Patch::of("background-image");
        }
        return None;
    }
    // Bare bg-radial is a gradient; bare bg-conic reads as a color even to
    // tailwind-merge, so it stays with the fuse tables.
    if strip_modifier(value) == "radial" {
        return Patch::of("background-image");
    }
    if let Some(rest) = value.strip_prefix("radial-") {
        if arbitrary(rest).is_some() {
            return Patch::of("background-image");
        }
        return None;
    }
    if let Some(rest) = value.strip_prefix("conic-") {
        if arbitrary(rest).is_some() || is_integer(strip_modifier(rest)) {
            return Patch::of("background-image");
        }
        return None;
    }
    if matches!(value, "auto" | "cover" | "contain") {
        return Patch::of("background-size");
    }
    if let Some(rest) = value.strip_prefix("size-") {
        if arbitrary(rest).is_some() {
            return Patch::of("background-size");
        }
        return None;
    }
    if BG_POSITIONS.contains(&value) {
        return Patch::of("background-position");
    }
    if let Some(rest) = value.strip_prefix("position-") {
        if arbitrary(rest).is_some() {
            return Patch::of("background-position");
        }
        return None;
    }
    if let Some(content) = arbitrary(value) {
        return match label_of(content) {
            Some("image" | "url") => Patch::of("background-image"),
            Some("length" | "size" | "bg-size") => Patch::of("background-size"),
            Some("position" | "percentage") => Patch::of("background-position"),
            None if is_image(content) => Patch::of("background-image"),
            _ => None,
        };
    }
    None
}

const OVERFLOWS: &[&str] = &["auto", "hidden", "clip", "visible", "scroll"];

const FONT_WEIGHTS: &[&str] = &[
    "thin",
    "extralight",
    "light",
    "normal",
    "medium",
    "semibold",
    "bold",
    "extrabold",
    "black",
];

const FONT_STRETCHES: &[&str] = &[
    "ultra-condensed",
    "extra-condensed",
    "condensed",
    "semi-condensed",
    "normal",
    "semi-expanded",
    "expanded",
    "extra-expanded",
    "ultra-expanded",
];

/// tailwind-merge's position scale, v4.1 names and their deprecated
/// reversed spellings.
const BG_POSITIONS: &[&str] = &[
    "center",
    "top",
    "bottom",
    "left",
    "right",
    "top-left",
    "left-top",
    "top-right",
    "right-top",
    "bottom-right",
    "right-bottom",
    "bottom-left",
    "left-bottom",
];

/// The bracketed content of an arbitrary value, `[3px]` to `3px`.
fn arbitrary(value: &str) -> Option<&str> {
    value.strip_prefix('[')?.strip_suffix(']')
}

/// The `length` in `length:3px`. tailwind-merge labels are word characters
/// and dashes before the first colon; anything else before it means the colon
/// belongs to the value.
fn label_of(content: &str) -> Option<&str> {
    let (label, _) = content.split_once(':')?;
    let valid = !label.is_empty()
        && label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
    valid.then_some(label)
}

/// `to-r/oklch` to `to-r`: tailwind-merge classifies with the slash modifier
/// stripped. Only sound on non-arbitrary values, which cannot carry a slash
/// inside brackets.
fn strip_modifier(value: &str) -> &str {
    value.split_once('/').map_or(value, |(head, _)| head)
}

/// Digits and at most one dot, tailwind-merge's isNumber minus exponents.
fn is_number(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && value.parse::<f64>().is_ok()
}

fn is_integer(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn is_percent(value: &str) -> bool {
    value.strip_suffix('%').is_some_and(is_number)
}

/// An optional number then xs, sm, md, lg, or xl, tailwind-merge's t-shirt
/// test.
fn is_tshirt_size(value: &str) -> bool {
    ["xs", "sm", "md", "lg", "xl"].iter().any(|unit| {
        value
            .strip_suffix(unit)
            .is_some_and(|head| head.is_empty() || is_number(head))
    })
}

/// Mirrors tailwind-merge's arbitrary length test: a `length:` label, a zero,
/// a calc-family call, or a number with a length unit somewhere in the value,
/// provided the value is not a color function.
fn is_length(content: &str) -> bool {
    if let Some(label) = label_of(content) {
        return label == "length";
    }
    if content == "0" {
        return true;
    }
    if is_color_function(content) {
        return false;
    }
    if ["calc(", "min(", "max(", "clamp("]
        .iter()
        .any(|function| content.contains(function))
    {
        return true;
    }
    let bytes = content.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            if starts_with_length_unit(&content[i..]) {
                return true;
            }
        } else {
            i += 1;
        }
    }
    false
}

fn starts_with_length_unit(rest: &str) -> bool {
    const PLAIN: &[&str] = &[
        "%", "px", "rem", "em", "pt", "pc", "in", "cm", "mm", "cap", "ch", "ex", "rlh", "lh",
    ];
    if PLAIN.iter().any(|unit| rest.starts_with(unit)) {
        return true;
    }
    let viewport = rest.strip_prefix(['s', 'd', 'l']).unwrap_or(rest);
    if let Some(axis) = viewport.strip_prefix('v') {
        return ["min", "max", "h", "w", "i", "b"]
            .iter()
            .any(|suffix| axis.starts_with(suffix));
    }
    if let Some(axis) = rest.strip_prefix("cq") {
        return ["min", "max", "w", "h", "i", "b"]
            .iter()
            .any(|suffix| axis.starts_with(suffix));
    }
    false
}

fn is_color_function(content: &str) -> bool {
    const FUNCTIONS: &[&str] = &[
        "rgba(",
        "rgb(",
        "hsla(",
        "hsl(",
        "hwb(",
        "oklab(",
        "oklch(",
        "lab(",
        "lch(",
        "color-mix(",
    ];
    FUNCTIONS
        .iter()
        .any(|function| content.starts_with(function))
}

/// Mirrors tailwind-merge's shadow test: two leading offsets separated by an
/// underscore, each a zero or a number with a unit, optionally inset.
fn is_shadow(content: &str) -> bool {
    let Some(rest) = shadow_offset(content.strip_prefix("inset_").unwrap_or(content)) else {
        return false;
    };
    let Some(rest) = rest.strip_prefix('_') else {
        return false;
    };
    shadow_offset(rest).is_some()
}

fn shadow_offset(value: &str) -> Option<&str> {
    let value = value.strip_prefix('-').unwrap_or(value);
    let digits = value
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(value.len());
    let (number, rest) = value.split_at(digits);
    if !number.bytes().any(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let unit = rest
        .find(|c: char| !c.is_ascii_lowercase())
        .unwrap_or(rest.len());
    if unit > 0 {
        return Some(&rest[unit..]);
    }
    (number == "0").then_some(rest)
}

fn is_image(content: &str) -> bool {
    const FUNCTIONS: &[&str] = &[
        "url(",
        "image(",
        "image-set(",
        "cross-fade(",
        "element(",
        "linear-gradient(",
        "radial-gradient(",
        "conic-gradient(",
        "repeating-linear-gradient(",
        "repeating-radial-gradient(",
        "repeating-conic-gradient(",
    ];
    FUNCTIONS
        .iter()
        .any(|function| content.starts_with(function))
}

/// One pass of tailwind-fuse, returning the tokens it would remove, deduplicated
/// and in first-appearance order.
///
/// tailwind-fuse 0.3.2 only parses the v3 leading-! position, so a v4 trailing !
/// reads as a plain class and wrongly contests its normal siblings; its font-size
/// test also misses `text-base` with a line-height modifier. Rewrite each token
/// to the spelling fuse parses, judge in that space, and report the originals.
/// Most literals have neither shape, and that case needs no parsing and no
/// rewrite buffer, just the merge itself.
fn judge(classes: &str) -> Vec<String> {
    if !classes.contains('!') && !classes.contains("text-base/") {
        let merged = tailwind_fuse::merge::tw_merge(classes);
        let kept: FxHashSet<&str> = merged.split(' ').collect();
        let mut seen = FxHashSet::default();
        return classes
            .split_whitespace()
            .filter(|token| seen.insert(*token) && !kept.contains(token))
            .map(str::to_string)
            .collect();
    }
    let tokens: Vec<&str> = classes.split_whitespace().collect();
    let rewritten: Vec<String> = tokens.iter().map(|token| fuse_spelling(token)).collect();
    let merged = tailwind_fuse::merge::tw_merge(rewritten.join(" "));
    let kept: FxHashSet<&str> = merged.split(' ').collect();
    let mut seen = FxHashSet::default();
    tokens
        .iter()
        .zip(&rewritten)
        .filter(|(token, rewrite)| seen.insert(**token) && !kept.contains(rewrite.as_str()))
        .map(|(token, _)| token.to_string())
        .collect()
}

/// Memoizes any oracle. A verdict is a pure function of the class string,
/// so judging the same literal twice is wasted work, and component-heavy
/// codebases repeat literals constantly (every copy of a shadcn button is
/// the same strings again). RwLock over a map: hits take the read lock,
/// which parallel scan threads share without contention.
pub struct Memo<O> {
    inner: O,
    cache: std::sync::RwLock<rustc_hash::FxHashMap<String, Vec<String>>>,
}

impl<O: Oracle> Memo<O> {
    pub fn new(inner: O) -> Self {
        Self {
            inner,
            cache: std::sync::RwLock::new(rustc_hash::FxHashMap::default()),
        }
    }
}

impl<O: Oracle> Oracle for Memo<O> {
    fn losers(&self, classes: &str) -> Vec<String> {
        if let Some(hit) = self
            .cache
            .read()
            .expect("no panics under the lock")
            .get(classes)
        {
            return hit.clone();
        }
        let verdict = self.inner.losers(classes);
        self.cache
            .write()
            .expect("no panics under the lock")
            .insert(classes.to_string(), verdict.clone());
        verdict
    }
}

/// The spelling tailwind-fuse parses, or the token unchanged. Two rewrites
/// share the seam. `font-normal!` becomes `!font-normal`, variants kept in
/// front: the v3 position is the only one fuse understands, and importance
/// must stay visible to it so important and normal classes never contest.
/// `text-base/7` becomes `text-smbase/7`: fuse's font-size test knows `base`
/// but not `base` with a line-height modifier, which otherwise reads as
/// text-color; the sm prefix files the respelling under font-size, and no
/// real utility spells smbase, so distinct tokens stay distinct.
fn fuse_spelling(token: &str) -> String {
    let parsed = crate::parse::parse(token);
    let respelled = parsed
        .base
        .strip_prefix("text-base/")
        .map(|modifier| format!("text-smbase/{modifier}"));
    if respelled.is_none() && !(parsed.important && token.ends_with('!')) {
        return token.to_string();
    }
    let base = respelled.as_deref().unwrap_or(&parsed.base);
    let mut out = String::with_capacity(token.len() + 2);
    for variant in &parsed.variants {
        out.push_str(variant);
        out.push(':');
    }
    if parsed.important {
        out.push('!');
    }
    out.push_str(base);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_default_behavior() {
        let oracle = TwFuseOracle;
        assert_eq!(oracle.losers("h-9 px-4 h-8"), ["h-9"]);
        assert_eq!(oracle.losers("h-8 px-4 h-8"), Vec::<String>::new());
        assert_eq!(
            oracle.losers("font-medium font-normal!"),
            Vec::<String>::new()
        );
        let dropped = oracle.losers("text-sm leading-snug text-xs");
        assert!(
            dropped.contains(&"text-sm".to_string()),
            "dropped: {dropped:?}"
        );
        assert!(
            dropped.contains(&"leading-snug".to_string()),
            "dropped: {dropped:?}"
        );
    }

    #[test]
    fn different_modifier_buckets_do_not_conflict() {
        let oracle = TwFuseOracle;
        assert_eq!(
            oracle.losers("inline-flex max-lg:hidden"),
            Vec::<String>::new()
        );
        assert_eq!(oracle.losers("p-4 sm:p-6 hover:p-8"), Vec::<String>::new());
    }

    #[test]
    fn same_modifier_bucket_conflicts() {
        let oracle = TwFuseOracle;
        assert_eq!(oracle.losers("sm:p-4 sm:p-6"), ["sm:p-4"]);
    }

    #[test]
    fn transition_behavior_is_not_transition_property() {
        let oracle = TwFuseOracle;
        // a behavior token never knocks out a transition-property sibling
        // (fuse 0.3.2 would, lacking the transition-behavior group)
        assert_eq!(
            oracle.losers("transition-[opacity,translate,display,overlay] transition-discrete"),
            Vec::<String>::new()
        );
        assert_eq!(
            oracle.losers("transition-all transition-discrete"),
            Vec::<String>::new()
        );
        assert_eq!(
            oracle.losers("transition-discrete transition-colors"),
            Vec::<String>::new()
        );
        // two behavior tokens still conflict, later wins
        assert_eq!(
            oracle.losers("transition-discrete transition-normal"),
            ["transition-discrete"]
        );
        // transition-property tokens still conflict among themselves
        assert_eq!(
            oracle.losers("transition-all transition-discrete transition-colors"),
            ["transition-all"]
        );
        // variants keep behavior tokens in their own buckets
        assert_eq!(
            oracle.losers("hover:transition-discrete transition-discrete"),
            Vec::<String>::new()
        );
    }

    // Every verdict in the false-positive tests below was taken from
    // tailwind-merge 3.6.0 itself: bun -e "import { twMerge } from
    // 'tailwind-merge'; ..." with the same class string.

    #[test]
    fn arbitrary_ring_lengths_are_widths_not_colors() {
        let oracle = TwFuseOracle;
        // the shadcn focus ring: width never contests color
        assert!(oracle.losers("ring-ring/50 ring-[3px]").is_empty());
        assert!(
            oracle
                .losers("focus-visible:ring-ring/50 focus-visible:ring-[3px]")
                .is_empty()
        );
        assert!(oracle.losers("ring-[#fff] ring-[3px]").is_empty());
        assert!(oracle.losers("ring ring-red-500").is_empty());
        assert!(oracle.losers("ring-inset ring-[3px]").is_empty());
        assert!(oracle.losers("ring-offset-2 ring-[3px]").is_empty());
        // widths still conflict among themselves
        assert_eq!(oracle.losers("ring-[3px] ring-2"), ["ring-[3px]"]);
        assert_eq!(oracle.losers("ring-[0.5rem] ring-4"), ["ring-[0.5rem]"]);
        assert_eq!(oracle.losers("ring-[3px] ring-[5px]"), ["ring-[3px]"]);
        assert_eq!(oracle.losers("ring ring-[3px]"), ["ring"]);
        assert_eq!(
            oracle.losers("ring-[length:3px] ring-2"),
            ["ring-[length:3px]"]
        );
        // and colors among themselves
        assert_eq!(oracle.losers("ring-[#fff] ring-red-500"), ["ring-[#fff]"]);
    }

    #[test]
    fn outline_hidden_is_outline_style_not_color() {
        let oracle = TwFuseOracle;
        assert!(oracle.losers("outline-hidden outline-red-500").is_empty());
        assert!(oracle.losers("outline-hidden outline-2").is_empty());
        // bare outline is a width to tailwind-merge, not a style
        assert!(oracle.losers("outline outline-dashed").is_empty());
        // styles still conflict among themselves
        assert_eq!(
            oracle.losers("outline-hidden outline-dashed"),
            ["outline-hidden"]
        );
        assert_eq!(
            oracle.losers("outline-none outline-hidden"),
            ["outline-none"]
        );
        assert_eq!(
            oracle.losers("outline-solid outline-hidden"),
            ["outline-solid"]
        );
    }

    #[test]
    fn v4_backgrounds_are_not_background_color() {
        let oracle = TwFuseOracle;
        assert!(oracle.losers("bg-linear-to-r bg-red-500").is_empty());
        assert!(oracle.losers("bg-conic-180 bg-red-500").is_empty());
        assert!(oracle.losers("bg-size-[auto_100px] bg-red-500").is_empty());
        assert!(
            oracle
                .losers("bg-position-[center_top_1rem] bg-red-500")
                .is_empty()
        );
        assert!(oracle.losers("bg-size-[a] bg-position-[b]").is_empty());
        // bare bg-conic is a color even to tailwind-merge; bare bg-radial is a
        // gradient
        assert!(oracle.losers("bg-radial bg-conic").is_empty());
        assert_eq!(oracle.losers("bg-conic bg-red-500"), ["bg-conic"]);
        // gradients still conflict among themselves and with bg-none
        assert_eq!(
            oracle.losers("bg-linear-to-r bg-linear-to-t"),
            ["bg-linear-to-r"]
        );
        assert_eq!(
            oracle.losers("hover:bg-linear-to-r/oklch hover:bg-linear-to-t"),
            ["hover:bg-linear-to-r/oklch"]
        );
        assert_eq!(
            oracle.losers("bg-linear-to-r bg-radial"),
            ["bg-linear-to-r"]
        );
        assert_eq!(oracle.losers("bg-conic-180 bg-linear-45"), ["bg-conic-180"]);
        assert_eq!(oracle.losers("bg-linear-to-r bg-none"), ["bg-linear-to-r"]);
        assert_eq!(oracle.losers("bg-none bg-[url(/x.png)]"), ["bg-none"]);
        // sizes and positions still conflict with their named forms
        assert_eq!(
            oracle.losers("bg-size-[auto_100px] bg-size-[50%]"),
            ["bg-size-[auto_100px]"]
        );
        assert_eq!(
            oracle.losers("bg-size-[auto_100px] bg-cover"),
            ["bg-size-[auto_100px]"]
        );
        assert_eq!(
            oracle.losers("bg-[length:200px_100px] bg-cover"),
            ["bg-[length:200px_100px]"]
        );
        assert_eq!(
            oracle.losers("bg-position-[center_top_1rem] bg-center"),
            ["bg-position-[center_top_1rem]"]
        );
    }

    #[test]
    fn font_stretch_and_families_are_not_weights() {
        let oracle = TwFuseOracle;
        assert!(oracle.losers("font-stretch-condensed font-bold").is_empty());
        assert!(oracle.losers("font-stretch-[66%] font-sans").is_empty());
        assert!(oracle.losers("font-display font-bold").is_empty());
        assert!(oracle.losers("font-sans font-bold").is_empty());
        assert!(oracle.losers("font-[600] font-sans").is_empty());
        // stretches still conflict among themselves
        assert_eq!(
            oracle.losers("font-stretch-condensed font-stretch-expanded"),
            ["font-stretch-condensed"]
        );
        assert_eq!(
            oracle.losers("font-stretch-50% font-stretch-condensed"),
            ["font-stretch-50%"]
        );
        // families among themselves, custom ones included
        assert_eq!(oracle.losers("font-display font-sans"), ["font-display"]);
        assert_eq!(
            oracle.losers("font-[family-name:var(--x)] font-sans"),
            ["font-[family-name:var(--x)]"]
        );
        // and weights among themselves
        assert_eq!(oracle.losers("font-bold font-medium"), ["font-bold"]);
        assert_eq!(oracle.losers("font-[600] font-bold"), ["font-[600]"]);
    }

    #[test]
    fn text_shadow_is_not_text_color() {
        let oracle = TwFuseOracle;
        assert!(oracle.losers("text-shadow-md text-red-500").is_empty());
        assert!(oracle.losers("text-shadow-md text-sm").is_empty());
        assert!(
            oracle
                .losers("text-shadow-red-500 text-blue-500")
                .is_empty()
        );
        // shadow colors are their own group, apart from shadow sizes
        assert!(
            oracle
                .losers("text-shadow-red-500 text-shadow-md")
                .is_empty()
        );
        assert!(oracle.losers("text-shadow-md! text-shadow-lg").is_empty());
        // shadows still conflict among themselves, importance and variants kept
        assert_eq!(
            oracle.losers("text-shadow-md text-shadow-lg"),
            ["text-shadow-md"]
        );
        assert_eq!(
            oracle.losers("hover:text-shadow-md! hover:text-shadow-lg!"),
            ["hover:text-shadow-md!"]
        );
        assert_eq!(
            oracle.losers("text-shadow-none text-shadow-2xs"),
            ["text-shadow-none"]
        );
        assert_eq!(
            oracle.losers("text-shadow-red-500 text-shadow-blue-500"),
            ["text-shadow-red-500"]
        );
        assert_eq!(
            oracle.losers("text-shadow-[0_1px_0_red] text-shadow-md"),
            ["text-shadow-[0_1px_0_red]"]
        );
    }

    #[test]
    fn font_size_with_line_height_modifier_is_not_text_color() {
        let oracle = TwFuseOracle;
        assert!(oracle.losers("text-base/7 text-red-500").is_empty());
        assert!(oracle.losers("text-base/7 leading-snug").is_empty());
        assert!(oracle.losers("text-base/7 text-base/8!").is_empty());
        // and is a real font-size everywhere else
        assert_eq!(oracle.losers("text-base/7 text-sm"), ["text-base/7"]);
        assert_eq!(oracle.losers("text-sm text-base/7"), ["text-sm"]);
        assert_eq!(oracle.losers("text-base/7 text-base/8"), ["text-base/7"]);
        assert_eq!(
            oracle.losers("md:text-base/7 md:text-sm"),
            ["md:text-base/7"]
        );
        assert_eq!(oracle.losers("leading-snug text-base/7"), ["leading-snug"]);
    }

    #[test]
    fn overflow_axes_are_separate_groups() {
        let oracle = TwFuseOracle;
        assert!(
            oracle
                .losers("overflow-x-hidden overflow-y-auto")
                .is_empty()
        );
        // a plain overflow defeats earlier axes, never later ones
        assert!(oracle.losers("overflow-hidden overflow-x-auto").is_empty());
        assert_eq!(
            oracle.losers("overflow-x-auto overflow-hidden"),
            ["overflow-x-auto"]
        );
        // axes and plain overflow still conflict among themselves
        assert_eq!(
            oracle.losers("overflow-x-hidden overflow-x-auto"),
            ["overflow-x-hidden"]
        );
        assert_eq!(
            oracle.losers("overflow-y-auto overflow-y-scroll"),
            ["overflow-y-auto"]
        );
        assert_eq!(
            oracle.losers("overflow-auto overflow-hidden"),
            ["overflow-auto"]
        );
    }

    #[test]
    fn line_clamp_still_defeats_plain_overflow_only() {
        let oracle = TwFuseOracle;
        assert_eq!(
            oracle.losers("overflow-hidden line-clamp-2"),
            ["overflow-hidden"]
        );
        assert!(oracle.losers("line-clamp-2 overflow-hidden").is_empty());
        assert!(oracle.losers("overflow-x-hidden line-clamp-2").is_empty());
        // a defeated plain overflow defeats nothing itself
        assert_eq!(
            oracle.losers("overflow-x-auto overflow-hidden line-clamp-2"),
            ["overflow-hidden"]
        );
    }

    #[test]
    fn trailing_important_rewrites_keep_variants_in_front() {
        // The rewrite must carry variants through: dropping them would put
        // hover:p-2! in the bare important padding bucket, where it wrongly
        // contests !p-2 or, unimportant, p-4.
        let oracle = TwFuseOracle;
        assert_eq!(oracle.losers("hover:p-2! p-4"), Vec::<String>::new());
        assert_eq!(oracle.losers("!p-2 hover:p-4!"), Vec::<String>::new());
        assert_eq!(oracle.losers("hover:p-2! hover:p-4!"), ["hover:p-2!"]);
    }

    #[test]
    fn memo_judges_each_distinct_literal_once() {
        let calls = std::cell::Cell::new(0);
        let counting = |classes: &str| {
            calls.set(calls.get() + 1);
            classes
                .split_whitespace()
                .filter(|t| *t == "loser")
                .map(str::to_string)
                .collect()
        };
        let memo = Memo::new(counting);
        assert_eq!(memo.losers("a loser"), ["loser"]);
        assert_eq!(memo.losers("a loser"), ["loser"]);
        assert_eq!(memo.losers("clean enough"), Vec::<String>::new());
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn a_closure_is_an_oracle() {
        let fake = |classes: &str| {
            classes
                .split_whitespace()
                .filter(|t| *t == "loser")
                .map(str::to_string)
                .collect()
        };
        assert_eq!(fake.losers("a loser b"), ["loser"]);
        assert_eq!(fake.losers("h-9 h-8"), Vec::<String>::new());
    }
}
