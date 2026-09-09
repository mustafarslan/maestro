#!/usr/bin/env sh
#
# Maestro installer.
#
#   curl -fsSL https://raw.githubusercontent.com/mustafarslan/maestro/master/install.sh | sh
#
# Downloads the single self-contained binary for this platform. Docker is the one
# dependency the installer cannot provide; `maestro doctor` checks for it afterwards
# and prints what to do.

set -eu

REPO="${MAESTRO_REPO:-mustafarslan/maestro}"
VERSION="${MAESTRO_VERSION:-latest}"
INSTALL_DIR="${MAESTRO_INSTALL_DIR:-$HOME/.maestro/bin}"

red() { printf '\033[31m%s\033[0m\n' "$1" >&2; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }
bold() { printf '\033[1m%s\033[0m\n' "$1"; }

case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux" ;;
  *) red "Unsupported OS: $(uname -s). Maestro ships binaries for macOS and Linux."; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) red "Unsupported architecture: $(uname -m)."; exit 1 ;;
esac

ASSET="maestro-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi

bold "Installing Maestro (${OS}-${ARCH})"
dim "  from ${URL}"

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$URL" -o "$TMP"; then
  red "Download failed. Check that a release exists at:"
  red "  https://github.com/${REPO}/releases"
  exit 1
fi

chmod +x "$TMP"
mv "$TMP" "$INSTALL_DIR/maestro"
trap - EXIT

printf '  installed to %s\n' "$INSTALL_DIR/maestro"

# Only offer to touch a shell profile; never edit one silently.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo
    bold "Add Maestro to your PATH:"
    printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

echo
"$INSTALL_DIR/maestro" --version >/dev/null 2>&1 && dim "binary verified"
bold "Next steps"
printf '  %s init      # create ~/.maestro and seed the default playbook\n' "$INSTALL_DIR/maestro"
printf '  %s doctor    # check Docker, git, database and playbook health\n' "$INSTALL_DIR/maestro"
echo
