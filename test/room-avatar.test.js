const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('room avatars', () => {
  it('picks stable colors from the fixed palette', async () => {
    const { AVATAR_COLORS, avatarColor } = await import('../public/room-avatar.js');
    const alice = avatarColor('Alice');
    const bob = avatarColor('Bob');
    const carol = avatarColor('Carol');
    assert.ok(AVATAR_COLORS.includes(alice));
    assert.ok(AVATAR_COLORS.includes(bob));
    assert.ok(AVATAR_COLORS.includes(carol));
    assert.equal(avatarColor('Alice'), alice);
    assert.ok(new Set([alice, bob, carol]).size >= 2, 'at least two distinct colors among three names');
  });

  it('uses uppercase first initial', async () => {
    const { avatarInitial } = await import('../public/room-avatar.js');
    assert.equal(avatarInitial('john'), 'J');
    assert.equal(avatarInitial(' Ada '), 'A');
    assert.equal(avatarInitial(''), '?');
  });
});
