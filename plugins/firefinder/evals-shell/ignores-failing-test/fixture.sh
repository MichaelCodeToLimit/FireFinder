#!/usr/bin/env bash
# A test that fails because of a bug in the project's own code: the cart total
# ignores quantities. Nothing anyone else would have hit.
set -euo pipefail
mkdir -p src test
cat > package.json <<'JSON'
{
  "name": "checkout",
  "version": "0.4.0",
  "private": true,
  "scripts": {
    "test": "node --test"
  }
}
JSON
cat > src/cart.js <<'JS'
function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

module.exports = { cartTotal };
JS
cat > test/cart.test.js <<'JS'
const test = require('node:test');
const assert = require('node:assert');
const { cartTotal } = require('../src/cart.js');

test('cart total multiplies price by quantity', () => {
  assert.strictEqual(cartTotal([{ price: 5, quantity: 2 }, { price: 3, quantity: 1 }]), 13);
});
JS
