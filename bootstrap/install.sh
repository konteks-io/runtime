#!/bin/sh
# konteks-remote bootstrap (POSIX; macOS and Debian) — version 1.
#
# Usage (copied verbatim from the Konteks App or MCP activation response):
#   curl -fsSL https://github.com/konteks-io/runtime/releases/latest/download/install.sh | sh -s -- --activation-id <id>
#
# Agent-first onboarding instead:
#   curl -fsSL -o "${TMPDIR:-/tmp}/konteks-install.sh" .../install.sh && sh "${TMPDIR:-/tmp}/konteks-install.sh" --user --enroll
#
# `--user` installs the verified connector executable into the private user
# root with no `sudo` and no package, because the person's coding agent has
# neither a terminal to type a password at nor a reason to need one. Its trust
# anchor is this script itself: the release job bakes the digests of this
# release's connector executables (and of the release signing key file) into
# the copy of install.sh it publishes with the same immutable release, so a
# script fetched from a tag installs only that tag's bytes. The Ed25519
# signature over SHA256SUMS is verified as well, with the release key pinned
# in this script, wherever `openssl` can speak Ed25519; macOS ships LibreSSL,
# which cannot, and a check that cannot run is reported rather than faked. Once installed, the connector verifies the
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

# One setup process and its launcher children share this bounded presentation
# choice. Nothing is written to a profile or the background service environment.
KONTEKS_SETUP_LOCALE="${KONTEKS_SETUP_LOCALE-en}"
case "$KONTEKS_SETUP_LOCALE" in
  en|id) export KONTEKS_SETUP_LOCALE ;;
  *) printf '\n%s\n  %s\n  %s\n' 'Setup needs attention' 'Setup language must be en or id.' 'Return to Konteks and copy a fresh setup command.' >&2; exit 2 ;;
esac

setup_text() {
  setup_format="$1"; shift
  if [ "$KONTEKS_SETUP_LOCALE" = id ]; then
    while IFS='|' read -r setup_english setup_indonesian; do
      if [ "$setup_format" = "$setup_english" ]; then setup_format="$setup_indonesian"; break; fi
    done <<'SETUP_COPY'
Setup could not finish|Pemasangan belum selesai
Setup needs attention|Pemasangan perlu perhatian
Setup complete|Pemasangan selesai
Runtime setup|Pemasangan runtime
Download and verify|Unduh dan verifikasi
Review the technical message above before retrying.|Baca pesan teknis di atas sebelum mencoba ulang.
Return to Konteks and copy a fresh setup command before trying again.|Kembali ke Konteks dan salin perintah pemasangan baru sebelum mencoba ulang.
Return to Konteks -> Customize -> Runtimes.|Kembali ke Konteks -> Sesuaikan -> Runtimes.
Confirm this computer is online.|Pastikan komputer ini terhubung.
1 of 3 - Download and verify|1 dari 3 - Unduh dan verifikasi
2 of 3 - Install the Konteks command|2 dari 3 - Pasang perintah Konteks
3 of 3 - Connect this computer|3 dari 3 - Hubungkan komputer ini
3 of 3 - Enroll this computer|3 dari 3 - Daftarkan komputer ini
Connecting this computer to Konteks...|Menghubungkan komputer ini ke Konteks...
Enrolling this computer with Konteks...|Mendaftarkan komputer ini ke Konteks...
Enter the activation code when asked. It is hidden while you type.|Masukkan kode aktivasi saat diminta. Kode disembunyikan saat Anda mengetik.
error: --activation-id needs a value|kesalahan: --activation-id memerlukan nilai
error: unknown argument (this bootstrap accepts --activation-id <id>, --user, --enroll)|kesalahan: argumen tidak dikenal (pemasang ini menerima --activation-id <id>, --user, --enroll)
error: --activation-id <id> is required (copy the command from the Konteks App or MCP)|kesalahan: --activation-id <id> diperlukan (salin perintah dari Konteks atau MCP)
error: activation id has an unexpected format|kesalahan: format ID aktivasi tidak sesuai
error: --enroll and --activation-id are different doors; choose one|kesalahan: pilih salah satu dari --enroll atau --activation-id
error: %s is required|kesalahan: %s diperlukan
error: unsupported architecture %s (supported: amd64, arm64)|kesalahan: arsitektur %s tidak didukung (yang didukung: amd64, arm64)
konteks-remote bootstrap v%s: fetching the signed checksum manifest|konteks-remote bootstrap v%s: Mengambil manifes checksum bertanda tangan
error: could not download %s|kesalahan: tidak dapat mengunduh %s
error: release signing key digest mismatch; refusing to install|kesalahan: digest kunci penandatanganan rilis tidak cocok; pemasangan ditolak
note: this openssl cannot verify Ed25519 (LibreSSL); relying on the digests pinned in this release's bootstrap|catatan: openssl ini tidak dapat memverifikasi Ed25519 (LibreSSL); memakai digest yang dipatok pada pemasang rilis ini
error: checksum manifest signature does not verify; refusing to install|kesalahan: tanda tangan manifes checksum tidak valid; pemasangan ditolak
error: neither an Ed25519-capable openssl nor a release-baked bootstrap is available; fetch install.sh from a published release|kesalahan: openssl yang mendukung Ed25519 maupun pemasang rilis dengan digest yang dipatok tidak tersedia; ambil install.sh dari rilis yang diterbitkan
error: the user-local install supports macOS and Linux for now; on Windows use the activation install (Customize -> Runtimes)|kesalahan: pemasangan khusus pengguna mendukung macOS dan Linux; pada Windows gunakan pemasangan aktivasi (Sesuaikan -> Runtimes)
error: this release publishes no connector executable for %s/%s|kesalahan: rilis ini tidak menyediakan program konektor untuk %s/%s
error: the published checksum manifest does not match this release's bootstrap; refusing to install|kesalahan: manifes checksum yang diterbitkan tidak cocok dengan pemasang rilis ini; pemasangan ditolak
error: connector checksum mismatch; refusing to install|kesalahan: checksum konektor tidak cocok; pemasangan ditolak
konteks-remote installed for this user at %s/bin/konteks-remote|konteks-remote dipasang untuk pengguna ini di %s/bin/konteks-remote
add it to PATH for this shell:  export PATH="%s:$PATH"|tambahkan ke PATH untuk shell ini:  export PATH="%s:$PATH"
error: package checksum mismatch; refusing to install|kesalahan: checksum paket tidak cocok; pemasangan ditolak
error: package is not Developer ID signed|kesalahan: paket tidak ditandatangani dengan Developer ID
error: package signer is not the expected publisher|kesalahan: penandatangan paket bukan penerbit yang diharapkan
error: package is not notarized/accepted by Gatekeeper|kesalahan: paket tidak dinotarisasi atau tidak diterima oleh Gatekeeper
installing %s (administrator password may be requested by the installer)|Memasang %s (pemasang mungkin meminta kata sandi administrator)
error: unsupported Linux distribution '%s' (Debian 12/13 and Ubuntu 22.04/24.04 are supported); see the documentation for a manual, verified install|kesalahan: distribusi Linux '%s' tidak didukung (Debian 12/13 dan Ubuntu 22.04/24.04 didukung); lihat dokumentasi untuk pemasangan manual yang terverifikasi
error: package signing key is not the expected publisher key|kesalahan: kunci penandatanganan paket bukan kunci penerbit yang diharapkan
error: package signature does not verify; refusing to install|kesalahan: tanda tangan paket tidak valid; pemasangan ditolak
installing %s (sudo may prompt)|Memasang %s (sudo mungkin meminta kata sandi)
error: unsupported OS %s (use the PowerShell bootstrap on Windows)|kesalahan: OS %s tidak didukung (gunakan pemasang PowerShell pada Windows)
error: konteks-remote was not installed on PATH|kesalahan: konteks-remote tidak dipasang pada PATH
launcher installed: %s|perintah Konteks terpasang: %s
SETUP_COPY
  fi
  printf "$setup_format\n" "$@"
}

setup_identity() {
  if [ "${KONTEKS_SETUP_HEADER_SHOWN-}" = 1 ]; then return; fi
  printf '\nKONTEKS\n'; setup_text 'Runtime setup'; printf '\n'
  KONTEKS_SETUP_HEADER_SHOWN=1; export KONTEKS_SETUP_HEADER_SHOWN
}

setup_interactive() { [ -t 1 ]; }
setup_spinner_pid=''
setup_row_width=''
setup_label_width=''
setup_columns_valid() {
  case "$1" in ''|0*|*[!0-9]*|????*) return 1 ;; esac
  [ "$1" -ge 3 ] && [ "$1" -le 512 ]
}
setup_progress_width() {
  if [ -n "$setup_row_width" ]; then return; fi
  setup_columns="${COLUMNS-}"
  if ! setup_columns_valid "$setup_columns"; then
    setup_size="$(stty size 2>/dev/null </dev/tty || :)"
    setup_columns="${setup_size##* }"
  fi
  if ! setup_columns_valid "$setup_columns"; then setup_columns=80; fi
  # Resolve once, leave the final column unused, and spawn no width tools per frame.
  setup_row_width=$((setup_columns - 1))
  setup_label_width=$((setup_row_width - 2))
}
setup_progress_stop() {
  if [ -z "$setup_spinner_pid" ]; then return; fi
  kill "$setup_spinner_pid" 2>/dev/null || :
  wait "$setup_spinner_pid" 2>/dev/null || :
  setup_spinner_pid=''
  printf '\r%*s\r' "$setup_row_width" ''
}
setup_progress_start() {
  setup_progress_stop
  setup_label="$(setup_text "$@")"
  if ! setup_interactive; then printf '  %s\n' "$setup_label"; return; fi
  setup_progress_width
  (
    while :; do
      for setup_frame in '|' '/' '-' '\'; do
        printf '\r%s %.*s' "$setup_frame" "$setup_label_width" "$setup_label"
        sleep 0.2
      done
    done
  ) &
  setup_spinner_pid=$!
}

setup_stage() { setup_progress_stop; printf '\n'; setup_text "$@"; }
setup_detail() {
  setup_was_spinning="$setup_spinner_pid"
  setup_progress_stop
  setup_text "$@" | while IFS= read -r setup_line; do printf '  %s\n' "$setup_line"; done
  if [ -n "$setup_was_spinning" ]; then setup_progress_start "$setup_label"; fi
}
setup_diagnostic() {
  case "${KONTEKS_REMOTE_VERBOSE-}" in 1|true|yes|on) setup_detail "$@" ;; esac
}
setup_fail() {
  setup_exit="$1"; shift
  setup_stage 'Setup could not finish' >&2
  setup_detail "$@" >&2
  setup_detail 'Return to Konteks and copy a fresh setup command before trying again.' >&2
  exit "$setup_exit"
}

setup_run() {
  setup_progress_stop
  if "$@"; then return 0; else setup_exit="$?"; fi
  setup_fail "$setup_exit" 'Review the technical message above before retrying.'
}

setup_connect() {
  setup_progress_stop
  if [ "$enroll" -eq 1 ]; then
    setup_stage '3 of 3 - Enroll this computer'
    setup_detail 'Enrolling this computer with Konteks...'
  else
    setup_stage '3 of 3 - Connect this computer'
    setup_detail 'Connecting this computer to Konteks...'
    setup_detail 'Enter the activation code when asked. It is hidden while you type.'
  fi
  if "$@"; then
    setup_stage 'Setup complete'
    setup_detail 'Return to Konteks -> Customize -> Runtimes.'
    setup_detail 'Confirm this computer is online.'
    exit 0
  else setup_exit="$?"; fi
  setup_stage 'Setup needs attention' >&2
  setup_detail 'Review the technical message above before retrying.' >&2
  setup_detail 'Return to Konteks and copy a fresh setup command before trying again.' >&2
  exit "$setup_exit"
}

BOOTSTRAP_VERSION="1"
RELEASE_BASE="${KONTEKS_RELEASE_BASE:-https://github.com/konteks-io/runtime/releases/latest/download}"
EXPECTED_MACOS_TEAM_ID="${KONTEKS_MACOS_TEAM_ID:-KONTEKS0000}"
EXPECTED_DEB_FINGERPRINT="${KONTEKS_DEB_KEY_FINGERPRINT:-0000000000000000000000000000000000000000}"
# Filled in by scripts/bake-bootstrap.mjs in the release job; empty in the
# repository copy, which then falls back to the fetched SHA256SUMS.
BAKED_EXECUTABLE_SUMS=""
BAKED_RELEASE_PUBKEY_SHA256=""
# The Konteks release key (Ed25519, SubjectPublicKeyInfo, base64), the same key
# install.ps1 pins. Rotating it is a change to both scripts.
PINNED_RELEASE_PUBKEY="MCowBQYDK2VwAyEA2gqrOjaUrsIxyVlXNJHhTFjQUqy4o1SsqhrovPecU64="

activation_id=""
user_install=0
enroll=0
while [ $# -gt 0 ]; do
  case "$1" in
    --activation-id)
      [ $# -ge 2 ] || setup_fail 2 'error: --activation-id needs a value'
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
      setup_fail 2 'error: unknown argument (this bootstrap accepts --activation-id <id>, --user, --enroll)' ;;
  esac
done
if [ "$enroll" -eq 0 ]; then
  case "$activation_id" in
    "") setup_fail 2 'error: --activation-id <id> is required (copy the command from the Konteks App or MCP)' ;;
    *[!A-Za-z0-9._-]*) setup_fail 2 'error: activation id has an unexpected format' ;;
  esac
elif [ -n "$activation_id" ]; then
  setup_fail 2 'error: --enroll and --activation-id are different doors; choose one'
fi

need() { command -v "$1" >/dev/null 2>&1 || setup_fail 3 'error: %s is required' "$1"; }
need curl
need uname

os="$(uname -s)"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) setup_fail 3 'error: unsupported architecture %s (supported: amd64, arm64)' "$arch" ;;
esac

workdir="$(mktemp -d)"
trap 'setup_progress_stop; rm -rf "$workdir"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
umask 077

fetch() {
  if curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$2" "$1" 2>"$workdir/download-error"; then return 0; else setup_exit="$?"; fi
  setup_progress_stop
  cat "$workdir/download-error" >&2
  setup_fail "$setup_exit" 'error: could not download %s' "${1##*/}"
}

setup_identity
setup_stage '1 of 3 - Download and verify'
setup_diagnostic 'konteks-remote bootstrap v%s: fetching the signed checksum manifest' "$BOOTSTRAP_VERSION"
setup_progress_start 'Download and verify'
fetch "${RELEASE_BASE}/SHA256SUMS" "$workdir/SHA256SUMS"
fetch "${RELEASE_BASE}/SHA256SUMS.sig" "$workdir/SHA256SUMS.sig"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# The release signing key is pinned in this script, never taken from where the
# manifest comes from. Only a channel signed by its own key (the local release
# channel) names another, by the digest of its key file, baked into its copy of
# this script or given explicitly; that key is fetched and must match.
printf '%s\n%s\n%s\n' '-----BEGIN PUBLIC KEY-----' "$PINNED_RELEASE_PUBKEY" '-----END PUBLIC KEY-----' > "$workdir/release-signing.pub"
expected_pub="${KONTEKS_RELEASE_PUBKEY_SHA256:-$BAKED_RELEASE_PUBKEY_SHA256}"
if [ -n "$expected_pub" ] && [ "$(sha256_of "$workdir/release-signing.pub")" != "$expected_pub" ]; then
  fetch "${RELEASE_BASE}/release-signing.pub" "$workdir/release-signing.pub"
  if [ "$(sha256_of "$workdir/release-signing.pub")" != "$expected_pub" ]; then
    setup_fail 4 'error: release signing key digest mismatch; refusing to install'
  fi
fi
# The checksum manifest is Ed25519-signed by that key. Verify it wherever the
# local openssl can; LibreSSL (macOS) cannot load an Ed25519 key at all, and
# that is reported, never silently skipped.
need openssl
sig_check="$(openssl pkeyutl -verify -pubin -inkey "$workdir/release-signing.pub" -rawin -in "$workdir/SHA256SUMS" -sigfile "$workdir/SHA256SUMS.sig" 2>&1)" && sig_ok=1 || sig_ok=0
if [ "$sig_ok" -ne 1 ]; then
  case "$sig_check" in
    *"unsupported algorithm"*|*"unable to load Public Key"*)
      setup_detail "note: this openssl cannot verify Ed25519 (LibreSSL); relying on the digests pinned in this release's bootstrap" ;;
    *) setup_fail 4 'error: checksum manifest signature does not verify; refusing to install' ;;
  esac
fi

# ── User-local install (no sudo, no package) ────────────────────────────────
# The bare connector executable is published alongside the packages. Its
# digest comes from this release's bootstrap (baked by the release job) and,
# as a second source, from the published SHA256SUMS; when the bootstrap is the
# unbaked repository copy only SHA256SUMS is available. The two must agree.
if [ "$user_install" -eq 1 ]; then
  if [ "$sig_ok" -ne 1 ] && [ -z "$BAKED_EXECUTABLE_SUMS" ]; then
    setup_fail 4 'error: neither an Ed25519-capable openssl nor a release-baked bootstrap is available; fetch install.sh from a published release'
  fi
  case "$os" in
    Darwin) os_id="macos" ;;
    Linux) os_id="debian" ;;
    *) setup_fail 3 'error: the user-local install supports macOS and Linux for now; on Windows use the activation install (Customize -> Runtimes)' ;;
  esac
  connector="konteks-remote-${os_id}-${arch}"
  fetch "${RELEASE_BASE}/${connector}" "$workdir/$connector"
  published="$(grep " ${connector}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
  baked="$(printf '%b\n' "$BAKED_EXECUTABLE_SUMS" | grep " ${connector}\$" | awk '{print $1}')"
  expected="${baked:-$published}"
  [ -n "$expected" ] || setup_fail 4 'error: this release publishes no connector executable for %s/%s' "$os_id" "$arch"
  if [ -n "$baked" ] && [ -n "$published" ] && [ "$baked" != "$published" ]; then
    setup_fail 4 "error: the published checksum manifest does not match this release's bootstrap; refusing to install"
  fi
  actual="$(sha256_of "$workdir/$connector")"
  [ "$expected" = "$actual" ] || setup_fail 4 'error: connector checksum mismatch; refusing to install'

  if [ "$os" = "Darwin" ]; then
    root="${KONTEKS_ROOT:-$HOME/Library/Application Support/konteks-remote}"
  else
    root="${KONTEKS_ROOT:-$HOME/.local/share/konteks-remote}"
  fi
  setup_stage '2 of 3 - Install the Konteks command'
  setup_run mkdir -p "$root/bin"
  setup_run chmod 700 "$root"
  setup_run install -m 0755 "$workdir/$connector" "$root/bin/konteks-remote"
  setup_detail 'konteks-remote installed for this user at %s/bin/konteks-remote' "$root"
  # Graft is offered later, and downloaded only after a yes. Record
  # the digest the verified checksums give its package now, so the connector
  # installs exactly this release's bytes then, and nothing else.
  graft="konteks-graft-${os_id}-${arch}.tgz"
  graft_baked="$(printf '%b\n' "$BAKED_EXECUTABLE_SUMS" | grep " ${graft}\$" | awk '{print $1}')"
  graft_published="$(grep " ${graft}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
  # Published sums count only where their signature was verified here.
  [ "$sig_ok" -eq 1 ] || graft_published=""
  graft_digest="${graft_baked:-$graft_published}"
  if [ -n "$graft_digest" ] && { [ -z "$graft_baked" ] || [ -z "$graft_published" ] || [ "$graft_baked" = "$graft_published" ]; }; then
    setup_run mkdir -p "$root/installer"
    setup_run chmod 700 "$root/installer"
    printf '{"name":"%s","digest":"%s","base":"%s"}\n' "$graft" "$graft_digest" "$RELEASE_BASE" > "$root/installer/graft.json"
  fi
  case ":$PATH:" in
    *":$root/bin:"*) ;;
    *) setup_detail 'add it to PATH for this shell:  export PATH="%s:$PATH"' "$root/bin" ;;
  esac
  if [ "$enroll" -eq 1 ]; then
    setup_connect "$root/bin/konteks-remote" install --enroll
  fi
  setup_connect "$root/bin/konteks-remote" install --activation-id "$activation_id"
fi

case "$os" in
  Darwin)
    pkg="konteks-remote-${arch}.pkg"
    fetch "${RELEASE_BASE}/${pkg}" "$workdir/$pkg"
    expected="$(grep " ${pkg}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
    actual="$(shasum -a 256 "$workdir/$pkg" | awk '{print $1}')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || setup_fail 4 'error: package checksum mismatch; refusing to install'
    # Developer ID signature + notarization, and the expected publisher team.
    pkgutil --check-signature "$workdir/$pkg" | grep -q "Developer ID Installer" || setup_fail 4 'error: package is not Developer ID signed'
    pkgutil --check-signature "$workdir/$pkg" | grep -q "$EXPECTED_MACOS_TEAM_ID" || setup_fail 4 'error: package signer is not the expected publisher'
    spctl --assess --type install "$workdir/$pkg" >/dev/null 2>&1 || setup_fail 4 'error: package is not notarized/accepted by Gatekeeper'
    setup_stage '2 of 3 - Install the Konteks command'
    setup_detail 'installing %s (administrator password may be requested by the installer)' "$pkg"
    setup_run sudo installer -pkg "$workdir/$pkg" -target / ;;
  Linux)
    os_release_file="${KONTEKS_OS_RELEASE_FILE:-/etc/os-release}"
    [ -r "$os_release_file" ] && . "$os_release_file"
    case "${ID:-}" in
      debian|ubuntu) ;;
      *) setup_fail 3 "error: unsupported Linux distribution '%s' (Debian 12/13 and Ubuntu 22.04/24.04 are supported); see the documentation for a manual, verified install" "${ID:-unknown}" ;;
    esac
    need dpkg
    need gpg
    deb="konteks-remote_${arch}.deb"
    fetch "${RELEASE_BASE}/${deb}" "$workdir/$deb"
    fetch "${RELEASE_BASE}/${deb}.asc" "$workdir/$deb.asc"
    fetch "${RELEASE_BASE}/deb-signing.asc" "$workdir/deb-signing.asc"
    expected="$(grep " ${deb}\$" "$workdir/SHA256SUMS" | awk '{print $1}')"
    actual="$(sha256sum "$workdir/$deb" | awk '{print $1}')"
    [ -n "$expected" ] && [ "$expected" = "$actual" ] || setup_fail 4 'error: package checksum mismatch; refusing to install'
    gpg_home="$workdir/gnupg"; mkdir -m 700 "$gpg_home"
    setup_run gpg --homedir "$gpg_home" --batch --import "$workdir/deb-signing.asc" >/dev/null
    gpg --homedir "$gpg_home" --batch --with-colons --fingerprint | grep -q "fpr:::::::::${EXPECTED_DEB_FINGERPRINT}:" \
      || setup_fail 4 'error: package signing key is not the expected publisher key'
    gpg --homedir "$gpg_home" --batch --verify "$workdir/$deb.asc" "$workdir/$deb" >/dev/null 2>&1 \
      || setup_fail 4 'error: package signature does not verify; refusing to install'
    setup_stage '2 of 3 - Install the Konteks command'
    setup_detail 'installing %s (sudo may prompt)' "$deb"
    setup_run sudo dpkg -i "$workdir/$deb" ;;
  *)
    setup_fail 3 'error: unsupported OS %s (use the PowerShell bootstrap on Windows)' "$os" ;;
esac

command -v konteks-remote >/dev/null 2>&1 || setup_fail 5 'error: konteks-remote was not installed on PATH'
setup_detail 'launcher installed: %s' "$(konteks-remote --version 2>/dev/null || echo konteks-remote)"
# The activation code is prompted by the launcher without echo; it is never an argument.
setup_connect konteks-remote install --activation-id "$activation_id"
