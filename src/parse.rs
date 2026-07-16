//! Tokenizer for Tailwind class tokens. Structure only, no semantics: it
//! separates variants from the base utility and normalizes importance so an
//! oracle can decide what conflicts with what. It never guesses what a
//! utility means.

/// A parsed class token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// The token as written.
    pub raw: String,
    /// Variant prefixes in source order, e.g. ["md", "hover"] or ["data-[state=open]"].
    pub variants: Vec<String>,
    /// Canonical bucket key: variants order-normalized, importance included.
    /// Two tokens can only conflict when their buckets match.
    pub bucket: String,
    /// The utility itself, with arbitrary values and slash modifiers intact.
    pub base: String,
    /// Trailing ! (the v4 position) or leading ! (the legacy position v4 still accepts).
    pub important: bool,
}

/// Variant order matters only for pseudo-element-like variants: hover:before:
/// and before:hover: style different boxes, while hover:md: and md:hover: are
/// the same rule. This is CSS pseudo-element knowledge, not Tailwind version
/// knowledge, so it does not rot with releases. Arbitrary variants are treated
/// as order-sensitive too, because they can contain pseudo-element selectors
/// and structure alone cannot tell.
const ORDER_SENSITIVE: &[&str] = &[
    "*",
    "**",
    "after",
    "backdrop",
    "before",
    "details-content",
    "file",
    "first-letter",
    "first-line",
    "marker",
    "placeholder",
    "selection",
];

fn is_order_sensitive(variant: &str) -> bool {
    variant.starts_with('[') || ORDER_SENSITIVE.contains(&variant)
}

/// Split a token on top-level colons, ignoring colons inside [], (), and quotes.
/// Byte iteration is safe here: every delimiter is ASCII, so a matching byte is
/// always a real character boundary, never the middle of a multi-byte char.
fn split_top_level(token: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0i32;
    let mut quote: Option<u8> = None;
    let mut start = 0;
    for (i, &ch) in token.as_bytes().iter().enumerate() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            b'"' | b'\'' => quote = Some(ch),
            b'[' | b'(' => depth += 1,
            b']' | b')' => depth -= 1,
            b':' if depth == 0 => {
                parts.push(&token[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&token[start..]);
    parts
}

/// Sort elements that commute, keep the ones that do not where they are.
/// Elements commute only within the stretch between order-sensitive ones, so
/// each stretch sorts on its own and the order-sensitive elements pin the
/// boundaries. What counts as order-sensitive is the caller's call: variants
/// here, compiled conditions in [`crate::css`].
pub fn order_normalize<S: AsRef<str>>(
    elements: &[S],
    order_sensitive: impl Fn(&str) -> bool,
    separator: &str,
) -> String {
    let mut normalized: Vec<&str> = Vec::new();
    let mut segment: Vec<&str> = Vec::new();
    for element in elements {
        let element = element.as_ref();
        if order_sensitive(element) {
            segment.sort_unstable();
            normalized.append(&mut segment);
            normalized.push(element);
        } else {
            segment.push(element);
        }
    }
    segment.sort_unstable();
    normalized.append(&mut segment);
    normalized.join(separator)
}

/// Order-normalize variants into a bucket key. Variants commute only within
/// the stretch between order-sensitive ones: hover before a pseudo-element
/// reaches a different box than hover after it.
pub fn bucket_of<S: AsRef<str>>(variants: &[S], important: bool) -> String {
    let mut bucket = order_normalize(variants, is_order_sensitive, ":");
    if important {
        bucket.push('!');
    }
    bucket
}

/// Parse one class token into variants, base, and importance.
pub fn parse(raw: &str) -> Parsed {
    let parts = split_top_level(raw);
    let (last, variant_parts) = parts
        .split_last()
        .expect("split always yields at least one part");
    let mut base = *last;
    let mut important = false;
    if let Some(stripped) = base.strip_suffix('!') {
        important = true;
        base = stripped;
    } else if let Some(stripped) = base.strip_prefix('!') {
        important = true;
        base = stripped;
    }
    let variants: Vec<String> = variant_parts.iter().map(|s| s.to_string()).collect();
    Parsed {
        raw: raw.to_string(),
        bucket: bucket_of(&variants, important),
        variants,
        base: base.to_string(),
        important,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_utility() {
        assert_eq!(
            parse("h-9"),
            Parsed {
                raw: "h-9".into(),
                variants: vec![],
                bucket: "".into(),
                base: "h-9".into(),
                important: false,
            }
        );
    }

    #[test]
    fn single_variant() {
        let p = parse("md:p-4");
        assert_eq!(p.variants, ["md"]);
        assert_eq!(p.base, "p-4");
    }

    #[test]
    fn data_attribute_variant_keeps_its_brackets() {
        let p = parse("data-[state=closed]:opacity-0");
        assert_eq!(p.variants, ["data-[state=closed]"]);
        assert_eq!(p.base, "opacity-0");
    }

    #[test]
    fn arbitrary_variant_with_nested_brackets_quotes_and_inner_colons() {
        let p = parse("[&_svg:not([class*='size-'])]:size-4");
        assert_eq!(p.variants, ["[&_svg:not([class*='size-'])]"]);
        assert_eq!(p.base, "size-4");
    }

    #[test]
    fn arbitrary_property_with_colon_and_parens_plus_trailing_important() {
        let p = parse("md:[--cell-size:--spacing(12)]!");
        assert_eq!(p.variants, ["md"]);
        assert_eq!(p.base, "[--cell-size:--spacing(12)]");
        assert!(p.important);
    }

    #[test]
    fn trailing_important_v4() {
        let p = parse("font-normal!");
        assert_eq!(p.base, "font-normal");
        assert!(p.important);
    }

    #[test]
    fn leading_important_v3() {
        let p = parse("!m-0");
        assert_eq!(p.base, "m-0");
        assert!(p.important);
    }

    #[test]
    fn slash_modifiers_stay_in_the_base() {
        assert_eq!(parse("bg-primary/80").base, "bg-primary/80");
        assert_eq!(parse("w-3/4").base, "w-3/4");
        assert_eq!(parse("hover:bg-destructive/90!").base, "bg-destructive/90");
    }

    #[test]
    fn stacked_variants() {
        let p = parse("rtl:starting:translate-x-full");
        assert_eq!(p.variants, ["rtl", "starting"]);
        assert_eq!(p.base, "translate-x-full");
    }

    #[test]
    fn round_trips_tokens_written_in_v4_syntax() {
        let corpus = [
            "h-9",
            "md:hover:p-4",
            "data-[state=open]:bg-muted",
            "[&_svg:not([class*='size-'])]:size-4",
            "md:[--cell-size:--spacing(12)]!",
            "group-data-[collapsible=icon]:p-2!",
            "max-md:inset-x-0",
            "bg-primary/80",
        ];
        for raw in corpus {
            let p = parse(raw);
            let mut rebuilt = p
                .variants
                .iter()
                .map(String::as_str)
                .chain([p.base.as_str()])
                .collect::<Vec<_>>()
                .join(":");
            if p.important {
                rebuilt.push('!');
            }
            assert_eq!(rebuilt, raw);
        }
    }

    #[test]
    fn order_insensitive_variants_share_a_bucket() {
        assert_eq!(parse("hover:md:p-4").bucket, parse("md:hover:p-4").bucket);
    }

    #[test]
    fn pseudo_element_variants_do_not() {
        assert_ne!(
            parse("before:hover:underline").bucket,
            parse("hover:before:underline").bucket
        );
    }

    #[test]
    fn arbitrary_variants_are_treated_as_order_sensitive() {
        assert_ne!(
            parse("[&>svg]:hover:opacity-50").bucket,
            parse("hover:[&>svg]:opacity-50").bucket
        );
    }

    #[test]
    fn variants_on_opposite_sides_of_a_pseudo_element_stay_distinct() {
        assert_ne!(
            parse("focus:before:underline").bucket,
            parse("before:focus:underline").bucket
        );
        assert_ne!(
            parse("md:before:hover:m-1").bucket,
            parse("hover:md:before:m-1").bucket
        );
        assert_eq!(
            parse("md:hover:before:m-1").bucket,
            parse("hover:md:before:m-1").bucket
        );
    }

    #[test]
    fn importance_separates_buckets() {
        assert_ne!(parse("p-4").bucket, parse("p-4!").bucket);
        assert_eq!(parse("md:p-4!").bucket, parse("md:p-2!").bucket);
    }

    #[test]
    fn permutation_invariance_for_plain_variants() {
        assert_eq!(
            bucket_of(&["sm", "dark", "hover"], false),
            bucket_of(&["hover", "sm", "dark"], false)
        );
    }
}
