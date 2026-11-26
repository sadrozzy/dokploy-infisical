#!/bin/sh
set -eu

manager=${1:-all}
package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT HUP INT TERM

cd "$package_root"
tarball=$(npm pack --silent --pack-destination "$work_dir" | tail -n 1)
tarball=$work_dir/$tarball
version=$(node -p "require('./package.json').version")

test_npm() {
  prefix=$work_dir/npm
  npm install -g --prefix "$prefix" "$tarball"
  test "$("$prefix/bin/dokploy-infisical" --version)" = "$version"
  printf '%s\n' "ok npm: $version"
}

test_pnpm() {
  pnpm_major=$(pnpm --version | cut -d. -f1)
  export PNPM_HOME=$work_dir/pnpm
  if [ "$pnpm_major" -ge 12 ]; then
    pnpm_bin=$PNPM_HOME/bin
  else
    pnpm_bin=$PNPM_HOME
  fi
  mkdir -p "$pnpm_bin"
  export PATH=$pnpm_bin:$PATH
  pnpm add -g "$tarball"
  test "$("$pnpm_bin/dokploy-infisical" --version)" = "$version"
  printf '%s\n' "ok pnpm: $version"
}

test_bun() {
  export BUN_INSTALL=$work_dir/bun
  mkdir -p "$BUN_INSTALL/bin"
  bun add -g "$tarball"
  test "$("$BUN_INSTALL/bin/dokploy-infisical" --version)" = "$version"
  printf '%s\n' "ok bun: $version"
}

case "$manager" in
  npm) test_npm ;;
  pnpm) test_pnpm ;;
  bun) test_bun ;;
  all) test_npm; test_pnpm; test_bun ;;
  *) printf '%s\n' "Unknown package manager: $manager" >&2; exit 1 ;;
esac
