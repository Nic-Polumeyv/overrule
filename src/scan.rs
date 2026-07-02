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
pub fn without_losers(literal: &str, dropped: &[String]) -> String {
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
    LazyLock::new(|| Regex::new(r"\b(?:cn|cx|clsx|tv|cva|join|declareVariants)\s*\(").unwrap());

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
            // Comments between arguments can carry stray quotes (don't, `x`)
            // that would open a phantom string and swallow real literals.
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'/' => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
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

/// Byte spans of the candidate literals in one source string: attribute
/// matches first, call literals after, deduplicated by start offset,
/// single-token strings dropped. Extraction is oracle-independent, so it
/// happens once per file no matter how many oracles judge the result; spans
/// instead of borrows let [`SourceFile`] own the source they point into.
fn candidate_spans(src: &str) -> Vec<(usize, usize)> {
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
    literals
        .into_iter()
        .filter(|literal| {
            seen.insert(literal.start) && literal.content.split_whitespace().nth(1).is_some()
        })
        .map(|literal| (literal.start, literal.end))
        .collect()
}

/// Judge pre-extracted literals against one oracle, in span order.
fn judge_spans(src: &str, spans: &[(usize, usize)], oracle: &dyn Oracle) -> Vec<Conflict> {
    let mut findings = Vec::new();
    for &(start, end) in spans {
        let content = &src[start..end];
        let dropped = oracle.losers(content);
        if dropped.is_empty() {
            continue;
        }
        findings.push(Conflict {
            line: src.as_bytes()[..start]
                .iter()
                .filter(|&&b| b == b'\n')
                .count()
                + 1,
            literal: content.to_string(),
            fixed: without_losers(content, &dropped),
            dropped,
            start,
            end,
        });
    }
    findings
}

/// Scan one source string for conflicting class literals.
pub fn scan_source(src: &str, oracle: &dyn Oracle) -> Vec<Conflict> {
    judge_spans(src, &candidate_spans(src), oracle)
}

/// A file read from disk with its candidate literals already extracted.
/// check --css and cross judge the same tree with several oracles; reading
/// and extracting up front is what keeps that one walk instead of one per
/// oracle.
pub struct SourceFile {
    file: PathBuf,
    src: String,
    literals: Vec<(usize, usize)>,
}

/// Walk, read, and extract each file once. Unreadable files are skipped.
/// Files keep walk order, so every judging pass over the result reports in
/// the same alphabetical file order as the npm CLI.
pub fn read_paths(paths: &[PathBuf]) -> Vec<SourceFile> {
    use rayon::prelude::*;
    let files: Vec<PathBuf> = paths.iter().flat_map(|path| walk(path)).collect();
    files
        .into_par_iter()
        .filter_map(|file| {
            let src = fs::read_to_string(&file).ok()?;
            let literals = candidate_spans(&src);
            Some(SourceFile {
                file,
                src,
                literals,
            })
        })
        .collect()
}

/// Judge extracted files with one oracle. Files are judged in parallel;
/// rayon's ordered collect keeps findings in walk order, so the output is
/// deterministic and matches the npm CLI. This is the part a JavaScript
/// scanner cannot do without worker ceremony, and the reason the oracle
/// trait demands Sync.
pub fn scan_files(files: &[SourceFile], oracle: &(dyn Oracle + Sync)) -> Vec<Finding> {
    use rayon::prelude::*;
    files
        .par_iter()
        .flat_map(|source| {
            judge_spans(&source.src, &source.literals, oracle)
                .into_iter()
                .map(|conflict| Finding {
                    file: source.file.clone(),
                    conflict,
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Scan files and directories with a single oracle. Fused on purpose rather
/// than composed from [`read_paths`] and [`scan_files`]: one oracle has no
/// reuse for the retained sources, and the corpus indirection costs
/// measurable wall time on big trees. Same walk, same order, same skips.
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
        // Ranges can nest: a call string carrying a class='...' substring is
        // reported by both regexes. Rewriting the outer after the inner would
        // splice against stale offsets, so overlaps are skipped and the next
        // fix run picks up whatever the survivor left behind.
        let mut last_start = usize::MAX;
        for conflict in conflicts {
            if conflict.end > last_start {
                continue;
            }
            src.replace_range(conflict.start..conflict.end, &conflict.fixed);
            last_start = conflict.start;
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
    fn join_calls_are_scanned_in_script_and_markup() {
        // The runtime's own join() replaced cn() at most call sites; the
        // scanner has to know the name or those literals go unwatched.
        let findings = scan_source("const c = join('a loser b', extra);", &fake);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].dropped, ["loser"]);

        let findings = scan_source("<div class={join('a loser b', className)}>", &fake);
        assert_eq!(findings.len(), 1);
    }

    #[test]
    fn comments_between_call_args_do_not_open_phantom_strings() {
        // Each comment carries an unbalanced quote, so skipping either one
        // is what keeps the literal after it from being swallowed.
        let src =
            "join(\n  // we don't want ticks\n  'a loser b',\n  /* don't */\n  'c loser d',\n)";
        let findings = scan_source(src, &fake);
        assert_eq!(findings.len(), 2, "findings: {findings:?}");
        assert_eq!(findings[0].dropped, ["loser"]);
        assert_eq!(findings[0].fixed, "a b");
        assert_eq!(findings[1].fixed, "c d");
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
