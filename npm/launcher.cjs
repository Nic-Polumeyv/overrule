#!/usr/bin/env node
// The npm-facing entry. The real overrule is a native binary delivered by
// the platform package npm picked from optionalDependencies; this shim finds
// it and hands over. CommonJS on purpose: it runs everywhere node does.
const { spawnSync } = require('node:child_process');

// glibc names itself in the process report; musl stays silent. A report that
// cannot be read counts as glibc, the common case.
function isMusl() {
	try {
		return !process.report.getReport().header.glibcVersionRuntime;
	} catch {
		return false;
	}
}

// Package names follow one rule: overrule-<os>-<arch>, win32 spelled windows
// (npm's spam filter blocks unscoped *-win32-* names), -musl appended on
// musl. Which of those names exist is not knowledge this file keeps: the
// wrapper's optionalDependencies, generated from TARGETS in
// scripts/assemble-npm.mjs, is the one list.
const os = process.platform === 'win32' ? 'windows' : process.platform;
const musl = process.platform === 'linux' && isMusl() ? '-musl' : '';
const pkg = `overrule-${os}-${process.arch}${musl}`;

if (!Object.hasOwn(require('../package.json').optionalDependencies ?? {}, pkg)) {
	console.error(
		`overrule: no prebuilt binary for ${process.platform}-${process.arch}${musl}. ` +
			'Build from source: cargo build --release in the repo.',
	);
	process.exit(1);
}

let bin;
try {
	bin = require.resolve(`${pkg}/${process.platform === 'win32' ? 'overrule.exe' : 'overrule'}`);
} catch {
	console.error(
		`overrule: the ${pkg} package is missing. npm installs it as an optionalDependency; ` +
			'make sure optional dependencies are not disabled, then reinstall.',
	);
	process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
if (result.error) {
	// Without this a corrupt or wrong-libc binary exits 1 with no output,
	// indistinguishable from "conflicts found".
	console.error(`overrule: could not run ${bin}: ${result.error.message}`);
	process.exit(1);
}
if (result.signal) {
	process.kill(process.pid, result.signal);
}
process.exit(result.status ?? 1);
