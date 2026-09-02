const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const studyRoom = require('../lib/study-room');

describe('study-room', () => {
  beforeEach(() => {
    studyRoom._rooms.clear();
  });

  it('creates and normalizes room codes', () => {
    const code = studyRoom.generateCode();
    assert.equal(code.length, 6);
    const room = studyRoom.getOrCreateRoom(code);
    assert.ok(room);
    assert.equal(studyRoom.getOrCreateRoom(` ${code.toLowerCase()} `).code, code);
  });

  it('tracks members and gap maps', () => {
    const room = studyRoom.getOrCreateRoom('TEST01');
    const member = studyRoom.joinMember(room, 'sock-1', { name: 'Ada' });
    studyRoom.updateGapMapBySocket(room, 'sock-1', {
      topic: 'Photosynthesis',
      gapMap: [{ topic: 'Calvin cycle', status: 'shaky', gap_type: 'mechanism' }],
      mastery: { score: 72 },
    });

    assert.equal(studyRoom.presenceList(room).length, 1);
    assert.equal(studyRoom.gapMapsView(room)[0].gapMap.length, 1);
    assert.equal(studyRoom.memberByToken(room, member.memberToken).name, 'Ada');
  });

  it('keeps member after disconnect for gap sync', () => {
    const room = studyRoom.getOrCreateRoom('KEEP01');
    const member = studyRoom.joinMember(room, 'sock-1', { name: 'Bob' });
    studyRoom.disconnectSocket(room, 'sock-1');
    assert.equal(studyRoom.presenceList(room).length, 0);
    assert.ok(studyRoom.memberByToken(room, member.memberToken));
    studyRoom.updateGapMapByToken(room, member.memberToken, {
      topic: 'Cells',
      gapMap: [{ topic: 'Mitochondria', status: 'solid', gap_type: 'definition' }],
      mastery: { score: 90 },
    });
    assert.equal(studyRoom.gapMapsView(room)[0].topic, 'Cells');
  });

  it('stores shared room document', () => {
    const room = studyRoom.getOrCreateRoom('DOC001');
    studyRoom.setRoomDocument(room, {
      topic: 'Bitcoin',
      summary: 'P2P cash',
      previewQuestion: 'Why trust?',
      uploadedBy: 'Ada',
    });
    assert.equal(studyRoom.publicRoomState(room).document.topic, 'Bitcoin');
  });

  it('rejects duplicate names among online members (case-insensitive)', () => {
    const room = studyRoom.getOrCreateRoom('DUP001');
    studyRoom.joinMember(room, 'sock-1', { name: 'john' });
    assert.equal(studyRoom.isNameTakenByOnlineMember(room, 'John'), true);
    assert.equal(studyRoom.isNameTakenByOnlineMember(room, 'jane'), false);
  });

  it('frees a name when the holder goes offline', () => {
    const room = studyRoom.getOrCreateRoom('FREE01');
    studyRoom.joinMember(room, 'sock-1', { name: 'john' });
    assert.equal(studyRoom.isNameTakenByOnlineMember(room, 'john'), true);
    studyRoom.disconnectSocket(room, 'sock-1');
    assert.equal(studyRoom.isNameTakenByOnlineMember(room, 'john'), false);
  });

  it('allows rejoin with the same member token and name', () => {
    const room = studyRoom.getOrCreateRoom('REJ001');
    const member = studyRoom.joinMember(room, 'sock-1', { name: 'john' });
    assert.equal(studyRoom.isNameTakenByOnlineMember(room, 'john', member.memberToken), false);
  });

  it('tryJoinMember rejects duplicate in same synchronous burst', () => {
    const room = studyRoom.getOrCreateRoom('RACE01');
    const first = studyRoom.tryJoinMember(room, 'sock-1', { name: 'john' });
    const second = studyRoom.tryJoinMember(room, 'sock-2', { name: 'john' });
    assert.ok(first.member);
    assert.equal(second.error, 'That name is already taken in this room — try another.');
    assert.equal(studyRoom.presenceList(room).length, 1);
  });

  it('toggles reactions and ignores unknown emoji', () => {
    const room = studyRoom.getOrCreateRoom('REACT1');
    const msg = studyRoom.addMessage(room, { type: 'chat', name: 'Ada', text: 'hi' });
    assert.deepEqual(msg.reactions, {});
    const once = studyRoom.toggleReaction(room, msg.id, '🔥', 'Ada');
    assert.deepEqual(once.reactions['🔥'], ['Ada']);
    const twice = studyRoom.toggleReaction(room, msg.id, '🔥', 'Ada');
    assert.equal(twice.reactions['🔥'], undefined);
    assert.equal(studyRoom.toggleReaction(room, msg.id, '💩', 'Ada'), null);
  });

  it('pins one message and unpins on second pin', () => {
    const room = studyRoom.getOrCreateRoom('PIN001');
    const msg = studyRoom.addMessage(room, { type: 'chat', name: 'Ada', text: 'keep' });
    const pinned = studyRoom.pinMessage(room, msg.id);
    assert.equal(pinned.pinnedId, msg.id);
    assert.equal(studyRoom.publicRoomState(room).pinned.text, 'keep');
    const unpinned = studyRoom.pinMessage(room, msg.id);
    assert.equal(unpinned.pinnedId, null);
  });

  it('starts a user-set study timer and expires it', () => {
    const room = studyRoom.getOrCreateRoom('TIME01');
    const t = studyRoom.startTimer(room, 45, 'Ada');
    assert.equal(t.minutes, 45);
    assert.ok(t.endsAt > Date.now() + 44 * 60 * 1000);
    assert.equal(studyRoom.startTimer(room, 90, 'Ada').minutes, 90);
    assert.equal(studyRoom.startTimer(room, 0, 'Ada').minutes, 1);
    assert.equal(studyRoom.startTimer(room, 9999, 'Ada').minutes, 1440);
    studyRoom.clearTimer(room);
    assert.equal(studyRoom.publicRoomState(room).timer, null);
    room.timer = { endsAt: Date.now() - 1, minutes: 25, startedBy: 'Ada' };
    assert.equal(studyRoom.publicRoomState(room).timer, null);
  });

  it('tracks voice-call peers and drops them on disconnect', () => {
    const room = studyRoom.getOrCreateRoom('CALL01');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });

    const first = studyRoom.joinCall(room, 'sock-a');
    assert.deepEqual(first.map((p) => p.socketId), ['sock-a']);
    assert.equal(studyRoom.presenceList(room).find((p) => p.socketId === 'sock-a').inCall, true);
    assert.equal(studyRoom.presenceList(room).find((p) => p.socketId === 'sock-b').inCall, false);

    assert.equal(studyRoom.joinCall(room, 'sock-b').length, 2);
    assert.equal(studyRoom.publicRoomState(room).call.length, 2);

    studyRoom.leaveCall(room, 'sock-a');
    assert.deepEqual(studyRoom.callPeers(room).map((p) => p.socketId), ['sock-b']);

    studyRoom.joinCall(room, 'sock-a');
    studyRoom.disconnectSocket(room, 'sock-a');
    assert.deepEqual(studyRoom.callPeers(room).map((p) => p.socketId), ['sock-b']);

    const bob = studyRoom.memberBySocket(room, 'sock-b');
    studyRoom.tryRejoinMember(room, 'sock-b2', bob.memberToken);
    assert.equal(studyRoom.callHas(room, 'sock-b'), false);
    assert.equal(studyRoom.callHas(room, 'sock-b2'), false);
  });

  it('tracks camera-on per call peer', () => {
    const room = studyRoom.getOrCreateRoom('CAM01');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });
    studyRoom.joinCall(room, 'sock-a');
    studyRoom.joinCall(room, 'sock-b');
    assert.equal(studyRoom.callPeers(room).find((p) => p.socketId === 'sock-a').camOn, false);

    studyRoom.setCallCam(room, 'sock-a', true);
    assert.equal(studyRoom.callPeers(room).find((p) => p.socketId === 'sock-a').camOn, true);
    assert.equal(studyRoom.callPeers(room).find((p) => p.socketId === 'sock-b').camOn, false);

    studyRoom.setCallCam(room, 'sock-a', false);
    assert.equal(studyRoom.callPeers(room).find((p) => p.socketId === 'sock-a').camOn, false);

    studyRoom.setCallCam(room, 'sock-a', true);
    studyRoom.leaveCall(room, 'sock-a');
    assert.equal(studyRoom.callPeers(room).some((p) => p.socketId === 'sock-a'), false);
    studyRoom.joinCall(room, 'sock-a');
    assert.equal(studyRoom.callPeers(room).find((p) => p.socketId === 'sock-a').camOn, false);
  });

  it('lets one member present a board others can follow', () => {
    const room = studyRoom.getOrCreateRoom('BOARD1');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });

    const claimed = studyRoom.claimBoard(room, 'sock-a');
    assert.equal(claimed.presenterId, 'sock-a');
    assert.equal(claimed.presenterName, 'Ada');

    const scene = studyRoom.updateBoard(room, 'sock-a', [{ id: 'el1', type: 'rectangle' }]);
    assert.equal(scene.elements.length, 1);
    const withImg = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1' }],
      { f1: { id: 'f1', dataURL: 'data:image/png;base64,aaa', mimeType: 'image/png' } }
    );
    assert.equal(withImg.files.f1.dataURL.startsWith('data:image/png'), true);
    assert.equal(studyRoom.updateBoard(room, 'sock-b', [{ id: 'hack' }]), null);

    studyRoom.claimBoard(room, 'sock-b');
    assert.equal(studyRoom.publicRoomState(room).board.presenterName, 'Bob');

    studyRoom.disconnectSocket(room, 'sock-b');
    assert.equal(studyRoom.publicBoard(room).presenterId, null);
    assert.equal(studyRoom.publicBoard(room).elements[0].id, 'img1');
  });

  it('drops broken board images and keeps the scene when presenter control changes', () => {
    const room = studyRoom.getOrCreateRoom('BOARD4');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });
    studyRoom.claimBoard(room, 'sock-a');
    studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'missing', version: 1 }],
      {},
      1
    );
    assert.equal(studyRoom.publicBoard(room).elements.some((el) => el.type === 'image'), false);

    studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'rect1', type: 'rectangle', version: 1 }],
      {},
      2
    );
    studyRoom.releaseBoard(room, 'sock-a');
    const again = studyRoom.claimBoard(room, 'sock-b');
    assert.equal(again.presenterName, 'Bob');
    assert.equal(again.elements[0].id, 'rect1', 'Stop presenting must not wipe the shared board');
  });

  it('keeps durable board files for every peer and rejects blob URLs', () => {
    const room = studyRoom.getOrCreateRoom('BOARD2');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-c', { name: 'Cara' });
    studyRoom.claimBoard(room, 'sock-a');

    const blobOnly = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
      { f1: { id: 'f1', dataURL: 'blob:http://localhost/abc', mimeType: 'image/png' } }
    );
    assert.equal(blobOnly.files.f1, undefined, 'blob URLs are not shareable');

    const uploaded = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
      { f1: { id: 'f1', dataURL: '/uploads/rooms/BOARD2/pic.png', mimeType: 'image/png' } }
    );
    assert.equal(uploaded.files.f1.dataURL, '/uploads/rooms/BOARD2/pic.png');
    assert.equal(uploaded.elements[0].status, 'saved');

    const wiped = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', status: 'pending' }],
      { f1: { id: 'f1', dataURL: 'blob:http://localhost/nope', mimeType: 'image/png' } }
    );
    assert.equal(wiped.files.f1.dataURL, '/uploads/rooms/BOARD2/pic.png', 'blob emit must not erase durable file');

    const late = studyRoom.publicRoomState(room).board;
    assert.equal(late.files.f1.dataURL, '/uploads/rooms/BOARD2/pic.png');
  });

  it('rejects stale board snapshots so they cannot wipe a newer scene', () => {
    const room = studyRoom.getOrCreateRoom('BOARD3');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.claimBoard(room, 'sock-a');
    const files = { f1: { id: 'f1', dataURL: '/uploads/rooms/BOARD3/a.png', mimeType: 'image/png' } };

    const first = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', version: 2, width: 100 }],
      files,
      1
    );
    assert.equal(first.seq, 1);
    assert.equal(first.elements[0].width, 100);

    const resized = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', version: 3, width: 200 }],
      files,
      2
    );
    assert.equal(resized.elements[0].width, 200);
    assert.equal(resized.seq, 2);

    const oldSeq = studyRoom.updateBoard(room, 'sock-a', [], {}, 1);
    assert.equal(oldSeq.elements[0].id, 'img1');
    assert.equal(oldSeq.elements[0].width, 200);
    assert.equal(oldSeq.seq, 2);

    const undone = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 'img1', type: 'image', fileId: 'f1', version: 1, width: 10 }],
      files,
      9
    );
    assert.equal(undone.elements[0].width, 10, 'higher seq wins even when versions drop (undo)');
    assert.equal(undone.seq, 9);
    assert.equal(undone.files.f1.dataURL, '/uploads/rooms/BOARD3/a.png');
  });

  it('stores erase and hard-delete on the shared board and never resurrects them', () => {
    const room = studyRoom.getOrCreateRoom('BOARD7');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });
    studyRoom.joinMember(room, 'sock-c', { name: 'Cara' });
    studyRoom.claimBoard(room, 'sock-a');
    studyRoom.updateBoard(
      room,
      'sock-a',
      [
        { id: 's1', type: 'freedraw', version: 1 },
        { id: 's2', type: 'freedraw', version: 1 },
      ],
      {},
      1
    );

    const erased = studyRoom.updateBoard(
      room,
      'sock-a',
      [
        { id: 's1', type: 'freedraw', version: 2, isDeleted: true },
        { id: 's2', type: 'freedraw', version: 1 },
      ],
      {},
      2
    );
    assert.equal(erased.elements.find((el) => el.id === 's1').isDeleted, true);
    assert.equal(erased.elements.filter((el) => !el.isDeleted).length, 1);

    const removed = studyRoom.updateBoard(room, 'sock-a', [{ id: 's2', type: 'freedraw', version: 2 }], {}, 3);
    assert.equal(removed.elements.length, 1);
    assert.equal(removed.elements[0].id, 's2');

    const afterTakeover = studyRoom.claimBoard(room, 'sock-b');
    assert.equal(afterTakeover.elements.length, 1);
    assert.equal(afterTakeover.elements[0].id, 's2');
    assert.equal(afterTakeover.elements.some((el) => el.id === 's1'), false);

    const late = studyRoom.publicRoomState(room).board;
    assert.equal(late.elements.length, 1);
    assert.equal(late.elements[0].id, 's2');
    assert.equal(late.seq, afterTakeover.seq);
  });

  it('takeover bumps seq, keeps the shared scene, and locks out the old presenter', () => {
    const room = studyRoom.getOrCreateRoom('BOARD5');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.joinMember(room, 'sock-b', { name: 'Bob' });
    studyRoom.claimBoard(room, 'sock-a');
    const drawn = studyRoom.updateBoard(
      room,
      'sock-a',
      [{ id: 's1', type: 'freedraw', version: 1 }, { id: 'r1', type: 'rectangle', version: 1 }],
      {},
      1
    );
    assert.equal(drawn.elements.length, 2);

    const takeover = studyRoom.claimBoard(room, 'sock-b');
    assert.equal(takeover.presenterId, 'sock-b');
    assert.equal(takeover.presenterName, 'Bob');
    assert.equal(takeover.elements.length, 2, 'takeover keeps shared strokes');
    assert.ok(takeover.seq > drawn.seq, 'takeover seq must beat in-flight old-presenter scenes');
    assert.equal(studyRoom.updateBoard(room, 'sock-a', [{ id: 'hack' }], {}, takeover.seq + 1), null);

    const next = studyRoom.updateBoard(
      room,
      'sock-b',
      [...takeover.elements, { id: 's2', type: 'freedraw', version: 1 }],
      {},
      takeover.seq + 1
    );
    assert.equal(next.elements.length, 3);
    assert.equal(next.presenterId, 'sock-b');
  });

  it('release bumps seq so a late scene echo cannot restore the old presenter', () => {
    const room = studyRoom.getOrCreateRoom('BOARD6');
    studyRoom.joinMember(room, 'sock-a', { name: 'Ada' });
    studyRoom.claimBoard(room, 'sock-a');
    const drawn = studyRoom.updateBoard(room, 'sock-a', [{ id: 's1', type: 'freedraw', version: 1 }], {}, 1);
    const released = studyRoom.releaseBoard(room, 'sock-a');
    assert.equal(released.presenterId, null);
    assert.ok(released.seq > drawn.seq);
    assert.equal(released.elements[0].id, 's1');
  });
});
