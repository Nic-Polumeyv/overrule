#!/usr/bin/env bash
# Publishes the npm packages the release workflow assembled and attached to
# the GitHub release. Platform packages go first, the wrapper last, so the
# wrapper never points at versions that do not exist yet. npm prompts for
# the OTP on each publish; that is the 2FA tax, six prompts total.
#
#   scripts/publish-npm.sh v0.4.0
set -euo pipefail

tag="${1:?usage: scripts/publish-npm.sh vX.Y.Z}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

gh release download "$tag" --pattern npm-packages.tar.gz --dir "$dir"
tar xzf "$dir/npm-packages.tar.gz" -C "$dir"

for pkg in "$dir"/overrule-*; do
	(cd "$pkg" && npm publish)
done
(cd "$dir/overrule" && npm publish)

echo "published. npx overrule@${tag#v} now runs the binary."
