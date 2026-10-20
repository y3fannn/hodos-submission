#!/bin/sh
set -eu
usage(){ printf '%s\n' 'Usage: sh publish.sh TAG' '       sh publish.sh --rollback RELEASES/RELEASE'; }
[ "${1-}" = --help ] && { usage; exit 0; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repo=$(CDPATH= cd -- "$script_dir/../.." && pwd -P)
cd "$repo" || { echo 'Cannot enter source checkout' >&2; exit 2; }
root=${HODOS_LANDING_ROOT:-/var/www/hodos}; probe=${HODOS_LANDING_PROBE:-https://hodos.consulting}
[ -d "$root" ] && [ ! -L "$root" ] || { echo 'Public root must be an existing real directory' >&2; exit 2; }
root=$(CDPATH= cd -- "$root" && pwd -P)
case "$root" in "$repo"|"$repo"/*) echo 'Public root must be outside source checkout' >&2; exit 2;; esac
if [ "$probe" = https://hodos.consulting ]; then :
elif printf '%s\n' "$probe" | grep -Eq '^http://127\.0\.0\.1:[0-9]+$'; then port=${probe##*:}; [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || { echo 'Invalid loopback port' >&2; exit 2; }
else echo 'Probe must be fixed HTTPS origin or loopback HTTP' >&2; exit 2; fi
mode=publish; arg=${1-}
if [ "$arg" = --rollback ]; then
  [ "$#" -eq 2 ] || { usage >&2; exit 2; }; mode=rollback; arg=$2
  printf '%s\n' "$arg" | grep -Eq '^releases/deploy-[0-9]{8}-[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9]+$' || { echo 'Unsafe release name' >&2; exit 2; }
elif [ "$#" -eq 1 ]; then
  printf '%s\n' "$arg" | grep -Eq '^deploy-[0-9]{8}-[0-9]+$' || { echo 'Invalid deployment tag' >&2; exit 2; }
  git -C "$repo" rev-parse --verify "$arg^{commit}" >/dev/null
  [ "$(git -C "$repo" rev-parse HEAD)" = "$(git -C "$repo" rev-parse "$arg^{commit}")" ] || { echo 'Tag must identify checked-out HEAD' >&2; exit 2; }
  [ -z "$(git -C "$repo" status --porcelain --untracked-files=all)" ] || { echo 'Checkout must be clean' >&2; exit 2; }
else usage >&2; exit 2; fi
releases=$root/releases
if [ -e "$releases" ]; then [ -d "$releases" ] && [ ! -L "$releases" ] || { echo 'Releases must be a real directory' >&2; exit 2; }
else [ "$mode" = publish ] || { echo 'No releases directory' >&2; exit 2; }; mkdir "$releases"; fi
if [ "$mode" = rollback ]; then [ -d "$root/$arg" ] && [ ! -L "$root/$arg" ] || { echo 'Rollback release must be a real directory' >&2; exit 2; }; fi
umask 022
lock=$root/.landing-publish.lock; mkdir "$lock" 2>/dev/null || { echo 'Publisher lock exists' >&2; exit 2; }
release= previous= temp_link= responses=
cleanup(){ [ -z "$temp_link" ] || rm -f -- "$temp_link"; [ -z "$responses" ] || rm -rf -- "$responses"; rmdir "$lock" 2>/dev/null || :; }
trap cleanup EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
# Read the previous release while holding the lock, never from a stale pre-lock snapshot.
if [ -e "$root/current" ] && [ ! -L "$root/current" ]; then echo 'Current must be a symlink' >&2; exit 2; fi
if [ -L "$root/current" ]; then
 previous=$(readlink "$root/current")
 printf '%s\n' "$previous" | grep -Eq '^releases/deploy-[0-9]{8}-[0-9]+-[0-9]{8}T[0-9]{6}Z-[0-9]+$' || { echo 'Unsafe current target' >&2; exit 2; }
 [ -d "$root/$previous" ] && [ ! -L "$root/$previous" ] || { echo 'Current release is missing or unsafe' >&2; exit 2; }
fi
if [ "$mode" = publish ]; then
 stamp=$(date -u +%Y%m%dT%H%M%SZ); release=releases/$arg-$stamp-$$
 [ ! -e "$root/$release" ] || { echo 'Release already exists' >&2; exit 2; }
 (cd "$repo" && node "$repo/landing-mockup/package.mjs" --landing "$root/$release")
else release=$arg; fi
if ! symlinks=$(find "$root/$release" -type l -print); then echo 'Cannot scan release for symlinks' >&2; exit 2; fi
[ -z "$symlinks" ] || { echo 'Release contains symlink' >&2; exit 2; }
atomic_activate(){ temp_link=$root/.current-$$; ln -s "$1" "$temp_link"; mv -Tf "$temp_link" "$root/current"; temp_link=; }
responses=$(mktemp -d "$root/.landing-response.XXXXXX")
curl_probe(){ if [ "$probe" = https://hodos.consulting ]; then curl --silent --show-error --max-time 5 --noproxy '*' --resolve hodos.consulting:443:127.0.0.1 -o "$2" -w '%{http_code}' "$probe$1"; else curl --silent --show-error --max-time 5 --noproxy '*' -o "$2" -w '%{http_code}' "$probe$1"; fi; }
check_active(){ code=$(curl_probe / "$responses/home") && [ "$code" = 200 ] && cmp -s "$responses/home" "$root/$release/index.html" || return 1; code=$(curl_probe /a/missing/path "$responses/missing") && [ "$code" = 404 ] && cmp -s "$responses/missing" "$root/$release/404.html" || return 1; code=$(curl_probe /503.html "$responses/503") && [ "$code" = 503 ] && cmp -s "$responses/503" "$root/$release/503.html" || return 1; }
atomic_activate "$release"
if ! check_active; then
 echo 'Landing health check failed; restoring previous release' >&2
 if [ -n "$previous" ]; then release=$previous; atomic_activate "$previous"; if check_active; then printf 'Restored %s\n' "$previous" >&2; else echo 'Rollback health check FAILED' >&2; fi
 else if [ -L "$root/current" ] && [ "$(readlink "$root/current")" = "$release" ]; then rm "$root/current"; fi; fi
 exit 1
fi
printf 'Active: %s\nPrevious: %s\n' "$release" "${previous:-none}"
