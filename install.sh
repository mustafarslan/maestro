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
# MAESTRO_BASE_URL serves a mirror or an internal artifact store; MAESTRO_TOKEN adds an
# Authorization header for a private release. Without either this is a plain public
# download, which is the case that must stay dependency-free.
BASE_URL="${MAESTRO_BASE_URL:-}"
if [ -n "$BASE_URL" ]; then
  URL="${BASE_URL%/}/${ASSET}"
elif [ "$VERSION" = "latest" ]; then
  URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
else
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${ASSET}"
fi


bold "Installing Maestro (${OS}-${ARCH})"
dim "  from ${URL}"

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

DOWNLOAD_OK=0
if [ -n "${MAESTRO_TOKEN:-}" ] && [ -z "$BASE_URL" ]; then
  # A private GitHub release cannot be fetched from the browser download URL even with a
  # token: that path 404s. The asset must be requested through the API by its id, with
  # Accept: application/octet-stream. Resolved with grep and sed so the installer keeps
  # its only dependency being curl.
  if [ "$VERSION" = "latest" ]; then
    API="https://api.github.com/repos/${REPO}/releases/latest"
  else
    API="https://api.github.com/repos/${REPO}/releases/tags/${VERSION}"
  fi
  ASSET_URL="$(curl -fsSL -H "Authorization: Bearer ${MAESTRO_TOKEN}" \
      -H "Accept: application/vnd.github+json" "$API" 2>/dev/null \
    | tr ',' '\n' \
    | grep -A0 "\"url\": \"https://api.github.com/repos/${REPO}/releases/assets/" \
    | sed -n "s/.*\(https:\/\/api.github.com\/repos\/[^\"]*\).*/\1/p" \
    | while read -r candidate; do
        name="$(curl -fsSL -H "Authorization: Bearer ${MAESTRO_TOKEN}" \
          -H "Accept: application/vnd.github+json" "$candidate" 2>/dev/null \
          | sed -n 's/.*"name": "\([^"]*\)".*/\1/p' | head -1)"
        [ "$name" = "$ASSET" ] && { echo "$candidate"; break; }
      done)"

  if [ -n "$ASSET_URL" ]; then
    curl -fsSL -H "Authorization: Bearer ${MAESTRO_TOKEN}" \
      -H "Accept: application/octet-stream" "$ASSET_URL" -o "$TMP" && DOWNLOAD_OK=1
  fi
elif [ -n "${MAESTRO_TOKEN:-}" ]; then
  curl -fsSL -H "Authorization: Bearer ${MAESTRO_TOKEN}" "$URL" -o "$TMP" && DOWNLOAD_OK=1
else
  curl -fsSL "$URL" -o "$TMP" && DOWNLOAD_OK=1
fi

if [ "$DOWNLOAD_OK" -ne 1 ]; then
  red "Download failed from:"
  red "  ${URL}"
  if [ -z "${MAESTRO_TOKEN:-}" ]; then
    red "If this is a private repository, set MAESTRO_TOKEN to a token that can read it."
  fi
  exit 1
fi

# A download that "succeeds" but produced nothing is a broken install that only shows up
# later, as a confusing exec error rather than a download problem.
if [ ! -s "$TMP" ]; then
  red "Downloaded file is empty: ${URL}"
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
# Under `set -e` an `&&` chain that fails would abort the script here with no message,
# leaving a new user with a broken binary and a silent exit.
if ! "$INSTALL_DIR/maestro" --version >/dev/null 2>&1; then
  red "The downloaded binary does not run on this platform."
  red "Maestro ships glibc binaries; musl hosts (Alpine) are not supported yet."
  exit 1
fi
dim "binary verified"
bold "Next steps"
printf '  %s init      # create ~/.maestro and seed the default playbook\n' "$INSTALL_DIR/maestro"
printf '  %s doctor    # check Docker, git, database and playbook health\n' "$INSTALL_DIR/maestro"
echo
