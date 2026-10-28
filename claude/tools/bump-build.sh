#!/bin/sh
# Round 26 cache-busting: set a new build tag everywhere in one go.
#   tools/bump-build.sh r27
# Rewrites ?v=<old> on the main script, the manifest link and every relative ES-module import (src/, src/lang/),
# plus `const BUILD = '<old>'` in src/main.js (shown tiny in the menu corner).
set -e
[ -n "$1" ] || { echo "usage: $0 <tag>" >&2; exit 1; }
cd "$(dirname "$0")/.."
sed -i -E "s/\?v=[A-Za-z0-9._-]+/?v=$1/g" index.html src/*.js src/lang/*.js
sed -i -E "s/^export const BUILD = '[^']*';/export const BUILD = '$1';/" src/main.js
grep -c "?v=$1" index.html src/*.js src/lang/*.js | awk -F: '{n+=$2} END {print n " tags set to '"$1"'"}'
