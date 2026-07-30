//! Hand-rolled argument parsing with clap's exact surface: the help pages,
//! error wording, exit codes, and did-you-mean tips are byte-identical to
//! what clap 4.6 produced, snapshot-verified across the whole parse matrix.
//! Help and version print and exit here; parse errors print to stderr and
//! exit 2, like clap's Error::exit.

use std::ffi::OsString;
use std::path::PathBuf;
use std::process::exit;

pub enum Command {
    Check(ScanArgs),
    Fix(ScanArgs),
    Cross(CrossArgs),
    Judge(JudgeArgs),
    Map(MapArgs),
}

pub struct ScanArgs {
    pub paths: Vec<PathBuf>,
    pub css: Option<PathBuf>,
    pub json: bool,
}

pub struct CrossArgs {
    pub scan: ScanArgs,
    pub ack: Option<PathBuf>,
}

pub struct MapArgs {
    pub paths: Vec<PathBuf>,
    pub css: PathBuf,
    pub out: Option<PathBuf>,
}

pub struct JudgeArgs {
    pub literals: Vec<String>,
    pub css: Option<PathBuf>,
    pub json: bool,
}

const MAIN_HELP: &str = "catch Tailwind class conflicts before they ship

Usage: overrule [COMMAND]

Commands:
  check  report class strings with conflicting tokens (exit 1 if any)
  fix    rewrite conflicting literals, losers removed
  cross  report every string where tailwind-fuse and your stylesheet disagree
  judge  judge class strings given as arguments or on stdin, one per line
  map    emit the stylesheet-derived conflict map for the JS dev-time oracle
  help   Print this message or the help of the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version
";

const HELP_HELP: &str = "Print this message or the help of the given subcommand(s)

Usage: overrule help [COMMAND]...

Arguments:
  [COMMAND]...  Print help for the subcommand(s)
";

const SCAN_CSS_HELP: &str = "judge with your compiled stylesheet instead of tailwind-fuse's tables. Point it at the CSS entry that imports tailwindcss; your theme, custom utilities, and prefix all count. Tokens that compile to nothing get listed too. cross uses a bare tailwindcss import when --css is missing";
const SCAN_JSON_HELP: &str = "machine output. Findings for check and fix, disagreements for cross";
const SCAN_PATHS_HELP: &str =
    "paths to scan; node_modules, dist, and friends are skipped [default: .]";

struct Flag {
    long: &'static str,
    value: bool,
    required: bool,
    /// Member of the command's implicit clap arg group (every flag except
    /// cross's --ack, which lived outside the flattened ScanArgs struct).
    grouped: bool,
    help: &'static str,
}

struct Sub {
    name: &'static str,
    about: &'static str,
    positional: &'static str,
    positional_help: &'static str,
    flags: &'static [Flag],
    /// String positionals (judge) accept empty and demand UTF-8; path
    /// positionals reject empty the way clap's PathBuf parser did.
    strings: bool,
}

const CSS_FLAG: Flag = Flag {
    long: "css",
    value: true,
    required: false,
    grouped: true,
    help: SCAN_CSS_HELP,
};
const JSON_FLAG: Flag = Flag {
    long: "json",
    value: false,
    required: false,
    grouped: true,
    help: SCAN_JSON_HELP,
};

const SUBS: &[Sub] = &[
    Sub {
        name: "check",
        about: "report class strings with conflicting tokens (exit 1 if any)",
        positional: "PATHS",
        positional_help: SCAN_PATHS_HELP,
        flags: &[CSS_FLAG, JSON_FLAG],
        strings: false,
    },
    Sub {
        name: "fix",
        about: "rewrite conflicting literals, losers removed",
        positional: "PATHS",
        positional_help: SCAN_PATHS_HELP,
        flags: &[CSS_FLAG, JSON_FLAG],
        strings: false,
    },
    Sub {
        name: "cross",
        about: "report every string where tailwind-fuse and your stylesheet disagree",
        positional: "PATHS",
        positional_help: SCAN_PATHS_HELP,
        flags: &[
            CSS_FLAG,
            JSON_FLAG,
            Flag {
                long: "ack",
                value: true,
                required: false,
                grouped: false,
                help: "a snapshot from cross --json listing acknowledged disagreements; anything not in it prints and exits 1. This is how cross becomes a CI gate instead of an investigation",
            },
        ],
        strings: false,
    },
    Sub {
        name: "judge",
        about: "judge class strings given as arguments or on stdin, one per line",
        positional: "LITERALS",
        positional_help: "class strings to judge; with none given, one per line is read from stdin",
        flags: &[
            Flag {
                long: "css",
                value: true,
                required: false,
                grouped: true,
                help: "judge with your compiled stylesheet instead of tailwind-fuse's tables",
            },
            Flag {
                long: "json",
                value: false,
                required: false,
                grouped: true,
                help: "machine output: one verdict per literal, in input order",
            },
        ],
        strings: true,
    },
    Sub {
        name: "map",
        about: "emit the stylesheet-derived conflict map for the JS dev-time oracle",
        positional: "PATHS",
        positional_help: "paths to scan for class literals; node_modules, dist, and friends are skipped [default: .]",
        flags: &[
            Flag {
                long: "css",
                value: true,
                required: true,
                grouped: true,
                help: "the CSS entry that imports tailwindcss. Required: the map exists to carry your real stylesheet's verdicts, theme, prefix, and custom utilities included",
            },
            Flag {
                long: "out",
                value: true,
                required: false,
                grouped: true,
                help: "write the map here instead of stdout",
            },
        ],
        strings: false,
    },
];

pub fn print_help() {
    print!("{MAIN_HELP}");
}

fn render(flag: &Flag) -> String {
    if flag.value {
        format!("--{} <file>", flag.long)
    } else {
        format!("--{}", flag.long)
    }
}

/// `overrule check [OPTIONS] [PATHS]...`; required flags always show.
fn usage(sub: &Sub) -> String {
    let required: String = sub
        .flags
        .iter()
        .filter(|flag| flag.required)
        .map(|flag| format!(" {}", render(flag)))
        .collect();
    format!(
        "overrule {} [OPTIONS]{} [{}]...",
        sub.name, required, sub.positional
    )
}

/// The usage on errors that involve specific arguments, no [OPTIONS]:
/// required flags in declaration order, then flags already parsed in the
/// order they appeared, then the involved one. A consumed positional renders
/// required-style, `<PATHS>...`.
fn usage_used(
    sub: &Sub,
    used_order: &[usize],
    positional_used: bool,
    extra: Option<&str>,
) -> String {
    let mut order: Vec<usize> = (0..sub.flags.len())
        .filter(|&index| sub.flags[index].required)
        .collect();
    for &index in used_order {
        if !order.contains(&index) {
            order.push(index);
        }
    }
    let mut flags: String = order
        .iter()
        .map(|&index| format!(" {}", render(&sub.flags[index])))
        .collect();
    match extra {
        Some("help") => flags.push_str(" --help"),
        Some(long) => {
            let index = sub.flags.iter().position(|flag| flag.long == long);
            if let Some(index) = index
                && !order.contains(&index)
            {
                flags.push_str(&format!(" {}", render(&sub.flags[index])));
            }
        }
        None => {}
    }
    let positional = if positional_used {
        format!("<{}>...", sub.positional)
    } else {
        format!("[{}]...", sub.positional)
    };
    format!("overrule {}{} {}", sub.name, flags, positional)
}

/// The usage on unexpected-value errors. Values given as `--flag=value` and
/// bool flags are committed at error time; space-form values and positionals
/// are still pending and invisible. A committed group member pulls in clap's
/// implicit arg-group alternation, absorbing the involved flag; groupless
/// flags (--ack) and --help render individually before it.
fn usage_unexpected_value(sub: &Sub, involved: Option<usize>, commit_order: &[usize]) -> String {
    let group_on = commit_order.iter().any(|&index| sub.flags[index].grouped);
    let mut flags = String::new();
    if !group_on {
        for (index, flag) in sub.flags.iter().enumerate() {
            if flag.required && Some(index) != involved {
                flags.push_str(&format!(" {}", render(flag)));
            }
        }
    }
    for &index in commit_order {
        let flag = &sub.flags[index];
        if !flag.required && !flag.grouped {
            flags.push_str(&format!(" {}", render(flag)));
        }
    }
    match involved {
        None => flags.push_str(" --help"),
        Some(index) if !(group_on && sub.flags[index].grouped) => {
            flags.push_str(&format!(" {}", render(&sub.flags[index])));
        }
        Some(_) => {}
    }
    if group_on {
        let members: Vec<String> = std::iter::once(sub.positional.to_string())
            .chain(sub.flags.iter().filter(|flag| flag.grouped).map(render))
            .collect();
        format!("overrule {}{} <{}>", sub.name, flags, members.join("|"))
    } else {
        format!("overrule {}{} [{}]...", sub.name, flags, sub.positional)
    }
}

fn sub_help(sub: &Sub) -> String {
    // Column: the widest left cell is always "--css <file>" here, and the
    // short-flag row indents by two under the six of long-only rows.
    let mut options = String::new();
    for flag in sub.flags {
        options.push_str(&format!("      {:<12}  {}\n", render(flag), flag.help));
    }
    options.push_str("  -h, --help        Print help\n");
    format!(
        "{}\n\nUsage: {}\n\nArguments:\n  [{}]...  {}\n\nOptions:\n{}",
        sub.about,
        usage(sub),
        sub.positional,
        sub.positional_help,
        options
    )
}

fn fail(message: &str, tip: Option<String>, usage: Option<&str>, for_more: bool) -> ! {
    eprintln!("error: {message}");
    if let Some(tip) = tip {
        eprintln!("\n  tip: {tip}");
    }
    if let Some(usage) = usage {
        eprintln!("\nUsage: {usage}");
    }
    if for_more {
        eprintln!("\nFor more information, try '--help'.");
    }
    exit(2)
}

/// strsim's jaro, the similarity clap feeds its did-you-mean tips.
fn jaro(a: &str, b: &str) -> f64 {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let search_range = (a.len().max(b.len()) / 2).saturating_sub(1);
    let mut a_flags = vec![false; a.len()];
    let mut b_flags = vec![false; b.len()];
    let mut matches = 0usize;
    for (i, &ch) in a.iter().enumerate() {
        let lo = i.saturating_sub(search_range);
        let hi = b.len().min(i + search_range + 1);
        for (j, flagged) in b_flags.iter_mut().enumerate().take(hi).skip(lo) {
            if ch == b[j] && !*flagged {
                a_flags[i] = true;
                *flagged = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let mut transpositions = 0usize;
    let mut j = 0usize;
    for (i, matched) in a_flags.iter().enumerate() {
        if !matched {
            continue;
        }
        while !b_flags[j] {
            j += 1;
        }
        if a[i] != b[j] {
            transpositions += 1;
        }
        j += 1;
    }
    ((matches as f64 / a.len() as f64)
        + (matches as f64 / b.len() as f64)
        + ((matches - transpositions / 2) as f64 / matches as f64))
        / 3.0
}

/// The most similar candidate above clap's 0.7 confidence bar; ties keep the
/// later candidate, matching clap's ascending insert plus pop.
fn did_you_mean<'c>(value: &str, candidates: impl IntoIterator<Item = &'c str>) -> Option<&'c str> {
    let mut best: Option<(f64, &str)> = None;
    for candidate in candidates {
        let confidence = jaro(value, candidate);
        if confidence > 0.7 && best.is_none_or(|(top, _)| confidence >= top) {
            best = Some((confidence, candidate));
        }
    }
    best.map(|(_, candidate)| candidate)
}

fn version() -> ! {
    println!("overrule {}", env!("CARGO_PKG_VERSION"));
    exit(0)
}

/// Parse std::env::args_os. None is bare `overrule`, the caller's business;
/// help, version, and every parse error print and exit here.
pub fn parse() -> Option<Command> {
    let mut args = std::env::args_os().skip(1);
    let first = args.next()?;
    let name = first.to_string_lossy();

    match name.as_ref() {
        "-h" | "--help" => {
            print_help();
            exit(0)
        }
        "-V" | "--version" => version(),
        "help" => run_help(args),
        // `overrule --` alone is bare; `-- check` names a real subcommand
        // neutered by the separator, which clap calls out specifically.
        "--" => {
            let next = args.next()?.to_string_lossy().into_owned();
            if next == "help" || SUBS.iter().any(|sub| sub.name == next) {
                fail(
                    &format!("unexpected argument '{next}' found"),
                    Some(format!(
                        "subcommand '{next}' exists; to use it, remove the '--' before it"
                    )),
                    Some("overrule [COMMAND]"),
                    true,
                );
            }
            let tip = did_you_mean(&next, SUBS.iter().map(|sub| sub.name).chain(["help"]))
                .map(|s| format!("a similar subcommand exists: '{s}'"));
            fail(
                &format!("unrecognized subcommand '{next}'"),
                tip,
                Some("overrule [COMMAND]"),
                true,
            )
        }
        _ => {}
    }

    if let Some(sub) = SUBS.iter().find(|sub| sub.name == name) {
        return Some(parse_sub(sub, args));
    }

    // Top level takes no positionals, so flag-shaped input gets argument
    // errors (never the pass-as-value tip) and everything else is an
    // unrecognized subcommand.
    if let Some(long) = name.strip_prefix("--") {
        let long = long.split('=').next().expect("split yields");
        if let Some(similar) = did_you_mean(long, ["help", "version"]) {
            fail(
                &format!("unexpected argument '--{long}' found"),
                Some(format!("a similar argument exists: '--{similar}'")),
                Some(&format!("overrule --{similar}")),
                true,
            );
        }
        // clap's fallback: a subcommand named later on the line carrying a
        // similar flag earns a "'judge --css' exists" tip.
        let remaining: Vec<OsString> = args.collect();
        let owner = SUBS
            .iter()
            .filter_map(|sub| {
                let similar = did_you_mean(long, sub.flags.iter().map(|flag| flag.long))?;
                let score = remaining
                    .iter()
                    .position(|arg| arg.as_os_str() == std::ffi::OsStr::new(sub.name))?;
                Some((score, sub.name, similar))
            })
            .min_by_key(|(score, ..)| *score);
        let tip = owner.map(|(_, sub, similar)| format!("'{sub} --{similar}' exists"));
        fail(
            &format!("unexpected argument '--{long}' found"),
            tip,
            Some("overrule [COMMAND]"),
            true,
        )
    }
    if name.len() > 1 && name.starts_with('-') {
        // Shorts go left to right and every one exits, so only the first
        // char of the cluster ever decides.
        match name[1..].chars().next().expect("length checked") {
            'h' => {
                print_help();
                exit(0)
            }
            'V' => version(),
            c => fail(
                &format!("unexpected argument '-{c}' found"),
                None,
                Some("overrule [COMMAND]"),
                true,
            ),
        }
    }
    let tip = did_you_mean(&name, SUBS.iter().map(|sub| sub.name).chain(["help"]))
        .map(|s| format!("a similar subcommand exists: '{s}'"));
    fail(
        &format!("unrecognized subcommand '{name}'"),
        tip,
        Some("overrule [COMMAND]"),
        true,
    )
}

/// The help subcommand: no tips anywhere on this path, and the help-of-help
/// error is the one place clap prints usage without the for-more footer.
fn run_help(mut args: impl Iterator<Item = OsString>) -> ! {
    let Some(target) = args.next() else {
        print_help();
        exit(0)
    };
    let target = target.to_string_lossy();
    let extra = args.next();
    if target == "help" {
        match extra {
            Some(extra) => fail(
                &format!("unrecognized subcommand '{}'", extra.to_string_lossy()),
                None,
                Some("overrule help [COMMAND]..."),
                false,
            ),
            None => {
                print!("{HELP_HELP}");
                exit(0)
            }
        }
    }
    match SUBS.iter().find(|sub| sub.name == target) {
        Some(sub) => match extra {
            Some(extra) => fail(
                &format!("unrecognized subcommand '{}'", extra.to_string_lossy()),
                None,
                Some(&usage(sub)),
                true,
            ),
            None => {
                print!("{}", sub_help(sub));
                exit(0)
            }
        },
        None => fail(
            &format!("unrecognized subcommand '{target}'"),
            None,
            Some("overrule [COMMAND]"),
            true,
        ),
    }
}

/// A missing or empty value clap does not report at its own token: it fires
/// at the next successfully processed flag (assignment, bool set, or help),
/// or at the end of the line. Unknown-argument and unexpected-value errors
/// bypass it; positionals never trigger it.
enum Pending {
    Flag(usize),
    Positional,
    InvalidUtf8,
}

fn fail_pending(sub: &Sub, pending: &Pending) -> ! {
    let subject = match pending {
        Pending::Flag(index) => render(&sub.flags[*index]),
        Pending::Positional => format!("[{}]...", sub.positional),
        Pending::InvalidUtf8 => fail(
            "invalid UTF-8 was detected in one or more arguments",
            None,
            Some(&usage(sub)),
            true,
        ),
    };
    fail(
        &format!("a value is required for '{subject}' but none was supplied"),
        None,
        None,
        true,
    )
}

fn flush_pending(sub: &Sub, pending: &Option<Pending>) {
    if let Some(pending) = pending {
        fail_pending(sub, pending);
    }
}

fn parse_sub(sub: &Sub, args: impl Iterator<Item = OsString>) -> Command {
    let mut positionals: Vec<OsString> = Vec::new();
    let mut values: Vec<Option<OsString>> = vec![None; sub.flags.len()];
    // assigned is what duplicate errors check: a real value landed. The
    // usage on errors instead lists first-use order, where consuming an
    // empty value counts.
    let mut assigned = vec![false; sub.flags.len()];
    let mut used_order: Vec<usize> = Vec::new();
    let mut commit_order: Vec<usize> = Vec::new();
    // A space-form value stays deferred until the next token is processed;
    // an unexpected-value error on that very token still misses it.
    let mut deferred: Option<usize> = None;
    let mut positional_used = false;
    let mut pending: Option<Pending> = None;
    let mut args = args.peekable();
    let mut literal_only = false;

    while let Some(arg) = args.next() {
        let text = if literal_only { None } else { arg.to_str() };
        match text {
            Some("--") => literal_only = true,
            Some(long) if long.starts_with("--") => {
                let (name, eq_value) = match long[2..].split_once('=') {
                    Some((name, value)) => (name, Some(value.to_string())),
                    None => (&long[2..], None),
                };
                if name == "help" {
                    if let Some(value) = eq_value {
                        fail(
                            &format!(
                                "unexpected value '{value}' for '--help' found; no more were expected"
                            ),
                            None,
                            Some(&usage_unexpected_value(sub, None, &commit_order)),
                            true,
                        );
                    }
                    if let Some(index) = deferred.take() {
                        commit_order.push(index);
                    }
                    flush_pending(sub, &pending);
                    print!("{}", sub_help(sub));
                    exit(0)
                }
                let Some(index) = sub.flags.iter().position(|flag| flag.long == name) else {
                    let candidates = sub.flags.iter().map(|flag| flag.long).chain(["help"]);
                    match did_you_mean(name, candidates) {
                        Some(similar) => fail(
                            &format!("unexpected argument '--{name}' found"),
                            Some(format!("a similar argument exists: '--{similar}'")),
                            Some(&usage_used(
                                sub,
                                &used_order,
                                positional_used,
                                Some(similar),
                            )),
                            true,
                        ),
                        None => {
                            let usage = if positional_used || !used_order.is_empty() {
                                usage_used(sub, &used_order, positional_used, None)
                            } else {
                                usage(sub)
                            };
                            fail(
                                &format!("unexpected argument '--{name}' found"),
                                Some(format!("to pass '--{name}' as a value, use '-- --{name}'")),
                                Some(&usage),
                                true,
                            )
                        }
                    }
                };
                let mark_used = |used_order: &mut Vec<usize>| {
                    if !used_order.contains(&index) {
                        used_order.push(index);
                    }
                };
                let flag = &sub.flags[index];
                if !flag.value {
                    if let Some(value) = eq_value {
                        fail(
                            &format!(
                                "unexpected value '{value}' for '--{name}' found; no more were expected"
                            ),
                            None,
                            Some(&usage_unexpected_value(sub, Some(index), &commit_order)),
                            true,
                        );
                    }
                    if let Some(index) = deferred.take() {
                        commit_order.push(index);
                    }
                    flush_pending(sub, &pending);
                    if assigned[index] {
                        fail(
                            &format!("the argument '--{name}' cannot be used multiple times"),
                            None,
                            Some(&usage(sub)),
                            true,
                        );
                    }
                    assigned[index] = true;
                    mark_used(&mut used_order);
                    commit_order.push(index);
                    continue;
                }
                if let Some(index) = deferred.take() {
                    commit_order.push(index);
                }
                flush_pending(sub, &pending);
                match eq_value {
                    Some(value) => {
                        if assigned[index] {
                            fail(
                                &format!(
                                    "the argument '{}' cannot be used multiple times",
                                    render(flag)
                                ),
                                None,
                                Some(&usage(sub)),
                                true,
                            );
                        }
                        // `--css=` fails on the spot; every other missing
                        // value waits for a later flag or the end of the line.
                        if value.is_empty() {
                            fail(
                                &format!(
                                    "a value is required for '{}' but none was supplied",
                                    render(flag)
                                ),
                                None,
                                None,
                                true,
                            );
                        }
                        assigned[index] = true;
                        mark_used(&mut used_order);
                        commit_order.push(index);
                        values[index] = Some(OsString::from(value));
                    }
                    None => {
                        // A flag-shaped next token is never eaten as a value;
                        // the flag goes pending instead.
                        let flag_like = args.peek().is_none_or(|next| {
                            next.len() > 1 && next.as_encoded_bytes().starts_with(b"-")
                        });
                        if flag_like {
                            pending.get_or_insert(Pending::Flag(index));
                            continue;
                        }
                        let value = args.next().expect("peeked above");
                        if assigned[index] {
                            fail(
                                &format!(
                                    "the argument '{}' cannot be used multiple times",
                                    render(flag)
                                ),
                                None,
                                Some(&usage(sub)),
                                true,
                            );
                        }
                        mark_used(&mut used_order);
                        if value.is_empty() {
                            // Consumed but invalid: counts as used, never as
                            // assigned or committed.
                            pending.get_or_insert(Pending::Flag(index));
                        } else {
                            assigned[index] = true;
                            values[index] = Some(value);
                            deferred = Some(index);
                        }
                    }
                }
            }
            Some(short) if short.len() > 1 && short.starts_with('-') => {
                // Same first-char rule as the top level; unknown shorts show
                // the plain usage whatever was already parsed.
                let c = short[1..].chars().next().expect("length checked");
                if c == 'h' {
                    flush_pending(sub, &pending);
                    print!("{}", sub_help(sub));
                    exit(0)
                }
                fail(
                    &format!("unexpected argument '-{c}' found"),
                    Some(format!("to pass '-{c}' as a value, use '-- -{c}'")),
                    Some(&usage(sub)),
                    true,
                );
            }
            _ => {
                if let Some(index) = deferred.take() {
                    commit_order.push(index);
                }
                positional_used = true;
                if arg.is_empty() && !sub.strings {
                    pending.get_or_insert(Pending::Positional);
                } else if sub.strings && arg.to_str().is_none() {
                    pending.get_or_insert(Pending::InvalidUtf8);
                } else {
                    positionals.push(arg);
                }
            }
        }
    }

    if let Some(pending) = pending {
        fail_pending(sub, &pending);
    }

    for (index, flag) in sub.flags.iter().enumerate() {
        if flag.required && !assigned[index] {
            fail(
                &format!(
                    "the following required arguments were not provided:\n  {}",
                    render(flag)
                ),
                None,
                Some(&usage_used(sub, &used_order, positional_used, None)),
                true,
            );
        }
    }

    let mut take = |long: &str| -> Option<OsString> {
        let index = sub.flags.iter().position(|flag| flag.long == long)?;
        values[index].take()
    };
    let json = sub
        .flags
        .iter()
        .position(|flag| flag.long == "json")
        .is_some_and(|index| assigned[index]);
    let css = take("css").map(PathBuf::from);
    let ack = take("ack").map(PathBuf::from);
    let out = take("out").map(PathBuf::from);

    let paths = |positionals: Vec<OsString>| -> Vec<PathBuf> {
        if positionals.is_empty() {
            vec![PathBuf::from(".")]
        } else {
            positionals.into_iter().map(PathBuf::from).collect()
        }
    };

    match sub.name {
        "check" | "fix" => {
            let args = ScanArgs {
                paths: paths(positionals),
                css,
                json,
            };
            if sub.name == "check" {
                Command::Check(args)
            } else {
                Command::Fix(args)
            }
        }
        "cross" => Command::Cross(CrossArgs {
            scan: ScanArgs {
                paths: paths(positionals),
                css,
                json,
            },
            ack,
        }),
        "judge" => {
            let literals = positionals
                .into_iter()
                .map(|arg| {
                    arg.into_string()
                        .expect("invalid UTF-8 became a pending error")
                })
                .collect();
            Command::Judge(JudgeArgs {
                literals,
                css,
                json,
            })
        }
        "map" => Command::Map(MapArgs {
            paths: paths(positionals),
            css: css.expect("required flag checked above"),
            out,
        }),
        _ => unreachable!("every sub in SUBS is matched"),
    }
}
