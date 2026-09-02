const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('gap graph model', () => {
  it('builds root → sub-concept → specific-gap hierarchy', async () => {
    const { buildGraphModel } = await import('../public/gap-graph.js');
    const m = buildGraphModel(
      'Photosynthesis',
      [
        { topic: 'Calvin cycle', status: 'shaky', gap_type: 'missing mechanism' },
        { topic: 'Light reactions', status: 'solid', gap_type: 'none' },
      ],
      700
    );
    assert.equal(m.nodes.length, 4); // root + 2 sub-concepts + 1 gap node
    assert.equal(m.nodes[0].status, 'center');
    const gap = m.nodes.find((n) => n.status === 'gap');
    assert.equal(gap.parent.label, 'Calvin cycle');
    for (const n of m.nodes) {
      assert.ok(n.x - n.w / 2 >= 0 && n.x + n.w / 2 <= 700, `node ${n.id} inside width`);
      assert.ok(n.y > 0 && n.y < m.height, `node ${n.id} inside height`);
    }
  });

  it('handles single concept, all-solid, and empty map without gap nodes', async () => {
    const { buildGraphModel } = await import('../public/gap-graph.js');
    const single = buildGraphModel('Topic', [{ topic: 'Only one', status: 'solid' }], 320);
    assert.equal(single.nodes.length, 2);
    assert.equal(single.narrow, true);
    assert.ok(single.nodes.every((n) => n.status !== 'gap'));
    const empty = buildGraphModel('Topic', [], 600);
    assert.equal(empty.nodes.length, 1);
    assert.ok(empty.height > 0);
  });

  it('wraps long labels instead of hard cutoff', async () => {
    const { wrapLabel } = await import('../public/gap-graph.js');
    const lines = wrapLabel('conversion process from 3-PGA to G3P in the Calvin cycle');
    assert.ok(lines.length > 1);
    assert.ok(lines.every((l) => l.length <= 18));
  });
});
