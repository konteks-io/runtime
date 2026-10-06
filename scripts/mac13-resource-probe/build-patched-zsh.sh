#!/bin/bash
# CI candidate only. The patch and smoke contract come from the pinned Codex source.
set -euo pipefail
test "$#" -eq 3
source_dir="$1"
codex_dir="$2"
output_dir="$3"
test "$(git -C "$source_dir" rev-parse HEAD)" = 77045ef899e53b9598bebc5a41db93a548a40ca6
test "$(git -C "$codex_dir" rev-parse HEAD)" = 687a119f0fcaace47e1f1abcc77cec6c813fd6da
test ! -e "$output_dir"
mkdir "$output_dir"
patch_file="$codex_dir/codex-rs/shell-escalation/patches/zsh-exec-wrapper.patch"
git -C "$source_dir" apply --check "$patch_file"
git -C "$source_dir" apply "$patch_file"
git -C "$source_dir" diff -- Src/exec.c > "$output_dir/applied.patch"
export MACOSX_DEPLOYMENT_TARGET=13.0
export CC=/usr/bin/clang
export CXX=/usr/bin/clang++
export CFLAGS='-O2 -mmacosx-version-min=13.0'
export CXXFLAGS='-O2 -mmacosx-version-min=13.0'
export LDFLAGS='-mmacosx-version-min=13.0'
cd "$source_dir"
./Util/preconfig
./configure
make -j2
wrapper="$output_dir/exec-wrapper"
cat > "$wrapper" <<'WRAPPER'
#!/bin/bash
set -euo pipefail
: "${CODEX_WRAPPER_LOG:?missing CODEX_WRAPPER_LOG}"
printf '%s\n' "$@" > "$CODEX_WRAPPER_LOG"
file="$1"
shift
if [[ "$#" -eq 0 ]]; then exec "$file"; fi
arg0="$1"
shift
exec -a "$arg0" "$file" "$@"
WRAPPER
chmod 0755 "$wrapper"
cp "$source_dir/Src/zsh" "$output_dir/zsh"
chmod 0755 "$output_dir/zsh"
