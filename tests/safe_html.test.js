const test = require('node:test');
const assert = require('node:assert');
const { esc } = require('../safe_html.js');

test('esc escapes markup', () => {
  assert.strictEqual(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(esc('a"b\'c&d'), 'a&quot;b&#39;c&amp;d');
});
test('esc handles non-strings', () => {
  assert.strictEqual(esc(null), '');
  assert.strictEqual(esc(undefined), '');
  assert.strictEqual(esc(5), '5');
});
