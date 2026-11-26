#!/bin/sh
set -eu

version=${1:?Usage: render-homebrew-formula.sh VERSION ASSET_DIRECTORY OUTPUT}
asset_directory=${2:?Usage: render-homebrew-formula.sh VERSION ASSET_DIRECTORY OUTPUT}
output=${3:?Usage: render-homebrew-formula.sh VERSION ASSET_DIRECTORY OUTPUT}
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
template=$project_root/.github/homebrew/dokploy-infisical.rb.template

checksum() {
  shasum -a 256 "$asset_directory/dokploy-infisical-$1.tar.gz" | awk '{print $1}'
}

darwin_arm64=$(checksum darwin-arm64)
darwin_x64=$(checksum darwin-x64)
linux_arm64=$(checksum linux-arm64)
linux_x64=$(checksum linux-x64)

sed \
  -e "s/@@VERSION@@/$version/g" \
  -e "s/@@DARWIN_ARM64_SHA256@@/$darwin_arm64/g" \
  -e "s/@@DARWIN_X64_SHA256@@/$darwin_x64/g" \
  -e "s/@@LINUX_ARM64_SHA256@@/$linux_arm64/g" \
  -e "s/@@LINUX_X64_SHA256@@/$linux_x64/g" \
  "$template" > "$output"
