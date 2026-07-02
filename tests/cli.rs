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
    assert!(!out.contains("matched nothing"), "out: {out}");

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

/// A snapshot for the leading-snug fixture plus one entry whose disagreement
/// no longer exists, the shape a snapshot decays into as oracles get fixed.
fn snapshot_with_a_stale_entry(dir: &Path, target: &str) -> PathBuf {
    let (code, out, err) = run(&["cross", target, "--json"], &root(), false);
    assert_eq!(code, 0, "stderr: {err}");
    let mut snapshot: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    snapshot["disagreements"]
        .as_array_mut()
        .expect("disagreements array")
        .push(serde_json::json!({
            "file": "gone.svelte",
            "line": 1,
            "literal": "px-9 px-8",
            "tables": ["px-9"],
            "sheet": ["px-9"],
        }));
    let ack_path = dir.join("acks.json");
    fs::write(&ack_path, snapshot.to_string()).unwrap();
    ack_path
}

#[test]
fn a_stale_ack_entry_gets_a_prune_hint_and_does_not_fail_the_run() {
    if !tailwind_installed() {
        eprintln!("skipped: run `bun install` so the bridge can resolve tailwindcss");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("demo.svelte"),
        "<div class=\"leading-snug text-xs\">x</div>\n",
    )
    .unwrap();
    let target = dir.path().to_str().unwrap();
    let ack_path = snapshot_with_a_stale_entry(dir.path(), target);

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
    assert!(
        out.contains("1 of 2 acknowledged entries matched nothing; prune them from"),
        "out: {out}"
    );
    assert!(out.contains("acks.json"), "out: {out}");
}

#[test]
fn stale_ack_entries_are_listed_in_json_matched_ones_are_not() {
    if !tailwind_installed() {
        eprintln!("skipped: run `bun install` so the bridge can resolve tailwindcss");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("demo.svelte"),
        "<div class=\"leading-snug text-xs\">x</div>\n",
    )
    .unwrap();
    let target = dir.path().to_str().unwrap();
    let ack_path = snapshot_with_a_stale_entry(dir.path(), target);

    let (code, out, _) = run(
        &[
            "cross",
            target,
            "--ack",
            ack_path.to_str().unwrap(),
            "--json",
        ],
        &root(),
        false,
    );
    assert_eq!(code, 0, "out: {out}");
    let data: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    assert_eq!(data["disagreements"].as_array().expect("array").len(), 0);
    let stale = data["staleAcks"].as_array().expect("staleAcks array");
    assert_eq!(stale.len(), 1);
    assert_eq!(stale[0]["literal"], serde_json::json!("px-9 px-8"));

    // Without --ack the output is the snapshot format; staleAcks stays out.
    let (_, out, _) = run(&["cross", target, "--json"], &root(), false);
    let data: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    assert!(data["staleAcks"].is_null(), "out: {out}");
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

#[test]
fn map_emits_a_versioned_deterministic_conflict_map() {
    if !tailwind_installed() {
        eprintln!("skipped: run `bun install` so the bridge can resolve tailwindcss");
        return;
    }
    let args = ["map", "tests/fixtures", "--css", "tests/fixtures/entry.css"];
    let (code, out, err) = run(&args, &root(), false);
    assert_eq!(code, 0, "stderr: {err}");
    let data: serde_json::Value = serde_json::from_str(&out).expect("valid json");
    assert_eq!(data["version"], serde_json::json!(1));

    // h-9 comes from button.svelte; through a stock stylesheet it is one
    // bare-bucket height declaration.
    assert_eq!(
        data["tokens"]["h-9"],
        serde_json::json!([{"bucket": "", "props": ["height"]}])
    );
    // font-normal! comes from widget.tsx; importance lands in the bucket
    // string, and its custom-property export is a declaration like any other.
    let important = data["tokens"]["font-normal!"]
        .as_array()
        .expect("font-normal! groups");
    assert_eq!(important.len(), 1);
    assert_eq!(important[0]["bucket"], serde_json::json!(" !"));
    assert_eq!(
        important[0]["props"],
        serde_json::json!(["--tw-font-weight", "font-weight"])
    );
    // The coverage table rides along, winner-first.
    assert!(
        data["covers"]["padding"]
            .as_array()
            .expect("covers entry")
            .iter()
            .any(|p| p == "padding-inline")
    );

    // Byte-identical across runs, stdout and --out both.
    let (code, out_again, _) = run(&args, &root(), false);
    assert_eq!(code, 0);
    assert_eq!(out, out_again);

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("map.json");
    let mut with_out = args.to_vec();
    with_out.extend(["--out", file.to_str().unwrap()]);
    let (code, piped, err) = run(&with_out, &root(), false);
    assert_eq!(code, 0, "stderr: {err}");
    assert!(piped.is_empty(), "stdout: {piped}");
    assert_eq!(fs::read_to_string(&file).unwrap(), out);
}

#[test]
fn map_without_css_is_a_clap_error() {
    let (code, _, err) = run(&["map", "tests/fixtures"], &root(), false);
    assert_ne!(code, 0);
    assert!(err.contains("--css"), "stderr: {err}");
}

#[test]
fn judge_takes_arguments_and_exits_1_on_a_conflict() {
    let (code, out, _) = run(&["judge", "p-2 p-4", "flex gap-2"], &root(), false);
    assert_eq!(code, 1);
    assert!(out.contains("drops  p-2"), "out: {out}");
    assert!(out.contains("keeps  \"p-4\""), "out: {out}");

    let (code, out, _) = run(&["judge", "flex gap-2"], &root(), false);
    assert_eq!(code, 0);
    assert!(out.contains("no class conflicts found"), "out: {out}");
}

#[test]
fn judge_reads_stdin_and_returns_verdicts_in_input_order() {
    use std::io::Write;
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_overrule"))
        .args(["judge", "--json"])
        .current_dir(root())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .env("GITHUB_ACTIONS", "false")
        .spawn()
        .expect("the binary runs");
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(b"text-sm text-lg\n\nm-1 m-2\nclean ok\n")
        .expect("stdin accepts input");
    let output = child.wait_with_output().expect("the binary exits");
    assert_eq!(output.status.code(), Some(1));

    let data: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&output.stdout)).expect("valid json");
    let verdicts = data["verdicts"].as_array().expect("verdicts array");
    // The blank line is skipped; verdicts follow input order, clean ones included.
    assert_eq!(verdicts.len(), 3);
    assert_eq!(verdicts[0]["literal"], serde_json::json!("text-sm text-lg"));
    assert_eq!(verdicts[0]["dropped"], serde_json::json!(["text-sm"]));
    assert_eq!(verdicts[1]["fixed"], serde_json::json!("m-2"));
    assert_eq!(verdicts[2]["dropped"], serde_json::json!([]));
}
