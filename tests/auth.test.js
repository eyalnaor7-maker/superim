const test = require('node:test');
const assert = require('node:assert');
const { friendlyError, oauthAuthorizeUrl, parseOAuthHash, CONFIRM_URL } = require('../auth.js');

test('known codes give Hebrew text, unknown gives generic', () => {
    for (const c of ['not_signed_in', 'daily_limit', 'unavailable', 'bad_request', 'invalid_credentials', 'email_not_confirmed', 'weak_password', 'rate_limited', 'user_exists', 'oauth_cancelled', 'oauth_timeout']) {
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

test('oauthAuthorizeUrl builds Supabase OAuth URL with encoded redirect_to', () => {
    const url = oauthAuthorizeUrl('google');
    assert.ok(url.includes('/auth/v1/authorize?'));
    const parsed = new URL(url);
    assert.strictEqual(parsed.searchParams.get('provider'), 'google');
    assert.strictEqual(parsed.searchParams.get('redirect_to'), CONFIRM_URL);

    const custom = oauthAuthorizeUrl('apple');
    assert.strictEqual(new URL(custom).searchParams.get('provider'), 'apple');
});

test('parseOAuthHash extracts session tokens from hash or full redirect URL', () => {
    const nowBefore = Math.floor(Date.now() / 1000);
    const parsed = parseOAuthHash('#access_token=tok123&refresh_token=ref456&expires_in=7200&token_type=bearer');
    assert.strictEqual(parsed.access_token, 'tok123');
    assert.strictEqual(parsed.refresh_token, 'ref456');
    assert.strictEqual(parsed.token_type, 'bearer');
    assert.strictEqual(parsed.expires_in, 7200);
    assert.ok(parsed.expires_at >= nowBefore + 7200);

    const fromFullUrl = parseOAuthHash(`${CONFIRM_URL}#access_token=abc&refresh_token=xyz&expires_in=3600&token_type=bearer`);
    assert.strictEqual(fromFullUrl.access_token, 'abc');
    assert.strictEqual(fromFullUrl.refresh_token, 'xyz');

    assert.strictEqual(parseOAuthHash(''), null);
    assert.strictEqual(parseOAuthHash('#error=access_denied'), null);
    assert.strictEqual(parseOAuthHash('#token_type=bearer'), null);
});
