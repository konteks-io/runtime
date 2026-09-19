#!/bin/sh
# konteks-remote bootstrap (POSIX; macOS and Debian) — version 1.
#
# Usage (copied verbatim from the Konteks App or MCP activation response):
#   curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --activation-id <id>
#
# Agent-first onboarding (onboarding-simplified OS3, R10) instead:
#   curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" .../install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll
#
# `--user` installs the verified connector executable into the private user
# root with no `sudo` and no package, because the person's coding agent has
# neither a terminal to type a password at nor a reason to need one. Its trust
# anchor is this script itself: the release job bakes the digests of this
# release's connector executables (and of the release signing key file) into
# the copy of install.sh it publishes with the same immutable release, so a
# script fetched from a tag installs only that tag's bytes. The Ed25519
# signature over SHA256SUMS is verified as well wherever `openssl` can speak
# Ed25519; macOS ships LibreSSL, which cannot, and a check that cannot run is
# reported rather than faked. Once installed, the connector verifies the
# Ed25519-signed native manifest with its own embedded roots before it stages
# anything — that, not the bootstrap, is the trust root for everything after.
# When publisher packaging signatures exist, the package path keeps demanding
# them and this path verifies both.
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
# Filled in by scripts/bake-bootstrap.mjs in the release job; empty in the
# repository copy, which then falls back to the fetched SHA256SUMS.
BAKED_EXECUTABLE_SUMS=""
BAKED_RELEASE_PUBKEY_SHA256=""

activation_id=""
user_install=0
enroll=0
while [ $# -gt 0 ]; do
  case "$1" in
    --activation-id)
      [ $# -ge 2 ] || { echo "error: --activation-id needs a value" >&2; exit 2; }
      activation_id="$2"; shift 2 ;;
    --activation-id=*)
      activation_id="${1#--activation-id=}"; shift ;;
    --user)
      user_install=1; shift ;;
    --enroll)
      enroll=1; user_install=1; shift ;;
    --version)
      echo "konteks-remote bootstrap v${BOOTSTRAP_VERSION}"; exit 0 ;;
    *)
      # No passthrough: anything else is refused rather than forwarded.
      echo "error: unknown argument (this bootstrap accepts --activation-id <id>, --user, --enroll)" >&2; exit 2 ;;
  esac
done
if [ "$enroll" -eq 0 ]; then
  case "$activation_id" in
    "") echo "error: --activation-id <id> is required (copy the command from the Konteks App or MCP)" >&2; exit 2 ;;
    *[!A-Za-z0-9._-]*) echo "error: activation id has an unexpected format" >&2; exit 2 ;;
  esac
elif [ -n "$activation_id" ]; then
  echo "error: --enroll and --activation-id are different doors; choose one" >&2; exit 2
fi

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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# The release signing key file is pinned by its digest: baked into this script
# by the release job, or given explicitly. A swapped key fails before anything
# it signed is believed.
expected_pub="${KONTEKS_RELEASE_PUBKEY_SHA256:-$BAKED_RELEASE_PUBKEY_SHA256}"
if [ -n "$expected_pub" ] && [ "$(sha256_of "$workdir/release-signing.pub")" != "$expected_pub" ]; then
  echo "error: release signing key digest mismatch; refusing to install" >&2; exit 4
fi
# The checksum manifest is Ed25519-signed by that key. Verify it wherever the
# local openssl can; LibreSSL (macOS) cannot load an Ed25519 key at all, and
# that is reported, never silently skipped.
need openssl
sig_check="$(openssl pkeyutl -verify -pubin -inkey "$workdir/release-signing.pub" -rawin -in "$workdir/SHA256SUMS" -sigfile "$workdir/SHA256SUMS.sig" 2>&1)" && sig_ok=1 || sig_ok=0
if [ "$sig_ok" -ne 1 ]; then
  case "$sig_check" in
    *"unsupported algorithm"*|*"unable to load Public Key"*)
      echo "note: this openssl cannot verify Ed25519 (LibreSSL); relying on the digests pinned in this release's bootstrap" ;;
    *) echo "error: checksum manifest signature does not verify; refusing to install" >&2; exit 4 ;;
  esac
fi

# ── User-local install (no sudo, no package) ────────────────────────────────
# The bare connector executable is published alongside the packages. Its
# digest comes from this release's bootstrap (baked by the release job) and,
# as a second source, from the published SHA256SUMS; when the bootstrap is the
# unbaked repository copy only SHA256SUMS is available. The two must agree.
if [ "$user_install" -eq 1 ]; then
  if [ "$sig_ok" -ne 1 ] && [ -z "$BAKED_EXECUTABLE_SUMS" ]; then
    echo "error: neither an Ed25519-capable openssl nor a release-baked bootstrap is available; fetch install.sh from a published release" >&2; exit 4
  fi
  case "$os" in
    Darwin) os_id="macos" ;;
    Linux) os_id="debian" ;;
    *) echo "error: the user-local install supports macOS and Linux for now; on Windows use the activation install (Settings → Connected runtimes)" >&2; exit 3 ;;
  esac
  connector="konteks-remote-${os_id}-${arch}"
  fetch "${RELEASE_BASE}/${connector}" "$workdir/$connector"
  published="$(grep " ${connector}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
  baked="$(printf '%b\n' "$BAKED_EXECUTABLE_SUMS" | grep " ${connector}\$" | awk '{print $1}')"
  expected="${baked:-$published}"
  [ -n "$expected" ] || { echo "error: this release publishes no connector executable for ${os_id}/${arch}" >&2; exit 4; }
  if [ -n "$baked" ] && [ -n "$published" ] && [ "$baked" != "$published" ]; then
    echo "error: the published checksum manifest does not match this release's bootstrap; refusing to install" >&2; exit 4
  fi
  actual="$(sha256_of "$workdir/$connector")"
  [ "$expected" = "$actual" ] || { echo "error: connector checksum mismatch; refusing to install" >&2; exit 4; }

  if [ "$os" = "Darwin" ]; then
    root="${KONTEKS_ROOT:-$HOME/Library/Application Support/konteks-remote}"
  else
    root="${KONTEKS_ROOT:-$HOME/.local/share/konteks-remote}"
  fi
  mkdir -p "$root/bin"
  chmod 700 "$root"
  install -m 0755 "$workdir/$connector" "$root/bin/konteks-remote"
  echo "konteks-remote installed for this user at $root/bin/konteks-remote"
  case ":$PATH:" in
    *":$root/bin:"*) ;;
    *) echo "add it to PATH for this shell:  export PATH=\"$root/bin:\$PATH\"" ;;
  esac
  if [ "$enroll" -eq 1 ]; then
    exec "$root/bin/konteks-remote" install --enroll
  fi
  exec "$root/bin/konteks-remote" install --activation-id "$activation_id"
fi

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
