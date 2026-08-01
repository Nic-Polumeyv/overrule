//! Tokenizer for Tailwind class tokens. Structure only, no semantics: it
//! separates variants from the base utility and normalizes importance so an
//! oracle can decide what conflicts with what. It never guesses what a
//! utility means.

/// A parsed class token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// Variant prefixes in source order, e.g. ["md", "hover"] or ["data-[state=open]"].
    pub variants: Vec<String>,
    /// The utility itself, with arbitrary values and slash modifiers intact.
    pub base: String,
    /// Trailing ! (the v4 position) or leading ! (the legacy position v4 still accepts).
    pub important: bool,
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
/// boundaries. What counts as order-sensitive is the caller's call:
/// [`crate::css`] sorts compiled conditions with it.
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
    Parsed {
        variants: variant_parts.iter().map(|s| s.to_string()).collect(),
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
                variants: vec![],
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
    fn order_normalize_sorts_within_stretches_and_pins_sensitive_elements() {
        let sensitive = |e: &str| e == "before";
        assert_eq!(
            order_normalize(&["sm", "dark", "hover"], sensitive, ":"),
            order_normalize(&["hover", "sm", "dark"], sensitive, ":")
        );
        assert_ne!(
            order_normalize(&["focus", "before"], sensitive, ":"),
            order_normalize(&["before", "focus"], sensitive, ":")
        );
        assert_eq!(
            order_normalize(&["md", "hover", "before", "m-1"], sensitive, ":"),
            order_normalize(&["hover", "md", "before", "m-1"], sensitive, ":")
        );
    }
}
