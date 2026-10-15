#!/usr/bin/env bash
# Builds the installable zip, translations included, with no extra packages needed:
# if gettext's msgfmt is missing, tools/compile-po.py is used in its place.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v msgfmt >/dev/null; then
    bin=$(mktemp -d)
    trap 'rm -rf "$bin"' EXIT
    ln -s "$PWD/tools/compile-po.py" "$bin/msgfmt"
    PATH="$bin:$PATH"
fi

gnome-extensions pack --force \
    --extra-source=indicator.js --extra-source=tether.js --extra-source=sites.js \
    --podir=po \
    .
echo "Created: $(ls ./*.shell-extension.zip)"
