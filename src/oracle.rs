//! The conflict oracle seam. An oracle takes a class string and returns the
//! tokens that lose; an empty vec means no token conflicts with another. The
//! trait exists so the stylesheet-derived oracle can replace the name-based
//! tables, same seam as the npm package.

use std::collections::HashSet;

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
        // tailwind-fuse (0.3.2) only parses the v3 leading-! position, so a
        // v4 trailing ! reads as a plain class and wrongly contests its
        // normal siblings. Rewrite each token to the spelling fuse parses,
        // judge in that space, and report the originals.
        let tokens: Vec<&str> = classes.split_whitespace().collect();
        let rewritten: Vec<String> = tokens
            .iter()
            .map(|token| leading_important(token))
            .collect();
        let merged = tailwind_fuse::merge::tw_merge(rewritten.join(" "));
        let kept: HashSet<&str> = merged.split(' ').collect();
        let mut seen = HashSet::new();
        tokens
            .iter()
            .zip(&rewritten)
            .filter(|(token, rewrite)| seen.insert(**token) && !kept.contains(rewrite.as_str()))
            .map(|(token, _)| token.to_string())
            .collect()
    }
}

/// `font-normal!` becomes `!font-normal`, variants kept in front: the v3
/// position is the only one tailwind-fuse understands, and importance must
/// stay visible to it so important and normal classes never contest.
fn leading_important(token: &str) -> String {
    let parsed = crate::parse::parse(token);
    if !parsed.important || !token.ends_with('!') {
        return token.to_string();
    }
    let mut out = String::with_capacity(token.len());
    for variant in &parsed.variants {
        out.push_str(variant);
        out.push(':');
    }
    out.push('!');
    out.push_str(&parsed.base);
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
