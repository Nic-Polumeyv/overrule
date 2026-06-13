#!/usr/bin/env node
// The npm-facing entry. The real overrule is a native binary delivered by
// the platform package npm picked from optionalDependencies; this shim finds
// it and hands over. CommonJS on purpose: it runs everywhere node does.
const { spawnSync } = require('node:child_process');

const PACKAGES = {
	'linux-x64': 'overrule-linux-x64',
	'linux-arm64': 'overrule-linux-arm64',
	'darwin-x64': 'overrule-darwin-x64',
	'darwin-arm64': 'overrule-darwin-arm64',
	'win32-x64': 'overrule-windows-x64',
};

const key = `${process.platform}-${process.arch}`;
const pkg = PACKAGES[key];
if (!pkg) {
	console.error(`overrule: no prebuilt binary for ${key}. Build from source: cargo build --release in the repo.`);
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
process.exit(result.status ?? 1);
