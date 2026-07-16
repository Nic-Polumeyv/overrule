//! A conflict oracle derived from the compiled stylesheet instead of name
//! tables. tailwind-fuse classifies classes by what they are called; the
//! compiler knows what they do. Each candidate is fed through Tailwind v4's
//! design system and judged by the declarations it actually produces: a token
//! loses only when every declaration it makes is overridden by a later token
//! in the same variant bucket. Custom utilities are first class by
//! construction, and a custom property is a declaration in its own right:
//! leading-* feeds text-*, ring color feeds ring width, and the reader may
//! live in another string on the same element, so setting a variable counts
//! as an effect even when nothing in this string reads it.
//!
//! This module is platform-neutral on purpose, mirroring the npm package: no
//! filesystem, no subprocess, nothing but the compiled candidates you hand
//! it. Compiling them is [`crate::bridge`]'s job, because the compiler is
//! Tailwind itself and Tailwind lives in JavaScript. Reimplementing it here
//! would recreate the drift this tool exists to catch.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::LazyLock;

use serde::Deserialize;

use crate::oracle::Oracle;
use crate::parse::order_normalize;

/// One node of Tailwind's compiled AST, the shape candidatesToAst returns
/// (available since tailwindcss 4.2). Unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct AstNode {
    pub kind: String,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub params: Option<String>,
    #[serde(default)]
    pub property: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub important: Option<bool>,
    #[serde(default)]
    pub nodes: Option<Vec<AstNode>>,
}

/// A flattened declaration. Declarations only contest within a bucket.
#[derive(Debug, Clone)]
struct Decl {
    /// Variant bucket plus importance.
    bucket: String,
    property: String,
}

/// At-rules that register or define things rather than scope declarations.
const NON_SCOPING: &[&str] = &["@property", "@keyframes", "@font-face", "@counter-style"];

fn unescape(selector: &str) -> String {
    let mut out = String::with_capacity(selector.len());
    let mut chars = selector.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        // A hex escape is 1-6 hex digits plus one optional whitespace
        // terminator; CSS spells a leading digit this way, so `.\32 xl\:p-4`
        // must come back as `.2xl:p-4`, not `.32 xl:p-4`.
        if chars.peek().is_some_and(char::is_ascii_hexdigit) {
            let mut code = 0;
            let mut digits = 0;
            while digits < 6 {
                let Some(digit) = chars.peek().and_then(|c| c.to_digit(16)) else {
                    break;
                };
                code = code * 16 + digit;
                digits += 1;
                chars.next();
            }
            if chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
            out.push(char::from_u32(code).unwrap_or(char::REPLACEMENT_CHARACTER));
        } else if let Some(next) = chars.next() {
            out.push(next);
        }
    }
    out
}

struct RawDecl {
    conditions: Vec<String>,
    property: String,
    important: bool,
}

/// Flatten a candidate's AST into declarations tagged with their condition stack.
fn collect(nodes: &[AstNode], conditions: &[String], candidate: &str, out: &mut Vec<RawDecl>) {
    for node in nodes {
        match (node.kind.as_str(), &node.property, &node.nodes) {
            ("declaration", Some(property), _) => out.push(RawDecl {
                conditions: conditions.to_vec(),
                property: property.clone(),
                important: node.important == Some(true),
            }),
            ("rule", _, Some(children)) => {
                let selector = node.selector.as_deref().unwrap_or("");
                let next = if unescape(selector) == format!(".{candidate}") {
                    conditions.to_vec()
                } else {
                    let mut next = conditions.to_vec();
                    next.push(selector.to_string());
                    next
                };
                collect(children, &next, candidate, out);
            }
            ("at-rule", _, Some(children)) => {
                let name = node.name.as_deref().unwrap_or("");
                if NON_SCOPING.contains(&name) {
                    continue;
                }
                let next = if name == "@layer" {
                    conditions.to_vec()
                } else {
                    let mut next = conditions.to_vec();
                    next.push(format!("{name} {}", node.params.as_deref().unwrap_or("")));
                    next
                };
                collect(children, &next, candidate, out);
            }
            (_, _, Some(children)) => collect(children, conditions, candidate, out),
            _ => {}
        }
    }
}

/// Conditions commute when they constrain the same element: media queries and
/// plain pseudo-class or attribute selectors on &. A condition that reaches a
/// different box (a pseudo-element, or any selector with a combinator) makes
/// everything nested inside it apply there, so its position pins the stretch
/// boundaries. Same reasoning as bucket_of in parse.rs, applied to compiled
/// output; `order_normalize` there does the sorting for both.
fn bucket_of(conditions: &[String], important: bool) -> String {
    fn sensitive(condition: &str) -> bool {
        !condition.starts_with('@')
            && (condition.contains("::")
                || condition
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '>' | '+' | '~')))
    }
    let mut bucket = order_normalize(conditions, sensitive, " ");
    if important {
        bucket.push_str(" !");
    }
    bucket
}

/// CSS shorthand coverage: which properties a declaration overrides besides
/// the one it names. This is CSS knowledge, not Tailwind knowledge, so it
/// does not rot with releases. Scoped to what utilities plausibly emit;
/// extend it when dogfooding finds a gap.
static COVERED_BY: LazyLock<HashMap<String, Vec<String>>> = LazyLock::new(|| {
    let mut table: HashMap<String, Vec<String>> = HashMap::new();
    let mut covered = |child: String, parents: &[String]| {
        table.insert(child, parents.to_vec());
    };
    let owned = |parts: &[&str]| parts.iter().map(|s| s.to_string()).collect::<Vec<_>>();

    for boxed in ["padding", "margin", "scroll-padding", "scroll-margin"] {
        for side in ["top", "right", "bottom", "left", "inline", "block"] {
            covered(format!("{boxed}-{side}"), &owned(&[boxed]));
        }
        for axis in ["inline", "block"] {
            covered(
                format!("{boxed}-{axis}-start"),
                &[format!("{boxed}-{axis}"), boxed.to_string()],
            );
            covered(
                format!("{boxed}-{axis}-end"),
                &[format!("{boxed}-{axis}"), boxed.to_string()],
            );
        }
    }
    for side in ["top", "right", "bottom", "left"] {
        covered(side.to_string(), &owned(&["inset"]));
    }
    for axis in ["inline", "block"] {
        covered(format!("inset-{axis}"), &owned(&["inset"]));
        covered(
            format!("inset-{axis}-start"),
            &[format!("inset-{axis}"), "inset".to_string()],
        );
        covered(
            format!("inset-{axis}-end"),
            &[format!("inset-{axis}"), "inset".to_string()],
        );
    }
    for aspect in ["width", "style", "color"] {
        covered(format!("border-{aspect}"), &owned(&["border"]));
    }
    for side in ["top", "right", "bottom", "left", "inline", "block"] {
        covered(format!("border-{side}"), &owned(&["border"]));
        for aspect in ["width", "style", "color"] {
            covered(
                format!("border-{side}-{aspect}"),
                &[
                    format!("border-{side}"),
                    format!("border-{aspect}"),
                    "border".to_string(),
                ],
            );
        }
    }
    // Logical border sides, what border-bs-*/border-be-* emit since v4.2.
    // Coverage stays within the logical family plus the full shorthands,
    // which reset every side in every writing mode; physical and logical
    // never claim each other because that mapping depends on writing mode.
    for axis in ["inline", "block"] {
        for edge in ["start", "end"] {
            covered(
                format!("border-{axis}-{edge}"),
                &[format!("border-{axis}"), "border".to_string()],
            );
            for aspect in ["width", "style", "color"] {
                covered(
                    format!("border-{axis}-{edge}-{aspect}"),
                    &[
                        format!("border-{axis}-{edge}"),
                        format!("border-{axis}-{aspect}"),
                        format!("border-{axis}"),
                        format!("border-{aspect}"),
                        "border".to_string(),
                    ],
                );
            }
        }
    }
    for corner in [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
        "start-start",
        "start-end",
        "end-start",
        "end-end",
    ] {
        covered(
            format!("border-{corner}-radius"),
            &owned(&["border-radius"]),
        );
    }
    covered("row-gap".into(), &owned(&["gap"]));
    covered("column-gap".into(), &owned(&["gap"]));
    covered("container-name".into(), &owned(&["container"]));
    covered("container-type".into(), &owned(&["container"]));
    covered("overflow-x".into(), &owned(&["overflow"]));
    covered("overflow-y".into(), &owned(&["overflow"]));
    covered(
        "overscroll-behavior-x".into(),
        &owned(&["overscroll-behavior"]),
    );
    covered(
        "overscroll-behavior-y".into(),
        &owned(&["overscroll-behavior"]),
    );
    covered("flex-grow".into(), &owned(&["flex"]));
    covered("flex-shrink".into(), &owned(&["flex"]));
    covered("flex-basis".into(), &owned(&["flex"]));
    covered("flex-direction".into(), &owned(&["flex-flow"]));
    covered("flex-wrap".into(), &owned(&["flex-flow"]));
    for longhand in [
        "font-size",
        "line-height",
        "font-weight",
        "font-family",
        "font-style",
        "font-stretch",
        "font-variant",
        // The font shorthand resets this to initial too; font-features-*
        // emits it since v4.2.
        "font-feature-settings",
    ] {
        covered(longhand.into(), &owned(&["font"]));
    }
    // ordinal and friends emit font-variant-numeric, which both the
    // font-variant shorthand and font reset.
    covered(
        "font-variant-numeric".into(),
        &owned(&["font-variant", "font"]),
    );
    for aspect in ["width", "style", "color", "offset"] {
        covered(format!("outline-{aspect}"), &owned(&["outline"]));
    }
    for aspect in ["line", "style", "color", "thickness"] {
        covered(
            format!("text-decoration-{aspect}"),
            &owned(&["text-decoration"]),
        );
    }
    covered("column-width".into(), &owned(&["columns"]));
    covered("column-count".into(), &owned(&["columns"]));
    covered("grid-row-start".into(), &owned(&["grid-row", "grid-area"]));
    covered("grid-row-end".into(), &owned(&["grid-row", "grid-area"]));
    covered(
        "grid-column-start".into(),
        &owned(&["grid-column", "grid-area"]),
    );
    covered(
        "grid-column-end".into(),
        &owned(&["grid-column", "grid-area"]),
    );
    covered("grid-row".into(), &owned(&["grid-area"]));
    covered("grid-column".into(), &owned(&["grid-area"]));
    for longhand in [
        "background-color",
        "background-image",
        "background-position",
        "background-size",
        "background-repeat",
        "background-attachment",
        "background-origin",
        "background-clip",
    ] {
        covered(longhand.into(), &owned(&["background"]));
    }
    for longhand in [
        "transition-property",
        "transition-duration",
        "transition-timing-function",
        "transition-delay",
        "transition-behavior",
    ] {
        covered(longhand.into(), &owned(&["transition"]));
    }
    for longhand in [
        "animation-name",
        "animation-duration",
        "animation-timing-function",
        "animation-delay",
        "animation-iteration-count",
        "animation-direction",
        "animation-fill-mode",
        "animation-play-state",
    ] {
        covered(longhand.into(), &owned(&["animation"]));
    }
    for longhand in ["list-style-type", "list-style-position", "list-style-image"] {
        covered(longhand.into(), &owned(&["list-style"]));
    }
    table
});

/// Whether a later declaration of `winner` overrides an earlier one of `loser`.
fn overrides(winner: &str, loser: &str) -> bool {
    winner == loser
        || COVERED_BY
            .get(loser)
            .is_some_and(|parents| parents.iter().any(|parent| parent == winner))
}

/// None means the compiler produced nothing: not a class in this project.
fn decls_of(candidate: &str, roots: &[AstNode]) -> Option<Vec<Decl>> {
    if roots.is_empty() {
        return None;
    }
    let mut raw = Vec::new();
    collect(roots, &[], candidate, &mut raw);
    Some(
        raw.into_iter()
            .map(|decl| Decl {
                bucket: bucket_of(&decl.conditions, decl.important),
                property: decl.property,
            })
            .collect(),
    )
}

/// The compiled slice of a design system the oracles need: every candidate
/// token mapped to the declarations Tailwind produces for it. Build it once
/// from a batch of ASTs; judging is pure from here on.
#[derive(Debug, Clone, Default)]
pub struct CompiledCandidates {
    decls: HashMap<String, Option<Vec<Decl>>>,
}

impl CompiledCandidates {
    pub fn from_asts(asts: impl IntoIterator<Item = (String, Vec<AstNode>)>) -> Self {
        let decls = asts
            .into_iter()
            .map(|(token, roots)| {
                let decls = decls_of(&token, &roots);
                (token, decls)
            })
            .collect();
        Self { decls }
    }

    /// The conflict map, version 1: a fixed contract with overrule's JS map
    /// oracle, which replays [`CssOracle`]'s dead-token rule from this data
    /// with no compiler at hand. `tokens` holds every token that compiled to
    /// at least one declaration, one group per distinct bucket; the bucket
    /// string is the judge's own (conditions plus importance, sorted the way
    /// `bucket_of` sorts them) and stays opaque to consumers. `covers` is the
    /// inverse of the coverage table, keyed by the winning property. Every
    /// key, group, and list is sorted, so the same project emits
    /// byte-identical maps. Bump `version` on any shape change.
    pub fn conflict_map(&self) -> serde_json::Value {
        let mut winners: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
        for (loser, parents) in COVERED_BY.iter() {
            for winner in parents {
                winners.entry(winner).or_default().insert(loser);
            }
        }
        let mut covers = serde_json::Map::new();
        for (winner, losers) in winners {
            covers.insert(
                winner.to_string(),
                serde_json::Value::from_iter(losers.into_iter().map(str::to_string)),
            );
        }

        let mut names: Vec<&String> = self.decls.keys().collect();
        names.sort_unstable();
        let mut tokens = serde_json::Map::new();
        for name in names {
            let Some(decls) = self.decls[name].as_ref() else {
                continue;
            };
            if decls.is_empty() {
                continue;
            }
            let mut groups: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
            for decl in decls {
                groups
                    .entry(&decl.bucket)
                    .or_default()
                    .insert(&decl.property);
            }
            let entry: Vec<serde_json::Value> = groups
                .into_iter()
                .map(|(bucket, props)| {
                    serde_json::json!({
                        "bucket": bucket,
                        "props": props.into_iter().collect::<Vec<_>>(),
                    })
                })
                .collect();
            tokens.insert(name.clone(), serde_json::Value::Array(entry));
        }

        serde_json::json!({
            "version": 1,
            "covers": covers,
            "tokens": tokens,
        })
    }
}

/// The stylesheet-derived oracle. Tokens the compiler does not recognize, or
/// that were never compiled into the candidate set, are skipped, not reported;
/// [`TypoOracle`] surfaces those.
pub struct CssOracle {
    candidates: CompiledCandidates,
}

impl CssOracle {
    pub fn new(candidates: CompiledCandidates) -> Self {
        Self { candidates }
    }
}

impl Oracle for CssOracle {
    fn losers(&self, classes: &str) -> Vec<String> {
        let raw: Vec<&str> = classes.split_whitespace().collect();
        let mut seen = HashSet::new();
        let tokens: Vec<&str> = raw.iter().copied().filter(|t| seen.insert(*t)).collect();
        let position: HashMap<&str, usize> = tokens
            .iter()
            .map(|token| {
                (
                    *token,
                    raw.iter()
                        .rposition(|t| t == token)
                        .expect("token came from raw"),
                )
            })
            .collect();

        let decls_for = |token: &str| self.candidates.decls.get(token).and_then(Option::as_ref);
        let known: Vec<&str> = tokens
            .iter()
            .copied()
            .filter(|t| decls_for(t).is_some())
            .collect();

        // A declaration is beaten when a later token declares the same or a
        // covering property in the same bucket. Importance is part of the
        // bucket, so important and normal declarations never contest. A token
        // is dead only when every declaration it makes is beaten: an unbeaten
        // custom property is an export, not dead weight, because cva splits
        // strings that only meet at runtime and the reader can sit in any of
        // them. fix removes nothing that could reach a pixel.
        known
            .iter()
            .filter(|token| {
                let decls = decls_for(token).expect("known tokens have declarations");
                if decls.is_empty() {
                    return false;
                }
                decls.iter().all(|decl| {
                    known.iter().any(|other| {
                        position[other] > position[*token]
                            && decls_for(other)
                                .expect("known tokens have declarations")
                                .iter()
                                .any(|own| {
                                    own.bucket == decl.bucket
                                        && overrides(&own.property, &decl.property)
                                })
                    })
                })
            })
            .map(|token| token.to_string())
            .collect()
    }
}

/// An oracle that reports tokens that compile to nothing: not conflicts, not
/// classes either. Typos, usually. Classes defined outside Tailwind land here
/// too, so treat the report as a lead, not a verdict.
pub struct TypoOracle {
    known: HashSet<String>,
}

impl TypoOracle {
    pub fn new(candidates: &CompiledCandidates) -> Self {
        let known = candidates
            .decls
            .iter()
            .filter(|(_, decls)| decls.is_some())
            .map(|(token, _)| token.clone())
            .collect();
        Self { known }
    }
}

impl Oracle for TypoOracle {
    fn losers(&self, classes: &str) -> Vec<String> {
        let mut seen = HashSet::new();
        classes
            .split_whitespace()
            .filter(|token| seen.insert(*token) && !self.known.contains(*token))
            .map(str::to_string)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compiled(fixture: &str) -> CompiledCandidates {
        let asts: HashMap<String, Vec<AstNode>> = serde_json::from_str(fixture).unwrap();
        CompiledCandidates::from_asts(asts)
    }

    fn oracle() -> CssOracle {
        CssOracle::new(compiled(include_str!("../tests/fixtures/asts.json")))
    }

    fn typos() -> TypoOracle {
        TypoOracle::new(&compiled(include_str!("../tests/fixtures/asts.json")))
    }

    fn prefixed() -> CssOracle {
        CssOracle::new(compiled(include_str!(
            "../tests/fixtures/asts-prefixed.json"
        )))
    }

    fn losers(oracle: &impl Oracle, classes: &str) -> Vec<String> {
        oracle.losers(classes)
    }

    #[test]
    fn same_property_in_the_same_bucket_conflicts_last_wins() {
        let o = oracle();
        assert_eq!(losers(&o, "h-9 px-4 h-8"), ["h-9"]);
        assert_eq!(losers(&o, "px-4 px-2 text-sm"), ["px-4"]);
        assert_eq!(losers(&o, "bg-red-500 p-2 bg-blue-500"), ["bg-red-500"]);
    }

    #[test]
    fn duplicates_are_not_conflicts() {
        assert!(losers(&oracle(), "h-8 px-4 h-8").is_empty());
    }

    #[test]
    fn unrelated_tokens_never_conflict() {
        assert!(losers(&oracle(), "flex h-9 items-center rounded-md").is_empty());
    }

    #[test]
    fn important_and_normal_never_conflict_two_importants_do() {
        let o = oracle();
        assert!(losers(&o, "font-medium font-normal!").is_empty());
        assert_eq!(losers(&o, "font-medium! font-normal!"), ["font-medium!"]);
    }

    #[test]
    fn variants_bucket_by_meaning_not_by_spelling_order() {
        let o = oracle();
        assert!(losers(&o, "p-2 md:p-4").is_empty());
        assert_eq!(losers(&o, "md:p-2 md:p-4"), ["md:p-2"]);
        assert_eq!(losers(&o, "hover:md:p-2 md:hover:p-4"), ["hover:md:p-2"]);
    }

    #[test]
    fn pseudo_element_variant_order_styles_different_boxes() {
        let o = oracle();
        assert!(losers(&o, "before:hover:m-1 hover:before:m-2").is_empty());
        assert_eq!(
            losers(&o, "before:focus:underline before:focus:no-underline"),
            ["before:focus:underline"]
        );
        assert!(losers(&o, "before:focus:underline focus:before:no-underline").is_empty());
    }

    #[test]
    fn a_later_shorthand_kills_the_longhand_the_reverse_layers() {
        let o = oracle();
        assert_eq!(losers(&o, "px-2 p-4"), ["px-2"]);
        assert!(losers(&o, "p-4 px-2").is_empty());
        assert_eq!(losers(&o, "scroll-mt-2 scroll-m-4"), ["scroll-mt-2"]);
        assert!(losers(&o, "scroll-m-4 scroll-mt-2").is_empty());
    }

    #[test]
    fn custom_utilities_are_first_class_border_grid_survives_a_border_color() {
        // tailwind-merge misreads border-grid as a border color and deletes it.
        let o = oracle();
        assert!(losers(&o, "border-grid border-red-500").is_empty());
        assert_eq!(losers(&o, "border-red-500 border-grid"), ["border-red-500"]);
    }

    #[test]
    fn v4_composition_through_custom_properties_is_not_a_conflict() {
        // tailwind-merge drops leading-snug after text-xs; the compiled CSS
        // shows text-* reading --tw-leading, so they compose.
        let o = oracle();
        assert!(losers(&o, "leading-snug text-xs").is_empty());
        assert!(losers(&o, "text-xs leading-snug").is_empty());
        assert_eq!(losers(&o, "leading-tight leading-snug"), ["leading-tight"]);
        assert!(losers(&o, "ordinal slashed-zero").is_empty());
    }

    #[test]
    fn an_unbeaten_custom_property_is_an_export_not_dead_weight() {
        // cva splits strings that only meet at runtime: the variant sets the
        // ring color, the base sets the ring width, and the variable lives on
        // the element. Anything the merge tables would kill here is a
        // cross-check conversation, never a fix.
        let o = oracle();
        assert!(losers(&o, "focus-visible:ring-red-500/50 bg-red-500").is_empty());
        assert!(losers(&o, "font-medium [font-weight:900]").is_empty());
        assert!(losers(&o, "translate-x-2 translate-none").is_empty());
        assert!(losers(&o, "ordinal normal-nums").is_empty());
    }

    #[test]
    fn ring_and_shadow_compose_through_the_shared_box_shadow() {
        assert!(losers(&oracle(), "ring-2 shadow-lg").is_empty());
    }

    #[test]
    fn custom_properties_cross_buckets_ring_color_feeds_ring_width() {
        // The shadcn pattern. The color is set under one state, the width
        // under another, and the variable lives on the element, so both
        // apply the moment the states hold together.
        let o = oracle();
        assert!(losers(&o, "ring-red-500/50 focus-visible:ring-[3px]").is_empty());
        assert!(losers(&o, "aria-invalid:ring-red-500/20 focus-visible:ring-[3px]").is_empty());
    }

    #[test]
    fn a_postfix_line_height_kills_an_earlier_text_size_whole() {
        let o = oracle();
        assert_eq!(losers(&o, "text-sm text-lg/7"), ["text-sm"]);
        assert!(losers(&o, "text-lg/7 leading-snug").is_empty());
        // leading-snug before the postfix survives too: its variable is an
        // export, and the tables disagree here on purpose.
        assert!(losers(&o, "leading-snug text-lg/7").is_empty());
    }

    #[test]
    fn multi_declaration_utilities_die_only_when_fully_covered() {
        let o = oracle();
        assert_eq!(losers(&o, "flex line-clamp-2"), ["flex"]);
        assert!(losers(&o, "line-clamp-2 flex").is_empty());
    }

    #[test]
    fn arbitrary_variants_compile_and_bucket_like_any_other() {
        let o = oracle();
        assert_eq!(
            losers(&o, "[&>svg]:size-4 [&>svg]:size-5"),
            ["[&>svg]:size-4"]
        );
        assert!(losers(&o, "[&>svg]:hover:size-4 hover:[&>svg]:size-5").is_empty());
    }

    #[test]
    fn arbitrary_properties_contest_the_real_property() {
        assert_eq!(losers(&oracle(), "[padding:1rem] p-4"), ["[padding:1rem]"]);
    }

    #[test]
    fn tokens_that_only_set_custom_properties_stay_alive() {
        assert!(losers(&oracle(), "[--cell-size:3rem] p-4").is_empty());
    }

    #[test]
    fn logical_border_sides_die_under_the_full_shorthand_v42() {
        // border-bs-2 emits border-block-start width and style; a later
        // border resets every side in every writing mode. The reverse
        // layers, and physical vs logical never contest each other.
        let o = oracle();
        assert_eq!(losers(&o, "border-bs-2 border"), ["border-bs-2"]);
        assert!(losers(&o, "border border-bs-2").is_empty());
    }

    #[test]
    fn logical_padding_was_already_covered_v42_just_renames_it() {
        let o = oracle();
        assert_eq!(losers(&o, "pbs-2 p-4"), ["pbs-2"]);
        assert!(losers(&o, "p-4 pbs-2").is_empty());
    }

    #[test]
    fn unknown_tokens_are_skipped_never_reported() {
        let o = oracle();
        assert_eq!(losers(&o, "text-xsm p-4 p-2"), ["p-4"]);
        assert!(losers(&o, "not-a-class also-not-one").is_empty());
    }

    #[test]
    fn a_prefixed_project_conflicts_on_prefixed_tokens_and_ignores_bare_ones() {
        let p = prefixed();
        assert_eq!(losers(&p, "tw:p-2 tw:p-4"), ["tw:p-2"]);
        assert!(losers(&p, "p-2 p-4").is_empty());
    }

    #[test]
    fn unescape_decodes_hex_escapes_and_keeps_identity_escapes() {
        assert_eq!(unescape(r"\32 xl\:p-4"), "2xl:p-4");
        assert_eq!(unescape(r"\[padding\:1rem\]"), "[padding:1rem]");
    }

    #[test]
    fn digit_leading_candidates_match_their_own_escaped_selector() {
        // CSS escapes a leading digit as a hex escape with a space
        // terminator: 2xl:p-4 compiles to `.\32 xl\:p-4`. The own-selector
        // match must decode that back to the candidate, or the selector
        // becomes a phantom condition and the pair never contests.
        let o = CssOracle::new(compiled(
            r#"{
	"2xl:p-2": [{"kind": "rule", "selector": ".\\32 xl\\:p-2", "nodes": [
		{"kind": "at-rule", "name": "@media", "params": "(width >= 96rem)", "nodes": [
			{"kind": "declaration", "property": "padding", "important": false}
		]}
	]}],
	"2xl:p-4": [{"kind": "rule", "selector": ".\\32 xl\\:p-4", "nodes": [
		{"kind": "at-rule", "name": "@media", "params": "(width >= 96rem)", "nodes": [
			{"kind": "declaration", "property": "padding", "important": false}
		]}
	]}]
}"#,
        ));
        assert_eq!(losers(&o, "2xl:p-2 2xl:p-4"), ["2xl:p-2"]);
    }

    #[test]
    fn typo_oracle_reports_tokens_that_compile_to_nothing() {
        let t = typos();
        assert_eq!(t.losers("p-4 text-xsm btn"), ["text-xsm", "btn"]);
        assert!(t.losers("flex h-9 border-grid").is_empty());
    }

    /// The dead-token rule replayed over the map alone, the algorithm the JS
    /// map oracle implements. A token dies only when every property in every
    /// group is beaten by a later mapped token declaring the same or a
    /// covering property under an identical bucket string. Drift between the
    /// map and CssOracle must fail here before it ships.
    fn map_losers(map: &serde_json::Value, classes: &str) -> Vec<String> {
        let covers = map["covers"].as_object().expect("covers object");
        let mapped = map["tokens"].as_object().expect("tokens object");
        let beats = |winner: &str, loser: &str| {
            winner == loser
                || covers
                    .get(winner)
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|losers| losers.iter().any(|l| l.as_str() == Some(loser)))
        };
        let raw: Vec<&str> = classes.split_whitespace().collect();
        let mut seen = HashSet::new();
        let tokens: Vec<&str> = raw.iter().copied().filter(|t| seen.insert(*t)).collect();
        let position: HashMap<&str, usize> = tokens
            .iter()
            .map(|token| (*token, raw.iter().rposition(|t| t == token).unwrap()))
            .collect();
        let groups_of = |token: &str| mapped.get(token).and_then(serde_json::Value::as_array);
        let known: Vec<&str> = tokens
            .iter()
            .copied()
            .filter(|t| groups_of(t).is_some())
            .collect();
        known
            .iter()
            .filter(|token| {
                groups_of(token).unwrap().iter().all(|group| {
                    let bucket = group["bucket"].as_str().expect("bucket string");
                    group["props"]
                        .as_array()
                        .expect("props array")
                        .iter()
                        .all(|prop| {
                            let prop = prop.as_str().expect("property string");
                            known.iter().any(|other| {
                                position[other] > position[*token]
                                    && groups_of(other).unwrap().iter().any(|own| {
                                        own["bucket"].as_str() == Some(bucket)
                                            && own["props"].as_array().unwrap().iter().any(|w| {
                                                beats(w.as_str().expect("property string"), prop)
                                            })
                                    })
                            })
                        })
                })
            })
            .map(|token| token.to_string())
            .collect()
    }

    /// Every judgment shape the suite above exercises: same-bucket conflicts,
    /// cross-bucket composition, shorthand coverage, custom-property exports,
    /// importance, variant buckets, duplicates, unknown tokens.
    const CORPUS: &[&str] = &[
        "h-9 px-4 h-8",
        "px-4 px-2 text-sm",
        "bg-red-500 p-2 bg-blue-500",
        "h-8 px-4 h-8",
        "flex h-9 items-center rounded-md",
        "font-medium font-normal!",
        "font-medium! font-normal!",
        "p-2 md:p-4",
        "md:p-2 md:p-4",
        "hover:md:p-2 md:hover:p-4",
        "before:hover:m-1 hover:before:m-2",
        "before:focus:underline before:focus:no-underline",
        "before:focus:underline focus:before:no-underline",
        "px-2 p-4",
        "p-4 px-2",
        "scroll-mt-2 scroll-m-4",
        "scroll-m-4 scroll-mt-2",
        "border-grid border-red-500",
        "border-red-500 border-grid",
        "leading-snug text-xs",
        "text-xs leading-snug",
        "leading-tight leading-snug",
        "ordinal slashed-zero",
        "focus-visible:ring-red-500/50 bg-red-500",
        "font-medium [font-weight:900]",
        "translate-x-2 translate-none",
        "ordinal normal-nums",
        "ring-2 shadow-lg",
        "ring-red-500/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-red-500/20 focus-visible:ring-[3px]",
        "text-sm text-lg/7",
        "text-lg/7 leading-snug",
        "leading-snug text-lg/7",
        "flex line-clamp-2",
        "line-clamp-2 flex",
        "[&>svg]:size-4 [&>svg]:size-5",
        "[&>svg]:hover:size-4 hover:[&>svg]:size-5",
        "[padding:1rem] p-4",
        "[--cell-size:3rem] p-4",
        "border-bs-2 border",
        "border border-bs-2",
        "pbs-2 p-4",
        "p-4 pbs-2",
        "text-xsm p-4 p-2",
        "not-a-class also-not-one",
    ];

    #[test]
    fn map_replay_matches_the_css_oracle_across_the_corpus() {
        let compiled = compiled(include_str!("../tests/fixtures/asts.json"));
        let map = compiled.conflict_map();
        let o = CssOracle::new(compiled);
        for classes in CORPUS {
            assert_eq!(map_losers(&map, classes), o.losers(classes), "{classes}");
        }
    }

    #[test]
    fn map_replay_matches_on_a_prefixed_project_too() {
        let compiled = compiled(include_str!("../tests/fixtures/asts-prefixed.json"));
        let map = compiled.conflict_map();
        let o = CssOracle::new(compiled);
        for classes in ["tw:p-2 tw:p-4", "p-2 p-4", "tw:p-4 tw:p-2 tw:p-4"] {
            assert_eq!(map_losers(&map, classes), o.losers(classes), "{classes}");
        }
    }

    #[test]
    fn map_replay_matches_on_digit_leading_escaped_selectors() {
        // The 2xl case: the own-selector unescape must already be baked into
        // the bucket strings, or the pair lands in different buckets and the
        // replay diverges.
        let compiled = compiled(
            r#"{
	"2xl:p-2": [{"kind": "rule", "selector": ".\\32 xl\\:p-2", "nodes": [
		{"kind": "at-rule", "name": "@media", "params": "(width >= 96rem)", "nodes": [
			{"kind": "declaration", "property": "padding", "important": false}
		]}
	]}],
	"2xl:p-4": [{"kind": "rule", "selector": ".\\32 xl\\:p-4", "nodes": [
		{"kind": "at-rule", "name": "@media", "params": "(width >= 96rem)", "nodes": [
			{"kind": "declaration", "property": "padding", "important": false}
		]}
	]}]
}"#,
        );
        let map = compiled.conflict_map();
        let o = CssOracle::new(compiled);
        for classes in ["2xl:p-2 2xl:p-4", "2xl:p-4 2xl:p-2"] {
            assert_eq!(map_losers(&map, classes), o.losers(classes), "{classes}");
        }
        assert_eq!(map_losers(&map, "2xl:p-2 2xl:p-4"), ["2xl:p-2"]);
    }

    #[test]
    fn the_conflict_map_shape_is_version_1_with_sorted_entries() {
        let map = compiled(include_str!("../tests/fixtures/asts.json")).conflict_map();
        assert_eq!(map["version"], serde_json::json!(1));

        // One bare bucket, one property, verbatim from the compiled decls.
        assert_eq!(
            map["tokens"]["px-4"],
            serde_json::json!([{"bucket": "", "props": ["padding-inline"]}])
        );
        // Importance is part of the bucket string.
        assert_eq!(
            map["tokens"]["font-normal!"][0]["bucket"].as_str().unwrap(),
            " !"
        );
        // Variants carry their condition stretch into the bucket.
        assert_eq!(
            map["tokens"]["md:p-4"],
            serde_json::json!([{"bucket": "@media (width >= 48rem)", "props": ["padding"]}])
        );
        // Custom properties are declarations, emitted verbatim and sorted.
        assert_eq!(
            map["tokens"]["ring-2"],
            serde_json::json!([{"bucket": "", "props": ["--tw-ring-shadow", "box-shadow"]}])
        );
        // Tokens that compile to nothing stay out; TypoOracle owns those.
        assert!(map["tokens"].get("text-xsm").is_none());
        // covers reads winner-first: a kept shorthand defeats its longhands.
        let padding = map["covers"]["padding"].as_array().unwrap();
        assert!(padding.iter().any(|p| p == "padding-inline"));
        assert!(padding.iter().any(|p| p == "padding-top"));
        assert!(!map["covers"].as_object().unwrap().contains_key("height"));
    }
}
