//! Port of the npm package's cli-bin tests: the built binary, end to end.
//! The cross test compiles with Tailwind through the node bridge, so it
//! needs `bun install` (or npm) to have run in this repo first; without
//! that it skips instead of failing.

use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn run(args: &[&str], cwd: &Path, actions: bool) -> (i32, String, String) {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_overrule"))
        .args(args)
        .current_dir(cwd)
        .env("GITHUB_ACTIONS", if actions { "true" } else { "false" })
        .output()
        .expect("the binary runs");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
    )
}

fn tailwind_installed() -> bool {
    std::process::Command::new("node")
        .args(["-e", "require.resolve('tailwindcss')"])
        .current_dir(root())
        .output()
        .is_ok_and(|output| output.status.success())
}

#[test]
fn check_json_machine_output_same_exit_code() {
    let (code, out, _) = run(&["check", "--json", "tests/fixtures"], &root(), false);
    assert_eq!(code, 1);
    let data: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    let findings = data["findings"].as_array().expect("findings array");
    assert_eq!(findings.len(), 3);
    assert!(findings[0]["file"].is_string());
    assert!(findings[0]["fixed"].is_string());
    assert_eq!(findings[0]["line"], serde_json::json!(7));
    assert_eq!(
        findings[0]["literal"],
        serde_json::json!("px-4 px-2 text-sm")
    );
    assert_eq!(findings[0]["dropped"], serde_json::json!(["px-4"]));
    assert_eq!(data["unknown"].as_array().expect("unknown array").len(), 0);
}

#[test]
fn check_without_json_exits_1_and_names_the_dropped_token_clean_exits_0() {
    let (code, out, _) = run(&["check", "tests/fixtures"], &root(), false);
    assert_eq!(code, 1);
    assert!(out.contains("drops  h-9"), "out: {out}");
    assert!(out.contains("Run \"overrule fix\""), "out: {out}");

    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("clean.svelte"),
        "<div class=\"flex h-9 items-center\">x</div>\n",
    )
    .unwrap();
    let (code, out, _) = run(&["check", dir.path().to_str().unwrap()], &root(), false);
    assert_eq!(code, 0);
    assert!(out.contains("no class conflicts found"), "out: {out}");
}

#[test]
fn check_emits_error_annotations_under_github_actions() {
    let (_, out, _) = run(&["check", "tests/fixtures"], &root(), true);
    assert!(out.contains("::error file="), "out: {out}");
    assert!(out.contains("title=overrule"), "out: {out}");
}

#[test]
fn no_annotations_outside_github_actions() {
    let (_, out, _) = run(&["check", "tests/fixtures"], &root(), false);
    assert!(!out.contains("::error"), "out: {out}");
}

#[test]
fn a_snapshot_silences_known_disagreements_anything_new_exits_1() {
    if !tailwind_installed() {
        eprintln!("skipped: run `bun install` so the bridge can resolve tailwindcss");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    // The tables drop leading-snug after text-xs; the compiled CSS shows
    // they compose, so this literal is a permanent, correct disagreement.
    fs::write(
        dir.path().join("demo.svelte"),
        "<div class=\"leading-snug text-xs\">x</div>\n",
    )
    .unwrap();
    let target = dir.path().to_str().unwrap();

    let (code, out, err) = run(&["cross", target, "--json"], &root(), false);
    assert_eq!(code, 0, "stderr: {err}");
    let data: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    let disagreements = data["disagreements"]
        .as_array()
        .expect("disagreements array");
    assert_eq!(disagreements.len(), 1);
    assert_eq!(
        disagreements[0]["tables"],
        serde_json::json!(["leading-snug"])
    );
    assert_eq!(disagreements[0]["sheet"], serde_json::json!([]));

    let ack_path = dir.path().join("acks.json");
    fs::write(&ack_path, &out).unwrap();
    let (code, out, _) = run(
        &["cross", target, "--ack", ack_path.to_str().unwrap()],
        &root(),
        false,
    );
    assert_eq!(code, 0);
    assert!(
        out.contains("no new disagreements, 1 acknowledged"),
        "out: {out}"
    );

    fs::write(&ack_path, "{\"disagreements\": []}").unwrap();
    let (code, out, _) = run(
        &["cross", target, "--ack", ack_path.to_str().unwrap()],
        &root(),
        false,
    );
    assert_eq!(code, 1);
    assert!(out.contains("leading-snug"), "out: {out}");
    assert!(out.contains("1 new disagreement"), "out: {out}");
}

#[test]
fn an_ack_follows_the_literal_across_files_and_lines() {
    if !tailwind_installed() {
        eprintln!("skipped: run `bun install` so the bridge can resolve tailwindcss");
        return;
    }
    // The signature ignores file and line on purpose: an acknowledged string
    // stays acknowledged when it moves or gets copied.
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("a.svelte"),
        "<div class=\"leading-snug text-xs\">x</div>\n",
    )
    .unwrap();
    let target = dir.path().to_str().unwrap();
    let (code, out, err) = run(&["cross", target, "--json"], &root(), false);
    assert_eq!(code, 0, "stderr: {err}");
    let ack_path = dir.path().join("acks.json");
    fs::write(&ack_path, &out).unwrap();

    fs::remove_file(dir.path().join("a.svelte")).unwrap();
    fs::write(
        dir.path().join("b.svelte"),
        "<span>moved</span>\n<div class=\"leading-snug text-xs\">x</div>\n",
    )
    .unwrap();
    let (code, out, _) = run(
        &["cross", target, "--ack", ack_path.to_str().unwrap()],
        &root(),
        false,
    );
    assert_eq!(code, 0, "out: {out}");
    assert!(
        out.contains("no new disagreements, 1 acknowledged"),
        "out: {out}"
    );
}

#[test]
fn ack_outside_cross_is_an_error() {
    // clap rejects the flag at parse time: exit 2 and its own wording, where
    // the npm CLI exits 1 with "--ack only means something to cross". Same
    // contract, different reporter.
    let (code, _, err) = run(
        &["check", "--ack", "whatever.json", "tests/fixtures"],
        &root(),
        false,
    );
    assert_ne!(code, 0);
    assert!(err.contains("--ack"), "stderr: {err}");
}
