//! Walker and literal extraction: class attributes and
//! cn/cx/clsx/tv/cva/declareVariants call arguments, template literals without
//! interpolation. The scanner sees single
//! literals only; caller-vs-component conflicts only exist at runtime, which
//! is the npm package's guard's job.

use std::collections::HashMap;

use rustc_hash::{FxHashMap, FxHashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::oracle::Oracle;

const SCAN_EXTS: &[&str] = &[
    "svelte", "tsx", "jsx", "vue", "astro", "html", "ts", "js", "mjs",
];
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".git",
    ".svelte-kit",
    ".next",
    ".output",
    ".vercel",
];

/// One conflicting literal inside a source string.
#[derive(Debug, Clone)]
pub struct Conflict {
    /// 1-based line of the literal.
    pub line: usize,
    /// The class string as written.
    pub literal: String,
    /// Tokens the cascade may silently discard.
    pub dropped: Vec<String>,
    /// The literal with the losers removed, used by fix.
    pub fixed: String,
    /// Byte offsets of the literal's content within the file.
    pub start: usize,
    /// End offset, exclusive.
    pub end: usize,
}

/// A conflict located in a file on disk.
#[derive(Debug, Clone)]
pub struct Finding {
    pub file: PathBuf,
    pub conflict: Conflict,
}

fn scannable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SCAN_EXTS.contains(&e))
}

/// Every scannable file under `root`, skipping build output and node_modules.
pub fn walk(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if root.is_file() {
        if scannable(root) {
            files.push(root.to_path_buf());
        }
        return files;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return files;
    };
    // libuv sorts scandir results, so the npm CLI reports findings in
    // alphabetical file order; match it to keep outputs diffable.
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            if SKIP_DIRS.iter().any(|skip| entry.file_name() == *skip) {
                continue;
            }
            files.extend(walk(&path));
        } else if scannable(&path) {
            files.push(path);
        }
    }
    files
}

/// A literal borrowed out of the source it was found in. Findings own their
/// strings; this intermediate does not need to.
struct Literal<'a> {
    content: &'a str,
    start: usize,
    end: usize,
}

/// The literal with losing tokens removed and exact duplicates collapsed into
/// their last occurrence. Same survivors tailwind-fuse keeps, so the rewrite
/// cannot change a pixel; the test suite cross-checks this against tw_merge.
fn without_losers(literal: &str, dropped: &[String]) -> String {
    let losers: FxHashSet<&str> = dropped.iter().map(String::as_str).collect();
    let tokens: Vec<&str> = literal.split_whitespace().collect();
    let mut last_index: FxHashMap<&str, usize> = FxHashMap::default();
    for (index, token) in tokens.iter().enumerate() {
        last_index.insert(token, index);
    }
    tokens
        .iter()
        .enumerate()
        .filter(|(index, token)| !losers.contains(*token) && last_index[*token] == *index)
        .map(|(_, token)| *token)
        .collect::<Vec<_>>()
        .join(" ")
}

// Content excludes BOTH quote types on purpose, exactly like the npm
// scanner: a Svelte interpolation `{cond ? 'a' : 'b'}` inside a double-quoted
// attribute always carries the other quote, so this exclusion is what keeps
// branch-split literals from being judged as one string.
static ATTR_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"\bclass(?:Name)?=(?:"([^"']+)"|'([^"']+)')"#).unwrap());
static CALL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(?:cn|cx|clsx|tv|cva|declareVariants)\s*\(").unwrap());

/// Collect string literals inside a call's balanced parens, at any nesting
/// depth. Byte indices are safe: every delimiter is ASCII and an ASCII byte in
/// UTF-8 is always a real character, so slices land on char boundaries.
fn literals_in_call(src: &str, open_paren: usize) -> Vec<Literal<'_>> {
    let bytes = src.as_bytes();
    let mut literals = Vec::new();
    let mut depth = 1;
    let mut i = open_paren + 1;
    while i < bytes.len() && depth > 0 {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth -= 1,
            quote @ (b'"' | b'\'' | b'`') => {
                let start = i + 1;
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                let end = i.min(bytes.len());
                let content = &src[start..end];
                if !(quote == b'`' && content.contains("${")) {
                    literals.push(Literal {
                        content,
                        start,
                        end,
                    });
                }
            }
            _ => {}
        }
        i += 1;
    }
    literals
}

/// Scan one source string for conflicting class literals.
pub fn scan_source(src: &str, oracle: &dyn Oracle) -> Vec<Conflict> {
    let mut literals: Vec<Literal> = Vec::new();

    for cap in ATTR_RE.captures_iter(src) {
        let m = cap
            .get(1)
            .or_else(|| cap.get(2))
            .expect("one alternative matched");
        literals.push(Literal {
            content: m.as_str(),
            start: m.start(),
            end: m.end(),
        });
    }
    for m in CALL_RE.find_iter(src) {
        literals.extend(literals_in_call(src, m.end() - 1));
    }

    let mut seen = FxHashSet::default();
    let mut findings = Vec::new();
    for literal in literals {
        if !seen.insert(literal.start) {
            continue;
        }
        if literal.content.split_whitespace().nth(1).is_none() {
            continue;
        }
        let dropped = oracle.losers(literal.content);
        if dropped.is_empty() {
            continue;
        }
        findings.push(Conflict {
            line: src.as_bytes()[..literal.start]
                .iter()
                .filter(|&&b| b == b'\n')
                .count()
                + 1,
            literal: literal.content.to_string(),
            fixed: without_losers(literal.content, &dropped),
            dropped,
            start: literal.start,
            end: literal.end,
        });
    }
    findings
}

/// Scan files and directories. Unreadable files are skipped. Files are judged
/// in parallel; rayon's ordered collect keeps findings in walk order, so the
/// output is deterministic and matches the npm CLI. This is the part a
/// JavaScript scanner cannot do without worker ceremony, and the reason the
/// oracle trait demands Sync.
pub fn scan_paths(paths: &[PathBuf], oracle: &(dyn Oracle + Sync)) -> Vec<Finding> {
    use rayon::prelude::*;
    let files: Vec<PathBuf> = paths.iter().flat_map(|path| walk(path)).collect();
    files
        .par_iter()
        .flat_map(|file| {
            let Ok(src) = fs::read_to_string(file) else {
                return Vec::new();
            };
            scan_source(&src, oracle)
                .into_iter()
                .map(|conflict| Finding {
                    file: file.clone(),
                    conflict,
                })
                .collect()
        })
        .collect()
}

/// Rewrite each conflicting literal to its merged form. Returns the count of
/// files changed.
pub fn apply_fixes(findings: &[Finding]) -> std::io::Result<usize> {
    let mut by_file: HashMap<&PathBuf, Vec<&Conflict>> = HashMap::new();
    for finding in findings {
        by_file
            .entry(&finding.file)
            .or_default()
            .push(&finding.conflict);
    }
    let changed = by_file.len();
    for (file, mut conflicts) in by_file {
        let mut src = fs::read_to_string(file)?;
        conflicts.sort_by_key(|conflict| std::cmp::Reverse(conflict.start));
        for conflict in conflicts {
            src.replace_range(conflict.start..conflict.end, &conflict.fixed);
        }
        fs::write(file, src)?;
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake(classes: &str) -> Vec<String> {
        classes
            .split_whitespace()
            .filter(|token| *token == "loser")
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn template_literals_with_interpolation_are_ignored() {
        let any = |classes: &str| {
            classes
                .split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        };
        assert!(scan_source("cn(`h-9 h-8 ${extra}`)", &any).is_empty());
    }

    #[test]
    fn line_numbers_point_at_the_literal() {
        let findings = scan_source("a\nb\n<div class=\"a loser b\">", &fake);
        assert_eq!(findings[0].line, 3);
    }

    #[test]
    fn a_custom_oracle_threads_through_fixed_included() {
        let findings = scan_source("<div class=\"a loser b\">", &fake);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].dropped, ["loser"]);
        assert_eq!(findings[0].fixed, "a b");
        assert!(scan_source("<div class=\"h-9 h-8\">", &fake).is_empty());
    }

    #[test]
    fn duplicates_collapse_into_their_last_occurrence() {
        assert_eq!(
            without_losers("p-2 m-1 p-2 m-2", &["m-1".to_string()]),
            "p-2 m-2"
        );
    }

    #[test]
    fn declare_variants_config_objects_are_scanned_like_cva() {
        // declareVariants takes a config object like tv and cva. The collector
        // is depth-agnostic, so the nested variant strings are reached and the
        // call name in the regex is the whole change.
        let findings = scan_source(
            "declareVariants({ variants: { size: { sm: 'a loser b' } } })",
            &fake,
        );
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].dropped, ["loser"]);
    }
}
