#!/usr/bin/env bash
# Publishes the npm packages the release workflow assembled and attached to
# the GitHub release. Platform packages go first, the wrapper last, so the
# wrapper never points at versions that do not exist yet.
#
# 2FA: each publish asks for a fresh code from the authenticator app and
# passes it as --otp, because npm's browser fallback cannot open anything
# from WSL. Leave the prompt empty to let npm try its own flow.
#
#   scripts/publish-npm.sh v0.4.0
set -euo pipefail

tag="${1:?usage: scripts/publish-npm.sh vX.Y.Z}"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT

publish() {
	local otp
	read -r -p "OTP for $(basename "$1"): " otp </dev/tty
	if [ -n "$otp" ]; then
		(cd "$1" && npm publish --otp="$otp")
	else
		(cd "$1" && npm publish)
	fi
}

gh release download "$tag" --pattern npm-packages.tar.gz --dir "$dir"
tar xzf "$dir/npm-packages.tar.gz" -C "$dir"

for pkg in "$dir"/overrule-*; do
	publish "$pkg"
done
publish "$dir/overrule"

echo "published. npx overrule@${tag#v} now runs the binary."
