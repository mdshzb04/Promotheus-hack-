const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function track(kind, extra = {}) {
  return { kind, muted: false, readyState: 'live', ...extra };
}

describe('room call video tracks', () => {
  it('hides muted or ended camera tracks from the tile stream', async () => {
    const { shouldShowVideoTrack, pickTileTracks } = await import('../public/room-voice.js');
    assert.equal(shouldShowVideoTrack(track('video')), true);
    assert.equal(shouldShowVideoTrack(track('video', { muted: true })), true);
    assert.equal(shouldShowVideoTrack(track('video', { readyState: 'ended' })), false);
    assert.equal(shouldShowVideoTrack(track('audio')), false);

    const stream = {
      getAudioTracks: () => [track('audio')],
      getVideoTracks: () => [track('video', { muted: true })],
    };
    const pickedOff = pickTileTracks(stream, false);
    assert.equal(pickedOff.video.length, 0);
    assert.equal(pickedOff.audio.length, 1);
    assert.equal(pickTileTracks(stream, true).video.length, 1, 'cam-on still attaches muted receiver until frames arrive');

    const liveVideo = {
      getAudioTracks: () => [track('audio')],
      getVideoTracks: () => [track('video')],
    };
    assert.equal(pickTileTracks(liveVideo, false).video.length, 0, 'cam-off ignores live video tracks');
    assert.equal(pickTileTracks(liveVideo, true).video.length, 1);
  });
});
