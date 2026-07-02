// Assembles the publishable npm packages from prebuilt binaries: one tiny
// package per platform plus the overrule wrapper whose bin is the launcher.
// The release workflow runs this with all seven targets; pass --partial to
// assemble whatever subset exists locally for testing.
//
//   node scripts/assemble-npm.mjs <version> <binaries-dir> <out-dir> [--partial]
//
// <binaries-dir> holds one directory per target triple, each containing the
// overrule binary, which is exactly what actions/download-artifact produces.
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Package names must match PACKAGES in npm/launcher.cjs; the two lists have
// drifted before. Both linux x64 packages declare the same os and cpu, so
// the libc field is what stops installers that understand it (npm >= 10.4,
// pnpm, yarn) from fetching the wrong one; older installers fetch both and
// the launcher picks at runtime. Windows is never win32 in a name: npm's
// spam filter blocks unscoped *-win32-* packages.
const TARGETS = {
	'x86_64-unknown-linux-gnu': { name: 'overrule-linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc', bin: 'overrule' },
	'x86_64-unknown-linux-musl': { name: 'overrule-linux-x64-musl', os: 'linux', cpu: 'x64', libc: 'musl', bin: 'overrule' },
	'aarch64-unknown-linux-gnu': { name: 'overrule-linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', bin: 'overrule' },
	'x86_64-apple-darwin': { name: 'overrule-darwin-x64', os: 'darwin', cpu: 'x64', bin: 'overrule' },
	'aarch64-apple-darwin': { name: 'overrule-darwin-arm64', os: 'darwin', cpu: 'arm64', bin: 'overrule' },
	'x86_64-pc-windows-msvc': { name: 'overrule-windows-x64', os: 'win32', cpu: 'x64', bin: 'overrule.exe' },
	'aarch64-pc-windows-msvc': { name: 'overrule-windows-arm64', os: 'win32', cpu: 'arm64', bin: 'overrule.exe' },
};

const REPO = { type: 'git', url: 'git+https://github.com/Nic-Polumeyv/overrule.git' };

const [version, binariesDir, outDir] = process.argv.slice(2);
const partial = process.argv.includes('--partial');
if (!version || !binariesDir || !outDir) {
	console.error('usage: node scripts/assemble-npm.mjs <version> <binaries-dir> <out-dir> [--partial]');
	process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
rmSync(outDir, { recursive: true, force: true });

const assembled = [];
for (const [target, platform] of Object.entries(TARGETS)) {
	const binary = join(binariesDir, target, platform.bin);
	if (!existsSync(binary)) {
		if (partial) continue;
		console.error(`missing binary for ${target}: ${binary}`);
		process.exit(1);
	}
	const dir = join(outDir, platform.name);
	mkdirSync(dir, { recursive: true });
	cpSync(binary, join(dir, platform.bin));
	chmodSync(join(dir, platform.bin), 0o755);
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify(
			{
				name: platform.name,
				version,
				description: `the overrule binary for ${platform.os}-${platform.cpu}`,
				repository: REPO,
				license: 'MIT',
				os: [platform.os],
				cpu: [platform.cpu],
				...(platform.libc ? { libc: [platform.libc] } : {}),
				files: [platform.bin],
			},
			null,
			'\t',
		) + '\n',
	);
	assembled.push(platform.name);
}

const wrapper = join(outDir, 'overrule');
mkdirSync(join(wrapper, 'bin'), { recursive: true });
// .cjs, not .js: the package is `type: module` now (for the runtime), and the
// launcher is CommonJS. The extension keeps node parsing it as CJS regardless.
cpSync(join(root, 'npm/launcher.cjs'), join(wrapper, 'bin/overrule.cjs'));
cpSync(join(root, 'README.md'), join(wrapper, 'README.md'));
cpSync(join(root, 'LICENSE'), join(wrapper, 'LICENSE'));
// The JS runtime half — join/guard/test run in consumers' dev bundles; the binary is
// the CLI half. Built by `tsc -p tsconfig.runtime.json` into runtime-dist/.
cpSync(join(root, 'runtime-dist'), join(wrapper, 'runtime'), { recursive: true });
writeFileSync(
	join(wrapper, 'package.json'),
	JSON.stringify(
		{
			name: 'overrule',
			version,
			description: 'catch Tailwind class conflicts before they ship. Native binary CLI plus the join/guard runtime.',
			repository: REPO,
			license: 'MIT',
			type: 'module',
			// Honest only while the runtime keeps zero module-scope side effects.
			sideEffects: false,
			bin: { overrule: 'bin/overrule.cjs' },
			engines: { node: '>=18' },
			exports: {
				'.': { types: './runtime/index.d.ts', default: './runtime/index.js' },
				'./oracle': { types: './runtime/oracle.d.ts', default: './runtime/oracle.js' },
				'./map': { types: './runtime/map-oracle.d.ts', default: './runtime/map-oracle.js' },
				'./test': { types: './runtime/test.d.ts', default: './runtime/test.js' },
				'./props': { types: './runtime/props.d.ts', default: './runtime/props.js' },
			},
			// tailwind-merge backs createTwMergeOracle only; the root entry never
			// imports it, so it must not install by default.
			peerDependencies: { 'tailwind-merge': '^3.0.0' },
			peerDependenciesMeta: { 'tailwind-merge': { optional: true } },
			optionalDependencies: Object.fromEntries(Object.values(TARGETS).map((p) => [p.name, version])),
			files: ['bin', 'runtime'],
		},
		null,
		'\t',
	) + '\n',
);

console.log(`assembled ${assembled.length} platform packages + wrapper at ${outDir} (version ${version})`);
