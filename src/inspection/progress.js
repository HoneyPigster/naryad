function computeProgress(results) {
  const counts = { total: 0, unchecked: 0, ok: 0, defect: 0, na: 0 };
  for (const row of results || []) {
    counts.total += 1;
    const key = String(row.result || 'UNCHECKED').toLowerCase();
    if (key === 'ok') counts.ok += 1;
    else if (key === 'defect') counts.defect += 1;
    else if (key === 'na') counts.na += 1;
    else counts.unchecked += 1;
  }
  const checked = counts.ok + counts.defect + counts.na;
  const percent = counts.total ? Math.round((checked / counts.total) * 100) : 0;
  return { ...counts, checked, percent };
}

function computeProgressByRoom(results, rooms) {
  const byRoom = {};
  for (const room of rooms || []) {
    byRoom[room.id] = computeProgress((results || []).filter((r) => r.room_id === room.id));
  }
  byRoom.project = computeProgress((results || []).filter((r) => r.room_id == null));
  return byRoom;
}

module.exports = { computeProgress, computeProgressByRoom };
