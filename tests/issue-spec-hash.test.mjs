import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { issueSpecHash } from '../scripts/issue-spec-hash.mjs';

test('fingerprint hashes title + NUL + body as UTF-8', () => {
  assert.equal(issueSpecHash({ title: 'Bug', body: 'Fix' }),
    createHash('sha256').update('Bug\0Fix').digest('hex'));
});
test('any title or body edit invalidates a PASS', () => {
  const a = issueSpecHash({ title: 'Bug', body: 'Fix' });
  assert.notEqual(a, issueSpecHash({ title: 'Bug!', body: 'Fix' }));
  assert.notEqual(a, issueSpecHash({ title: 'Bug', body: 'Fix!' }));
});
test('null body and Unicode are deterministic', () => {
  assert.equal(issueSpecHash({ title: 'שלום', body: null }),
    issueSpecHash({ title: 'שלום', body: '' }));
});
test('invalid issue fields reject', () => {
  assert.throws(() => issueSpecHash({ title: null, body: '' }), TypeError);
  assert.throws(() => issueSpecHash({ title: 'Bug', body: 12 }), TypeError);
});
