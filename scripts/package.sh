#!/bin/sh
# Builds dist/twitch-chat-logs-<version>.zip from the committed tree, ready to
# attach to a GitHub release. Unzipping it gives one folder for Load unpacked.
set -eu

cd "$(dirname "$0")/.."
version=$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')
name="twitch-chat-logs-$version"

mkdir -p dist
rm -f "dist/$name.zip"
git archive --format=zip --prefix="$name/" -o "dist/$name.zip" HEAD \
  manifest.json src icons README.md
echo "dist/$name.zip"
