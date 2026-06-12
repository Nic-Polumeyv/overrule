//! The one impure corner: compiling candidates with Tailwind itself. The
//! compiler is the ground truth for what a class does, and the compiler is
//! written in JavaScript, so this module stages a small node script and feeds
//! it the scanned tokens in one batch. Everything that comes back is judged
//! by [`crate::css`], which never leaves Rust.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

use crate::css::AstNode;

const DUMP_SCRIPT: &str = include_str!("../bridge/dump-asts.mjs");

/// Compile candidate tokens with the scanned project's own Tailwind. Returns
/// token/AST pairs ready for [`crate::css::CompiledCandidates::from_asts`].
/// `css_entry` is the stylesheet that imports tailwindcss; without it, a bare
/// import resolved from the current directory.
pub fn compile_candidates(
    tokens: &[String],
    css_entry: Option<&Path>,
) -> Result<Vec<(String, Vec<AstNode>)>, String> {
    let script = std::env::temp_dir().join("overrule-dump-asts.mjs");
    std::fs::write(&script, DUMP_SCRIPT)
        .map_err(|e| format!("could not stage the bridge script: {e}"))?;

    let mut command = Command::new("node");
    command.arg(&script);
    if let Some(entry) = css_entry {
        command.arg(entry);
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run node, which the stylesheet oracle needs: {e}"))?;

    let payload = serde_json::to_vec(tokens).expect("a token list serializes");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(&payload)
        .map_err(|e| format!("could not hand the tokens to node: {e}"))?;

    let output = child
        .wait_with_output()
        .map_err(|e| format!("node did not finish: {e}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let asts: Vec<Vec<AstNode>> = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("could not read Tailwind's answer: {e}"))?;
    Ok(tokens.iter().cloned().zip(asts).collect())
}
