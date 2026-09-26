#!/usr/bin/env bash
# A build script that hashes with MD4, which fails on Node 17+ (OpenSSL 3)
# with error:0308010C, the error webpack 4 builds hit.
set -euo pipefail
mkdir -p scripts src
cat > package.json <<'JSON'
{
  "name": "storefront",
  "version": "2.3.1",
  "private": true,
  "scripts": {
    "build": "node scripts/build.js"
  }
}
JSON
cat > scripts/build.js <<'JS'
// Bundles src/ into dist/ with content-hashed file names.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function contentHash(buffer) {
  return crypto.createHash('md4').update(buffer).digest('hex').slice(0, 8);
}

const src = path.join(__dirname, '..', 'src');
const dist = path.join(__dirname, '..', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const file of fs.readdirSync(src)) {
  const content = fs.readFileSync(path.join(src, file));
  const ext = path.extname(file);
  const name = `${path.basename(file, ext)}.${contentHash(content)}${ext}`;
  fs.writeFileSync(path.join(dist, name), content);
  console.log(`emitted ${name}`);
}
JS
echo 'console.log("storefront");' > src/main.js
