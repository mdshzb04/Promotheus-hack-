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
});
