//! Port of the npm package's scanner tests that need real files. The unit
//! cases live next to the code in src/scan.rs; these cover the fixtures and
//! the fix round-trip.

use std::fs;
use std::path::PathBuf;

use overrule::oracle::TwFuseOracle;
use overrule::scan::{apply_fixes, scan_paths, scan_source};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn finds_conflicts_in_attributes_and_cn_calls_skips_clean_and_resolved_strings() {
    let svelte = fs::read_to_string(fixtures().join("button.svelte")).unwrap();
    let mut dropped: Vec<String> = scan_source(&svelte, &TwFuseOracle)
        .iter()
        .map(|f| f.dropped.join(" "))
        .collect();
    dropped.sort();
    assert_eq!(dropped, ["h-9", "px-4"]);
}

#[test]
fn tsx_attributes_important_stays_silent_template_literal_without_interpolation_scanned() {
    let tsx = fs::read_to_string(fixtures().join("widget.tsx")).unwrap();
    let findings = scan_source(&tsx, &TwFuseOracle);
    assert_eq!(findings.len(), 1, "findings: {findings:?}");
    assert_eq!(findings[0].dropped, ["gap-2"]);
}

#[test]
fn fixed_is_derived_from_the_oracle_verdict_identical_to_what_tw_merge_resolves() {
    let corpus = [
        "flex h-9 h-8 items-center",
        "px-4 px-2 text-sm",
        "grid gap-2 gap-4",
        "text-sm leading-snug text-xs",
        "p-2 m-1 p-2 m-2",
        "inline-flex h-9 px-2 h-8",
        "md:p-2 font-medium md:p-4",
    ];
    for literal in corpus {
        let findings = scan_source(&format!("<div class=\"{literal}\">"), &TwFuseOracle);
        assert_eq!(findings.len(), 1, "{literal} should conflict");
        assert_eq!(
            findings[0].fixed,
            tailwind_fuse::merge::tw_merge(literal),
            "literal: {literal}"
        );
    }
}

#[test]
fn fix_rewrites_to_merged_form_and_a_second_scan_is_clean() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["button.svelte", "widget.tsx"] {
        fs::copy(fixtures().join(name), dir.path().join(name)).unwrap();
    }
    let paths = vec![dir.path().to_path_buf()];
    let findings = scan_paths(&paths, &TwFuseOracle);
    assert_eq!(findings.len(), 3);
    let changed = apply_fixes(&findings).unwrap();
    assert_eq!(changed, 2);
    assert!(scan_paths(&paths, &TwFuseOracle).is_empty());
    let fixed_svelte = fs::read_to_string(dir.path().join("button.svelte")).unwrap();
    assert!(fixed_svelte.contains("flex h-8 items-center"));
    assert!(fixed_svelte.contains("px-2 text-sm"));
    assert!(fixed_svelte.contains("rounded-md border"));
}
