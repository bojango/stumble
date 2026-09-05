#!/usr/bin/env bash
set -euo pipefail
rm -rf _site
mkdir -p _site/assets
cp index.html _site/index.html
cp stumble.user.js _site/stumble.user.js
cp assets/style.css _site/assets/style.css
cp LICENSE _site/LICENSE
python3 scripts/build_catalog.py --output _site/data
touch _site/.nojekyll
