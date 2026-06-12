//! tailwind-merge as a dev tool, not a dependency. The Rust rewrite.
//!
//! Same architecture as the npm package, minus the runtime half: guard and
//! join live in consumers' dev bundles, which is JavaScript's turf and stays
//! there.
//!
//! - [`parse`]: the tokenizer, structure only, never guesses what a utility means
//! - [`oracle`]: the conflict oracle seam; tailwind-fuse plays tailwind-merge
//! - [`scan`]: walker, literal extraction, and the fix rewriter
//! - [`css`]: the stylesheet-derived oracle, pure judging over compiled CSS
//! - [`bridge`]: the one impure corner, compiling candidates with Tailwind itself

pub mod bridge;
pub mod css;
pub mod oracle;
pub mod parse;
pub mod scan;

#[cfg(test)]
mod neutrality {
    // Port of the npm package's platform-neutrality test: the judging logic
    // must work anywhere, so only scan, bridge, and the CLI may touch the
    // platform.
    #[test]
    fn only_scan_bridge_and_the_cli_touch_the_platform() {
        let neutral = [
            ("parse.rs", include_str!("parse.rs")),
            ("oracle.rs", include_str!("oracle.rs")),
            ("css.rs", include_str!("css.rs")),
        ];
        for (file, src) in neutral {
            for needle in ["std::fs", "std::process", "std::env", "std::io"] {
                assert!(
                    !src.contains(needle),
                    "{file} must stay platform-neutral, found {needle}"
                );
            }
        }
    }
}
