#!/usr/bin/env bash
# Build the Dot Motion Builder single-binary distribution.
#
# Usage:
#   ./scripts/build-binary.sh                  # host platform + windows/amd64
#   ./scripts/build-binary.sh windows/amd64    # one explicit target
#   ./scripts/build-binary.sh all              # common release matrix
#
# Each target produces one self-contained executable with the compiled
# frontend embedded (no Node.js, no external assets at runtime).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --- Resolve toolchain -----------------------------------------------------
GO_BIN="${GO_BIN:-go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  GO_BIN="/home/z/.local/go/bin/go"
fi
if ! "$GO_BIN" version >/dev/null 2>&1; then
  echo "error: Go toolchain not found (install Go 1.27.1+ or set GO_BIN)" >&2
  exit 1
fi
echo "toolchain: $("$GO_BIN" version)"

PNPM_BIN="${PNPM_BIN:-pnpm}"
if ! command -v "$PNPM_BIN" >/dev/null 2>&1; then
  PNPM_BIN="npx pnpm"
fi

# --- Build the frontend static export --------------------------------------
echo "==> installing frontend dependencies"
$PNPM_BIN install --frozen-lockfile

echo "==> building frontend (next build, output: 'export')"
$PNPM_BIN build

echo "==> staging export for embedding (server/frontend)"
rm -rf server/frontend
cp -a out server/frontend

# --- Version metadata --------------------------------------------------------
VERSION="$(node -p 'require("./package.json").version')"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo none)"
LDFLAGS="-s -w -X main.appVersion=${VERSION}"

# --- Target matrix -----------------------------------------------------------
HOST_OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  x86_64|amd64) HOST_ARCH=amd64 ;;
  aarch64|arm64) HOST_ARCH=arm64 ;;
esac

if [[ "${1:-}" == "all" ]]; then
  TARGETS=("windows/amd64" "windows/arm64" "linux/amd64" "linux/arm64" "darwin/amd64" "darwin/arm64")
elif [[ $# -gt 0 ]]; then
  TARGETS=("$@")
else
  TARGETS=("${HOST_OS}/${HOST_ARCH}" "windows/amd64")
fi

mkdir -p bin
for target in "${TARGETS[@]}"; do
  GOOS="${target%%/*}"
  GOARCH="${target##*/}"
  case "$GOOS" in
    windows) EXT=".exe"
             # windowsgui: no console window, the Win32 control panel is the UI.
             GUI_LDFLAGS=" -H windowsgui" ;;
    *)       EXT=""
             GUI_LDFLAGS="" ;;
  esac
  OUT="bin/dot-motion-builder-${GOOS}-${GOARCH}${EXT}"
  echo "==> compiling ${GOOS}/${GOARCH} -> ${OUT}"
  (cd server && GOOS="$GOOS" GOARCH="$GOARCH" CGO_ENABLED=0 \
    "$GO_BIN" build -trimpath -ldflags "${LDFLAGS}${GUI_LDFLAGS}" -o "../$OUT" .)
done

echo
echo "done. artifacts in bin/:"
ls -lh bin
echo
echo "run: ./bin/dot-motion-builder-${HOST_OS}-${HOST_ARCH}   (options: -addr :8080 -no-open -quiet -version)"
