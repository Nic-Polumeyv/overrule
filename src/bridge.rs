//! The one impure corner: compiling candidates with Tailwind itself. The
//! compiler is the ground truth for what a class does, and the compiler is
//! written in JavaScript, so this module stages a small node script and feeds
//! it the scanned tokens in one batch. Everything that comes back is judged
//! by [`crate::css`], which never leaves Rust.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::css::AstNode;

const DUMP_SCRIPT: &str = include_str!("../bridge/dump-asts.mjs");

/// The staged script, removed on every exit path.
struct StagedScript(PathBuf);

impl Drop for StagedScript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// A fixed name in the shared temp dir invites pre-planted files on
/// multi-user machines and races between concurrent overrule processes.
/// pid + counter + clock makes each staging unique, and `create_new`
/// refuses whatever might already sit at the path, symlinks included.
fn stage_script() -> Result<StagedScript, String> {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let pid = std::process::id();
    for _ in 0..16 {
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos());
        let path =
            std::env::temp_dir().join(format!("overrule-dump-asts-{pid}-{count}-{nanos}.mjs"));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let staged = StagedScript(path);
                file.write_all(DUMP_SCRIPT.as_bytes())
                    .map_err(|e| format!("could not stage the bridge script: {e}"))?;
                return Ok(staged);
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("could not stage the bridge script: {e}")),
        }
    }
    Err("could not stage the bridge script: every candidate path was taken".to_string())
}

/// Compile candidate tokens with the scanned project's own Tailwind. Returns
/// token/AST pairs ready for [`crate::css::CompiledCandidates::from_asts`].
/// `css_entry` is the stylesheet that imports tailwindcss; without it, a bare
/// import resolved from the current directory.
pub fn compile_candidates(
    tokens: &[String],
    css_entry: Option<&Path>,
) -> Result<Vec<(String, Vec<AstNode>)>, String> {
    let script = stage_script()?;

    let mut command = Command::new("node");
    command.arg(&script.0);
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
    // zip would silently truncate and misread absent tokens as typos.
    if asts.len() != tokens.len() {
        return Err(format!(
            "sent {} tokens but Tailwind answered with {} ASTs; the pairing would be a guess",
            tokens.len(),
            asts.len()
        ));
    }
    Ok(tokens.iter().cloned().zip(asts).collect())
}
