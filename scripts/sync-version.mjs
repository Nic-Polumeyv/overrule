// Carries the version changesets wrote into package.json over to Cargo.toml
// and Cargo.lock, so the Version Packages PR holds all three and the release
// gate reads the same number the changelog announces.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const patch = (file, from, to) => {
	const path = join(root, file);
	const text = readFileSync(path, 'utf8');
	if (!from.test(text)) throw new Error(`${file}: no match for ${from}`);
	writeFileSync(path, text.replace(from, to));
};

patch('Cargo.toml', /^version = ".*"$/m, `version = "${version}"`);
patch('Cargo.lock', /(\[\[package\]\]\nname = "overrule"\nversion = ")[^"]*/, `$1${version}`);
console.log(`synced Cargo.toml and Cargo.lock to ${version}`);
