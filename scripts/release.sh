#!/usr/bin/env bash
#
# Cuts a release from this machine.
#
#   scripts/release.sh            # builds all four binaries, verifies, does not publish
#   scripts/release.sh --publish  # …and creates the GitHub release
#
# `.github/workflows/release.yml` does the same thing and cannot be used here: this
# account has no Actions credits, so a tagged release failed in CI rather than building.
# That made releases impossible, which made `install.sh` theoretical — and, once the
# egress proxy started fetching a Linux build of itself, made the enforced posture
# unreachable on any macOS host. A release is not a nicety for this project.
#
# Bun cross-compiles all four targets from one machine, so this needs no second runner.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"   # bun is not on a non-interactive shell's PATH

PUBLISH=0
[ "${1:-}" = "--publish" ] && PUBLISH=1

VERSION="$(node -e 'import("./packages/core/dist/version.js").then(m=>console.log(m.MAESTRO_VERSION))' 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "could not read MAESTRO_VERSION - run 'pnpm exec tsc -b' first" >&2
  exit 1
fi
TAG="v${VERSION}"

if [ "$PUBLISH" = "1" ] && gh release view "$TAG" >/dev/null 2>&1; then
  # Overwriting a published release would change bytes people have already installed,
  # and the proxy caches binaries by version — a cache filled from the old asset would
  # never be refreshed.
  echo "release ${TAG} already exists. Bump MAESTRO_VERSION in packages/core/src/version.ts." >&2
  exit 1
fi

echo "building ${TAG}"
pnpm run build:ui >/dev/null
pnpm exec tsc -b

build() {  # target, bun-target
  echo "  $1"
  bun build --compile --target="$2" --outfile "dist/maestro-$1" apps/cli/dist/index.js >/dev/null
}
build darwin-arm64 bun-darwin-aarch64
build darwin-x64   bun-darwin-x64
build linux-x64    bun-linux-x64
build linux-arm64  bun-linux-aarch64

# The host's own binary must run, and must report the version this release claims. A
# release whose binary prints a different version is worse than no release: the proxy
# caches by version and would ask for an asset that does not match what it got.
HOST_ASSET="dist/maestro-darwin-arm64"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) HOST_ASSET="dist/maestro-darwin-x64" ;;
  Linux-aarch64) HOST_ASSET="dist/maestro-linux-arm64" ;;
  Linux-x86_64)  HOST_ASSET="dist/maestro-linux-x64" ;;
esac
chmod +x dist/maestro-*
GOT="$("$HOST_ASSET" --version)"
[ "$GOT" = "$VERSION" ] || { echo "built binary reports '$GOT', expected '$VERSION'" >&2; exit 1; }

# And the Linux binary must actually carry the egress-proxy subcommand, checked in a
# container rather than assumed. This is the asset the proxy downloads; a release that
# predates the subcommand fails inside a container nobody is watching, which is how the
# v0.1.0 assets behaved.
ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo none)"
case "$ARCH" in
  arm64|aarch64) LINUX_ASSET="dist/maestro-linux-arm64" ;;
  amd64|x86_64)  LINUX_ASSET="dist/maestro-linux-x64" ;;
  *) LINUX_ASSET="" ;;
esac
if [ -n "$LINUX_ASSET" ]; then
  CID="$(docker create --entrypoint /usr/local/bin/maestro debian:bookworm-slim egress-proxy --help)"
  docker cp "$LINUX_ASSET" "$CID:/usr/local/bin/maestro" >/dev/null
  docker start -a "$CID" >/dev/null 2>&1 || true
  if docker logs "$CID" 2>&1 | grep -q "egress-proxy"; then
    echo "  linux binary carries egress-proxy"
  else
    docker rm -f "$CID" >/dev/null
    echo "the linux binary does not answer 'egress-proxy --help'" >&2
    exit 1
  fi
  docker rm -f "$CID" >/dev/null
else
  echo "  (no docker; skipped the egress-proxy check on the linux asset)"
fi

ls -la dist/maestro-darwin-arm64 dist/maestro-darwin-x64 dist/maestro-linux-x64 dist/maestro-linux-arm64

if [ "$PUBLISH" != "1" ]; then
  echo
  echo "built but not published. Re-run with --publish to create ${TAG}."
  exit 0
fi

gh release create "$TAG" \
  --title "$TAG" \
  --notes "Binaries for macOS and Linux. Install with:

    curl -fsSL https://raw.githubusercontent.com/mustafarslan/maestro/master/install.sh | sh" \
  dist/maestro-darwin-arm64 dist/maestro-darwin-x64 dist/maestro-linux-x64 dist/maestro-linux-arm64
echo "published ${TAG}"
