//! overrule - catch Tailwind class conflicts before they ship.
//!
//! Same contract as the npm CLI: check, fix, and cross, with --css, --json,
//! and --ack. The tables side is tailwind-fuse instead of tailwind-merge;
//! cross exists precisely because ports drift.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;

use clap::{Args, CommandFactory, Parser, Subcommand};
use serde_json::json;

use overrule::bridge::compile_candidates;
use overrule::css::{CompiledCandidates, CssOracle, TypoOracle};
use overrule::oracle::{Memo, Oracle, TwFuseOracle};
use overrule::scan::{
    Finding, SourceFile, apply_fixes, read_paths, scan_files, scan_paths, without_losers,
};

// The scanner's hot loop allocates a String per kept token per literal;
// mimalloc's thread-local heaps make that markedly cheaper under rayon.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[derive(Parser)]
#[command(
    name = "overrule",
    about = "catch Tailwind class conflicts before they ship",
    version
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// report class strings with conflicting tokens (exit 1 if any)
    Check(ScanArgs),
    /// rewrite conflicting literals, losers removed
    Fix(ScanArgs),
    /// report every string where tailwind-fuse and your stylesheet disagree
    Cross(CrossArgs),
    /// judge class strings given as arguments or on stdin, one per line
    Judge(JudgeArgs),
}

#[derive(Args)]
struct ScanArgs {
    /// paths to scan; node_modules, dist, and friends are skipped
    #[arg(default_value = ".")]
    paths: Vec<PathBuf>,
    /// judge with your compiled stylesheet instead of tailwind-fuse's tables.
    /// Point it at the CSS entry that imports tailwindcss; your theme, custom
    /// utilities, and prefix all count. Tokens that compile to nothing get
    /// listed too. cross uses a bare tailwindcss import when --css is missing.
    #[arg(long, value_name = "file")]
    css: Option<PathBuf>,
    /// machine output. Findings for check and fix, disagreements for cross.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct CrossArgs {
    #[command(flatten)]
    scan: ScanArgs,
    /// a snapshot from cross --json listing acknowledged disagreements;
    /// anything not in it prints and exits 1. This is how cross becomes a CI
    /// gate instead of an investigation.
    #[arg(long, value_name = "file")]
    ack: Option<PathBuf>,
}

#[derive(Args)]
struct JudgeArgs {
    /// class strings to judge; with none given, one per line is read from stdin
    literals: Vec<String>,
    /// judge with your compiled stylesheet instead of tailwind-fuse's tables
    #[arg(long, value_name = "file")]
    css: Option<PathBuf>,
    /// machine output: one verdict per literal, in input order
    #[arg(long)]
    json: bool,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let Some(command) = cli.command else {
        // Parity with the npm CLI: bare `overrule` prints usage and exits 0.
        Cli::command().print_help().ok();
        return ExitCode::SUCCESS;
    };
    match command {
        Command::Check(args) => check_or_fix(args, false),
        Command::Fix(args) => check_or_fix(args, true),
        Command::Cross(args) => cross(args),
        Command::Judge(args) => judge(args),
    }
}

/// An oracle that judges nothing and remembers every token it was shown. One
/// pass with this collects the candidate set for a single batched
/// compilation. The trait takes &self and the scan runs files in parallel,
/// so the set sits behind a Mutex; a RefCell would compile for one thread
/// and be rejected the moment scan_paths went parallel.
#[derive(Default)]
struct TokenCollector(Mutex<HashSet<String>>);

impl Oracle for TokenCollector {
    fn losers(&self, classes: &str) -> Vec<String> {
        let mut tokens = self.0.lock().expect("no panics while holding the lock");
        for token in classes.split_whitespace() {
            tokens.insert(token.to_string());
        }
        Vec::new()
    }
}

/// Compile every token the scan will encounter, once, and build both
/// stylesheet oracles from the result.
fn css_oracles(
    files: &[SourceFile],
    css_entry: Option<&PathBuf>,
) -> Result<(CssOracle, TypoOracle), String> {
    let collector = TokenCollector::default();
    scan_files(files, &collector);
    let mut tokens: Vec<String> = collector
        .0
        .into_inner()
        .expect("scan is done")
        .into_iter()
        .collect();
    tokens.sort_unstable();
    let asts = compile_candidates(&tokens, css_entry.map(PathBuf::as_path))?;
    let compiled = CompiledCandidates::from_asts(asts);
    let typos = TypoOracle::new(&compiled);
    Ok((CssOracle::new(compiled), typos))
}

fn in_actions() -> bool {
    std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
}

fn escape_data(value: &str) -> String {
    value
        .replace('%', "%25")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

fn escape_prop(value: &str) -> String {
    escape_data(value).replace(':', "%3A").replace(',', "%2C")
}

fn annotate(file: &str, line: usize, message: &str) {
    println!(
        "::error file={},line={line},title=overrule::{}",
        escape_prop(file),
        escape_data(message)
    );
}

fn print_json(value: &serde_json::Value) {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"\t");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(value, &mut ser).expect("json values serialize");
    println!("{}", String::from_utf8(buf).expect("serde_json emits utf8"));
}

fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 { one } else { many }
}

fn display(finding: &Finding) -> String {
    finding.file.display().to_string()
}

/// Judge bare class strings with no scanner in between: the seam that lets a
/// test suite ask the same engine check uses. A string that is not in a file
/// has no line to point at, so verdicts come back in input order.
fn judge(args: JudgeArgs) -> ExitCode {
    let literals: Vec<String> = if args.literals.is_empty() {
        match std::io::read_to_string(std::io::stdin()) {
            Ok(input) => input
                .lines()
                .filter(|line| !line.trim().is_empty())
                .map(str::to_string)
                .collect(),
            Err(e) => {
                eprintln!("judge: reading stdin failed: {e}");
                return ExitCode::FAILURE;
            }
        }
    } else {
        args.literals
    };

    let verdicts: Vec<(String, Vec<String>)> = match &args.css {
        Some(entry) => {
            let mut tokens: Vec<String> = literals
                .iter()
                .flat_map(|l| l.split_whitespace())
                .map(str::to_string)
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            tokens.sort_unstable();
            let oracle = match compile_candidates(&tokens, Some(entry.as_path())) {
                Ok(asts) => CssOracle::new(CompiledCandidates::from_asts(asts)),
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            };
            literals
                .into_iter()
                .map(|l| {
                    let dropped = oracle.losers(&l);
                    (l, dropped)
                })
                .collect()
        }
        None => {
            let oracle = Memo::new(TwFuseOracle);
            literals
                .into_iter()
                .map(|l| {
                    let dropped = oracle.losers(&l);
                    (l, dropped)
                })
                .collect()
        }
    };

    let conflicts = verdicts.iter().filter(|(_, d)| !d.is_empty()).count();

    if args.json {
        print_json(&json!({
            "verdicts": verdicts.iter().map(|(literal, dropped)| json!({
                "literal": literal,
                "dropped": dropped,
                "fixed": without_losers(literal, dropped),
            })).collect::<Vec<_>>(),
        }));
    } else if conflicts == 0 {
        println!("overrule: no class conflicts found.");
    } else {
        for (literal, dropped) in &verdicts {
            if dropped.is_empty() {
                continue;
            }
            println!("  drops  {}", dropped.join(" "));
            println!("  in     \"{literal}\"");
            println!("  keeps  \"{}\"", without_losers(literal, dropped));
        }
        println!(
            "\n{conflicts} conflicting class {}.",
            plural(conflicts, "string", "strings")
        );
    }

    if conflicts == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn check_or_fix(args: ScanArgs, fixing: bool) -> ExitCode {
    // The stylesheet path judges the tree three times: token collection for
    // the compile batch, conflicts, typos. Each file is read and extracted
    // once and all three passes judge that corpus. The tables path judges
    // once, so it keeps the fused single pass.
    let (findings, unknowns) = match &args.css {
        Some(entry) => {
            let files = read_paths(&args.paths);
            match css_oracles(&files, Some(entry)) {
                Ok((oracle, typos)) => (scan_files(&files, &oracle), scan_files(&files, &typos)),
                Err(message) => {
                    eprintln!("{message}");
                    return ExitCode::FAILURE;
                }
            }
        }
        None => (
            scan_paths(&args.paths, &Memo::new(TwFuseOracle)),
            Vec::new(),
        ),
    };

    if args.json {
        if fixing && let Err(e) = apply_fixes(&findings) {
            eprintln!("fix failed: {e}");
            return ExitCode::FAILURE;
        }
        print_json(&json!({
            "findings": findings.iter().map(|f| json!({
                "file": display(f),
                "line": f.conflict.line,
                "literal": f.conflict.literal,
                "dropped": f.conflict.dropped,
                "fixed": f.conflict.fixed,
            })).collect::<Vec<_>>(),
            "unknown": unknowns.iter().map(|f| json!({
                "file": display(f),
                "line": f.conflict.line,
                "literal": f.conflict.literal,
                "tokens": f.conflict.dropped,
            })).collect::<Vec<_>>(),
        }));
        return if !fixing && !findings.is_empty() {
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        };
    }

    if findings.is_empty() {
        println!("overrule: no class conflicts found.");
    } else {
        for finding in &findings {
            let c = &finding.conflict;
            println!("{}:{}", display(finding), c.line);
            println!("  drops  {}", c.dropped.join(" "));
            println!("  in     \"{}\"", c.literal);
            println!("  keeps  \"{}\"", c.fixed);
            if in_actions() && !fixing {
                annotate(
                    &display(finding),
                    c.line,
                    &format!(
                        "\"{}\" conflicts in \"{}\". The cascade decides which wins; \"{}\" is the resolved form.",
                        c.dropped.join(" "),
                        c.literal,
                        c.fixed
                    ),
                );
            }
        }
    }

    if !unknowns.is_empty() {
        println!("\nunknown classes, these compile to nothing:");
        for unknown in &unknowns {
            let c = &unknown.conflict;
            println!("{}:{}", display(unknown), c.line);
            println!("  unknown  {}", c.dropped.join(" "));
            println!("  in       \"{}\"", c.literal);
        }
        println!("Unknown classes do not fail the run: a typo, or a class Tailwind never sees.");
    }

    if !fixing {
        if findings.is_empty() {
            return ExitCode::SUCCESS;
        }
        println!(
            "\n{} conflicting class {}. Run \"overrule fix\" to resolve them in source.",
            findings.len(),
            plural(findings.len(), "string", "strings")
        );
        return ExitCode::FAILURE;
    }

    if findings.is_empty() {
        return ExitCode::SUCCESS;
    }
    match apply_fixes(&findings) {
        Ok(changed) => {
            println!(
                "\nFixed {} {} across {} {}.",
                findings.len(),
                plural(findings.len(), "string", "strings"),
                changed,
                plural(changed, "file", "files")
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("fix failed: {e}");
            ExitCode::FAILURE
        }
    }
}

struct CrossEntry {
    file: String,
    line: usize,
    literal: String,
    tables: Option<Vec<String>>,
    sheet: Option<Vec<String>>,
}

fn sorted_key(dropped: Option<&Vec<String>>) -> String {
    let mut tokens: Vec<&str> = dropped
        .map(|d| d.iter().map(String::as_str).collect())
        .unwrap_or_default();
    tokens.sort_unstable();
    tokens.join(" ")
}

fn verdict(dropped: Option<&Vec<String>>) -> String {
    match dropped {
        Some(d) if !d.is_empty() => format!("drops {}", d.join(" ")),
        _ => "drops nothing".to_string(),
    }
}

fn cross(args: CrossArgs) -> ExitCode {
    let files = read_paths(&args.scan.paths);
    let (css_oracle, _) = match css_oracles(&files, args.scan.css.as_ref()) {
        Ok(oracles) => oracles,
        Err(message) => {
            eprintln!("{message}");
            return ExitCode::FAILURE;
        }
    };
    let tables = scan_files(&files, &Memo::new(TwFuseOracle));
    let sheet = scan_files(&files, &css_oracle);

    // A closure capturing `entries` mutably would hold that borrow for its
    // whole lifetime and block the field writes below, so this is a plain fn
    // that takes its borrows per call and hands back the entry itself.
    fn upsert<'a>(
        entries: &'a mut HashMap<(String, usize), CrossEntry>,
        order: &mut Vec<(String, usize)>,
        finding: &Finding,
    ) -> &'a mut CrossEntry {
        let key = (display(finding), finding.conflict.start);
        if !entries.contains_key(&key) {
            order.push(key.clone());
            entries.insert(
                key.clone(),
                CrossEntry {
                    file: display(finding),
                    line: finding.conflict.line,
                    literal: finding.conflict.literal.clone(),
                    tables: None,
                    sheet: None,
                },
            );
        }
        entries.get_mut(&key).expect("just inserted")
    }

    let mut order: Vec<(String, usize)> = Vec::new();
    let mut entries: HashMap<(String, usize), CrossEntry> = HashMap::new();
    for finding in &tables {
        upsert(&mut entries, &mut order, finding).tables = Some(finding.conflict.dropped.clone());
    }
    for finding in &sheet {
        upsert(&mut entries, &mut order, finding).sheet = Some(finding.conflict.dropped.clone());
    }

    let total = order.len();
    let mut diffs: Vec<&CrossEntry> = order
        .iter()
        .map(|key| &entries[key])
        .filter(|entry| sorted_key(entry.tables.as_ref()) != sorted_key(entry.sheet.as_ref()))
        .collect();

    // The signature ignores file and line on purpose: an acknowledged string
    // stays acknowledged when it moves or gets copied.
    let signature = |literal: &str, tables: Option<&Vec<String>>, sheet: Option<&Vec<String>>| {
        format!("{literal}\n{}\n{}", sorted_key(tables), sorted_key(sheet))
    };

    let mut acknowledged = 0;
    let mut ack_total = 0;
    let mut stale: Vec<serde_json::Value> = Vec::new();
    if let Some(ack_file) = &args.ack {
        let parsed: serde_json::Value = match std::fs::read_to_string(ack_file)
            .map_err(|e| e.to_string())
            .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
        {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("could not read {}: {e}", ack_file.display());
                return ExitCode::FAILURE;
            }
        };
        let list = if parsed.is_array() {
            &parsed
        } else {
            &parsed["disagreements"]
        };
        let entry_signature = |entry: &serde_json::Value| {
            let strings = |key: &str| -> Option<Vec<String>> {
                entry[key].as_array().map(|tokens| {
                    tokens
                        .iter()
                        .filter_map(|t| t.as_str().map(str::to_string))
                        .collect()
                })
            };
            signature(
                entry["literal"].as_str().unwrap_or(""),
                strings("tables").as_ref(),
                strings("sheet").as_ref(),
            )
        };
        let entries: &[serde_json::Value] = list.as_array().map(Vec::as_slice).unwrap_or(&[]);
        ack_total = entries.len();
        let known: HashSet<String> = entries.iter().map(entry_signature).collect();
        // An entry that matches no current disagreement is a disagreement
        // that no longer exists. It gets reported so snapshots stop
        // accumulating dead entries, and it never affects the exit code.
        let current: HashSet<String> = diffs
            .iter()
            .map(|entry| signature(&entry.literal, entry.tables.as_ref(), entry.sheet.as_ref()))
            .collect();
        stale = entries
            .iter()
            .filter(|entry| !current.contains(&entry_signature(entry)))
            .cloned()
            .collect();
        let fresh: Vec<&CrossEntry> = diffs
            .iter()
            .copied()
            .filter(|entry| {
                !known.contains(&signature(
                    &entry.literal,
                    entry.tables.as_ref(),
                    entry.sheet.as_ref(),
                ))
            })
            .collect();
        acknowledged = diffs.len() - fresh.len();
        diffs = fresh;
    }

    if args.scan.json {
        let mut output = json!({
            "disagreements": diffs.iter().map(|entry| json!({
                "file": entry.file,
                "line": entry.line,
                "literal": entry.literal,
                "tables": entry.tables.clone().unwrap_or_default(),
                "sheet": entry.sheet.clone().unwrap_or_default(),
            })).collect::<Vec<_>>(),
        });
        // Only under --ack: the plain --json output is the snapshot format,
        // and the snapshot must stay nothing but disagreements.
        if args.ack.is_some() {
            output["staleAcks"] = serde_json::Value::Array(stale);
        }
        print_json(&output);
        return if args.ack.is_some() && !diffs.is_empty() {
            ExitCode::FAILURE
        } else {
            ExitCode::SUCCESS
        };
    }

    for entry in &diffs {
        println!("{}:{}", entry.file, entry.line);
        println!("  in             \"{}\"", entry.literal);
        println!("  tailwind-fuse  {}", verdict(entry.tables.as_ref()));
        println!("  stylesheet     {}", verdict(entry.sheet.as_ref()));
        if in_actions() {
            annotate(
                &entry.file,
                entry.line,
                &format!(
                    "oracles disagree on \"{}\": tailwind-fuse {}, stylesheet {}",
                    entry.literal,
                    verdict(entry.tables.as_ref()),
                    verdict(entry.sheet.as_ref())
                ),
            );
        }
    }

    if let Some(ack_file) = &args.ack {
        if diffs.is_empty() {
            println!("overrule: no new disagreements, {acknowledged} acknowledged.");
        } else {
            println!(
                "\n{} new {}, {acknowledged} acknowledged. Inspect each one, then refresh the snapshot with cross --json.",
                diffs.len(),
                plural(diffs.len(), "disagreement", "disagreements")
            );
        }
        if !stale.is_empty() {
            println!(
                "{} of {ack_total} acknowledged {} matched nothing; prune them from {}.",
                stale.len(),
                plural(ack_total, "entry", "entries"),
                ack_file.display()
            );
        }
        return if diffs.is_empty() {
            ExitCode::SUCCESS
        } else {
            ExitCode::FAILURE
        };
    }

    if diffs.is_empty() {
        println!(
            "overrule: both oracles agree across {total} conflicting {}.",
            plural(total, "string", "strings")
        );
    } else {
        println!(
            "\n{} {}. Each one is a bug in overrule or a table misclassification worth reporting.",
            diffs.len(),
            plural(diffs.len(), "disagreement", "disagreements")
        );
    }
    ExitCode::SUCCESS
}
