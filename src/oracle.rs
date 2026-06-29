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
        // tailwind-fuse 0.3.2 has no transition-behavior group: its collision
        // table routes transition-discrete and transition-normal through the
        // `["transition", ..]` catch-all to transition-property, so they wrongly
        // knock out transition-* siblings that set a different property. Real
        // tailwind-merge keeps the two apart. When a behavior token is present,
        // judge it in a pass of its own, where it can only contest another
        // behavior token, never a transition-property class. The substring guard
        // keeps the overwhelming common literal on the untouched fast path.
        if classes.contains("transition-discrete") || classes.contains("transition-normal") {
            let tokens: Vec<&str> = classes.split_whitespace().collect();
            let mut behavior = String::new();
            let mut rest = String::new();
            for token in &tokens {
                let bucket = if is_transition_behavior(token) {
                    &mut behavior
                } else {
                    &mut rest
                };
                if !bucket.is_empty() {
                    bucket.push(' ');
                }
                bucket.push_str(token);
            }
            let mut lost: FxHashSet<String> = FxHashSet::default();
            lost.extend(judge(&rest));
            lost.extend(judge(&behavior));
            let mut seen: FxHashSet<&str> = FxHashSet::default();
            return tokens
                .iter()
                .copied()
                .filter(|token| seen.insert(*token) && lost.contains(*token))
                .map(str::to_string)
                .collect();
        }
        judge(classes)
    }
}

/// One pass of tailwind-fuse, returning the tokens it would remove, deduplicated
/// and in first-appearance order.
///
/// tailwind-fuse 0.3.2 only parses the v3 leading-! position, so a v4 trailing !
/// reads as a plain class and wrongly contests its normal siblings. Rewrite each
/// token to the spelling fuse parses, judge in that space, and report the
/// originals. Most literals have no ! anywhere, and that case needs no parsing
/// and no rewrite buffer, just the merge itself.
fn judge(classes: &str) -> Vec<String> {
    if !classes.contains('!') {
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
    let rewritten: Vec<String> = tokens
        .iter()
        .map(|token| leading_important(token))
        .collect();
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

/// transition-discrete / transition-normal, under any variants or importance.
/// tailwind-fuse 0.3.2 misfiles these as transition-property; the caller judges
/// them apart so they never contest a real transition-property token.
fn is_transition_behavior(token: &str) -> bool {
    let base = crate::parse::parse(token).base;
    base == "transition-discrete" || base == "transition-normal"
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
