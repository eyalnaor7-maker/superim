const test = require('node:test');
const assert = require('node:assert');
const { friendlyError } = require('../auth.js');

test('known codes give Hebrew text, unknown gives generic', () => {
    for (const c of ['not_signed_in', 'daily_limit', 'unavailable', 'bad_request', 'invalid_credentials', 'email_not_confirmed', 'weak_password', 'rate_limited', 'user_exists']) {
        assert.notStrictEqual(friendlyError(c), friendlyError('zzz'));
    }
    assert.strictEqual(friendlyError('<raw server text>'), friendlyError(undefined));
});

test('maps supabase-js auth errors', () => {
    assert.strictEqual(friendlyError({ status: 429 }), friendlyError('rate_limited'));
    assert.strictEqual(friendlyError({ code: 'user_already_exists', status: 422 }), friendlyError('user_exists'));
    assert.strictEqual(friendlyError({ code: 'invalid_credentials', status: 400 }), friendlyError('invalid_credentials'));
    assert.strictEqual(friendlyError({ code: 'weak_password' }), friendlyError('weak_password'));
});
