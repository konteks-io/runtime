#!/bin/sh
# konteks-remote bootstrap (POSIX; macOS and Debian) — version 1.
#
# Usage (copied verbatim from the Konteks App or MCP activation response):
#   curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --activation-id <id>
#
# This script downloads the signed native launcher package for this platform,
# verifies its checksum against the published, signed checksum manifest and
# its signer identity, installs it, and invokes `konteks-remote install` with
# the NON-SECRET activation ID. It never receives, echoes, or stores the
# activation code (the launcher prompts for it without echo), has no general
# command passthrough, and refuses an unverified package. Signed native
# packages with documented checksums remain a first-class alternative: see
# https://docs.konteks.example/remote-instance/install#offline.
set -eu

BOOTSTRAP_VERSION="1"
RELEASE_BASE="${KONTEKS_RELEASE_BASE:-https://github.com/konteks-io/runtime/releases/latest/download}"
EXPECTED_MACOS_TEAM_ID="${KONTEKS_MACOS_TEAM_ID:-KONTEKS0000}"
EXPECTED_DEB_FINGERPRINT="${KONTEKS_DEB_KEY_FINGERPRINT:-0000000000000000000000000000000000000000}"

activation_id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --activation-id)
      [ $# -ge 2 ] || { echo "error: --activation-id needs a value" >&2; exit 2; }
      activation_id="$2"; shift 2 ;;
    --activation-id=*)
      activation_id="${1#--activation-id=}"; shift ;;
    --version)
      echo "konteks-remote bootstrap v${BOOTSTRAP_VERSION}"; exit 0 ;;
    *)
      # No passthrough: anything else is refused rather than forwarded.
      echo "error: unknown argument (this bootstrap accepts only --activation-id <id>)" >&2; exit 2 ;;
  esac
done
case "$activation_id" in
  "") echo "error: --activation-id <id> is required (copy the command from the Konteks App or MCP)" >&2; exit 2 ;;
  *[!A-Za-z0-9._-]*) echo "error: activation id has an unexpected format" >&2; exit 2 ;;
esac

need() { command -v "$1" >/dev/null 2>&1 || { echo "error: $1 is required" >&2; exit 3; }; }
need curl
need uname

os="$(uname -s)"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "error: unsupported architecture $arch (supported: amd64, arm64)" >&2; exit 3 ;;
esac

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT INT TERM
umask 077

fetch() { curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1"; }

echo "konteks-remote bootstrap v${BOOTSTRAP_VERSION}: fetching the signed checksum manifest"
fetch "${RELEASE_BASE}/SHA256SUMS" "$workdir/SHA256SUMS"
fetch "${RELEASE_BASE}/SHA256SUMS.sig" "$workdir/SHA256SUMS.sig"
fetch "${RELEASE_BASE}/release-signing.pub" "$workdir/release-signing.pub"

# The checksum manifest is signed by the Konteks release key; its public key
# is pinned by fingerprint inside this script so a swapped manifest fails.
need openssl
actual_fp="$(openssl pkey -pubin -in "$workdir/release-signing.pub" -outform DER 2>/dev/null | openssl dgst -sha256 | awk '{print $NF}')"
if [ -n "${KONTEKS_RELEASE_PUBKEY_SHA256:-}" ] && [ "$actual_fp" != "$KONTEKS_RELEASE_PUBKEY_SHA256" ]; then
  echo "error: release signing key fingerprint mismatch; refusing to install" >&2; exit 4
fi
openssl pkeyutl -verify -pubin -inkey "$workdir/release-signing.pub" -rawin -in "$workdir/SHA256SUMS" -sigfile "$workdir/SHA256SUMS.sig" >/dev/null 2>&1 \
  || { echo "error: checksum manifest signature does not verify; refusing to install" >&2; exit 4; }

case "$os" in
  Darwin)
    pkg="konteks-remote-${arch}.pkg"
    fetch "${RELEASE_BASE}/${pkg}" "$workdir/$pkg"
    expected="$(grep " ${pkg}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
    actual="$(shasum -a 256 "$workdir/$pkg" | awk '{print $1}')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "error: package checksum mismatch; refusing to install" >&2; exit 4; }
    # Developer ID signature + notarization, and the expected publisher team.
    pkgutil --check-signature "$workdir/$pkg" | grep -q "Developer ID Installer" || { echo "error: package is not Developer ID signed" >&2; exit 4; }
    pkgutil --check-signature "$workdir/$pkg" | grep -q "$EXPECTED_MACOS_TEAM_ID" || { echo "error: package signer is not the expected publisher" >&2; exit 4; }
    spctl --assess --type install "$workdir/$pkg" >/dev/null 2>&1 || { echo "error: package is not notarized/accepted by Gatekeeper" >&2; exit 4; }
    echo "installing ${pkg} (administrator password may be requested by the installer)"
    sudo installer -pkg "$workdir/$pkg" -target / ;;
  Linux)
    [ -r /etc/os-release ] && . /etc/os-release
    case "${ID:-}" in
      debian) ;;
      *) echo "error: unsupported Linux distribution '${ID:-unknown}' (Debian 12/13 is supported); see the documentation for a manual, verified install" >&2; exit 3 ;;
    esac
    need dpkg
    need gpg
    deb="konteks-remote_${arch}.deb"
    fetch "${RELEASE_BASE}/${deb}" "$workdir/$deb"
    fetch "${RELEASE_BASE}/${deb}.asc" "$workdir/$deb.asc"
    fetch "${RELEASE_BASE}/deb-signing.asc" "$workdir/deb-signing.asc"
    expected="$(grep " ${deb}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
    actual="$(sha256sum "$workdir/$deb" | awk '{print $1}')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "error: package checksum mismatch; refusing to install" >&2; exit 4; }
    gpg_home="$workdir/gnupg"; mkdir -m 700 "$gpg_home"
    gpg --homedir "$gpg_home" --batch --import "$workdir/deb-signing.asc" >/dev/null 2>&1
    gpg --homedir "$gpg_home" --batch --with-colons --fingerprint | grep -q "fpr:::::::::${EXPECTED_DEB_FINGERPRINT}:" \
      || { echo "error: package signing key is not the expected publisher key" >&2; exit 4; }
    gpg --homedir "$gpg_home" --batch --verify "$workdir/$deb.asc" "$workdir/$deb" >/dev/null 2>&1 \
      || { echo "error: package signature does not verify; refusing to install" >&2; exit 4; }
    echo "installing ${deb} (sudo may prompt)"
    sudo dpkg -i "$workdir/$deb" ;;
  *)
    echo "error: unsupported OS $os (use the PowerShell bootstrap on Windows)" >&2; exit 3 ;;
esac

command -v konteks-remote >/dev/null 2>&1 || { echo "error: konteks-remote was not installed on PATH" >&2; exit 5; }
echo "launcher installed: $(konteks-remote --version 2>/dev/null || echo konteks-remote)"
# The activation code is prompted by the launcher without echo; it is never an argument.
exec konteks-remote install --activation-id "$activation_id"
