const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeProgress } = require('../src/inspection/progress');
const { finishAllows } = require('../src/inspection/constants');

describe('inspection progress', () => {
  it('counts outcomes', () => {
    const p = computeProgress([
      { result: 'OK' },
      { result: 'OK' },
      { result: 'DEFECT' },
      { result: 'NA' },
      { result: 'UNCHECKED' },
    ]);
    assert.equal(p.total, 5);
    assert.equal(p.ok, 2);
    assert.equal(p.defect, 1);
    assert.equal(p.na, 1);
    assert.equal(p.unchecked, 1);
    assert.equal(p.checked, 4);
    assert.equal(p.percent, 80);
  });

  it('empty is zero', () => {
    const p = computeProgress([]);
    assert.equal(p.percent, 0);
  });
});

describe('finish tags', () => {
  it('hides finish items for rough', () => {
    assert.equal(finishAllows('ROUGH', ['finish']), false);
    assert.equal(finishAllows('FINISHED', ['finish']), true);
    assert.equal(finishAllows('NO_FINISH', ['docs']), true);
  });
});
