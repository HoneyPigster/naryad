const path = require('path');
const PDFDocument = require('pdfkit');
const { listDefects, listPhotos, listMeasurements, progressFor, getHistory } = require('./service');
const { pool } = require('../db');
const storage = require('./storage');
const {
  SEVERITIES,
  PROPERTY_TYPES,
  FINISH_TYPES,
  MEASURE_TYPES,
  MEASURE_UNITS,
} = require('./constants');
const { formatDate } = require('../text');

const FONT = path.join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf');

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function buildReportHtml(inspection, user) {
  const progress = await progressFor(inspection.id);
  const defects = await listDefects(inspection.id);
  const historyRows = await getHistory(inspection.id);
  const rooms = progress.rooms;

  let defectBlocks = '';
  let n = 0;
  for (const defect of defects) {
    n += 1;
    const photos = await listPhotos(defect.id);
    const measures = await listMeasurements(defect.id);
    const photoHtml = photos
      .map((p) => `<p class="photo">Фото #${p.id} (${esc(p.kind)}) — файл ${esc(p.stored_name)}</p>`)
      .join('');
    const measureHtml = measures
      .map(
        (m) =>
          `<li>${esc(MEASURE_TYPES[m.measure_type] || m.measure_type)}: <strong>${esc(m.value_numeric)} ${esc(
            MEASURE_UNITS[m.unit] || m.unit
          )}</strong> ${esc(m.note)}</li>`
      )
      .join('');
    defectBlocks += `
      <section class="defect">
        <h3>Дефект № ${n}</h3>
        <dl>
          <div><dt>Помещение</dt><dd>${esc(defect.room_name || 'Общее')}</dd></div>
          <div><dt>Заголовок</dt><dd>${esc(defect.title)}</dd></div>
          <div><dt>Описание</dt><dd>${esc(defect.description)}</dd></div>
          <div><dt>Критичность</dt><dd>${esc(SEVERITIES[defect.severity] || defect.severity)} <span class="note">(не юридическая оценка)</span></dd></div>
          <div><dt>Статус</dt><dd>${esc(defect.status)}</dd></div>
          <div><dt>Место</dt><dd>${esc(defect.location_description)}</dd></div>
        </dl>
        ${measureHtml ? `<ul>${measureHtml}</ul>` : '<p class="muted">Замеров нет.</p>'}
        ${photoHtml || '<p class="muted">Фото нет.</p>'}
      </section>`;
  }

  const roomList = rooms.map((r) => `<li>${esc(r.name)}</li>`).join('');
  const hist = historyRows
    .map((h) => `<li>${esc(formatDate(h.created_at))} — ${esc(h.full_name || 'Система')}: ${esc(h.action)}</li>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Отчёт приёмки — ${esc(inspection.title)}</title>
<style>
  body { font-family: Georgia, serif; color: #1a1714; margin: 2rem; line-height: 1.4; }
  h1,h2,h3 { font-family: system-ui, sans-serif; }
  .muted, .note { color: #5f584e; font-size: 0.92rem; }
  dl div { border-top: 1px solid #d5cec2; padding: 0.4rem 0; }
  dt { color: #5f584e; font-size: 0.85rem; } dd { margin: 0.15rem 0 0; }
  .defect { page-break-inside: avoid; margin: 1.5rem 0; padding-top: 0.5rem; border-top: 2px solid #1a1714; }
  .stats span { display: inline-block; margin-right: 1rem; }
</style>
</head>
<body>
  <header>
    <p class="muted">Наряд · Приёмка</p>
    <h1>${esc(inspection.title)}</h1>
    <p>${esc(inspection.address)}</p>
    <p class="muted">Отчёт сформирован для ${esc(user.full_name)}. Фиксация осмотра, не юридическое заключение.</p>
  </header>
  <section>
    <h2>Объект</h2>
    <dl>
      <div><dt>Тип</dt><dd>${esc(PROPERTY_TYPES[inspection.property_type] || inspection.property_type)}</dd></div>
      <div><dt>Отделка</dt><dd>${esc(FINISH_TYPES[inspection.finish_type] || inspection.finish_type)}</dd></div>
      <div><dt>ЖК</dt><dd>${esc(inspection.residential_complex || '—')}</dd></div>
      <div><dt>Квартира</dt><dd>${esc(inspection.apartment_number || '—')}</dd></div>
      <div><dt>Площадь</dt><dd>${esc(inspection.area_m2 || '—')} м²</dd></div>
    </dl>
  </section>
  <section>
    <h2>Статистика</h2>
    <p class="stats">
      <span>Пунктов: ${progress.overall.total}</span>
      <span>OK: ${progress.overall.ok}</span>
      <span>Замечаний (пункты): ${progress.overall.defect}</span>
      <span>Н/П: ${progress.overall.na}</span>
      <span>Не проверено: ${progress.overall.unchecked}</span>
      <span>Дефектов: ${progress.defectsCount}</span>
    </p>
  </section>
  <section>
    <h2>Помещения</h2>
    <ul>${roomList || '<li>Нет</li>'}</ul>
  </section>
  <section>
    <h2>Дефекты</h2>
    ${defectBlocks || '<p>Замечаний нет.</p>'}
  </section>
  <section>
    <h2>История</h2>
    <ul>${hist || '<li>Пусто</li>'}</ul>
  </section>
</body>
</html>`;
}

function buildPdfBuffer(inspection, user, progress, rooms, defectDetails) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.font(FONT);

    doc.fontSize(10).fillColor('#5f584e').text('Наряд · Приёмка');
    doc.moveDown(0.3);
    doc.fillColor('#1a1714').fontSize(18).text(String(inspection.title || 'Отчёт приёмки'));
    doc.fontSize(11).text(String(inspection.address || ''));
    doc.moveDown(0.4);
    doc.fontSize(9).fillColor('#5f584e').text(
      `Отчёт для ${user.full_name}. Фиксация осмотра, не юридическое заключение.`
    );
    doc.moveDown();
    doc.fillColor('#1a1714').fontSize(13).text('Объект');
    doc.fontSize(10);
    doc.text(`Тип: ${PROPERTY_TYPES[inspection.property_type] || inspection.property_type}`);
    doc.text(`Отделка: ${FINISH_TYPES[inspection.finish_type] || inspection.finish_type}`);
    doc.text(`ЖК: ${inspection.residential_complex || '—'}`);
    doc.text(`Квартира: ${inspection.apartment_number || '—'}`);
    doc.text(`Площадь: ${inspection.area_m2 || '—'} м²`);
    doc.moveDown();
    doc.fontSize(13).text('Статистика');
    doc.fontSize(10);
    doc.text(
      `Пунктов ${progress.overall.total}; OK ${progress.overall.ok}; замечания ${progress.overall.defect}; Н/П ${progress.overall.na}; не проверено ${progress.overall.unchecked}; дефектов ${progress.defectsCount}`
    );
    doc.text(
      `Критичность: крит. ${progress.severity.CRITICAL}, серьёзн. ${progress.severity.MAJOR}, незнач. ${progress.severity.MINOR}, инфо ${progress.severity.INFO}`
    );
    doc.moveDown();
    doc.fontSize(13).text('Помещения');
    doc.fontSize(10);
    if (!rooms.length) doc.text('Нет');
    rooms.forEach((r) => doc.text(`• ${r.name}`));
    doc.moveDown();
    doc.fontSize(13).text('Дефекты');
    if (!defectDetails.length) {
      doc.fontSize(10).text('Замечаний нет.');
    }
    defectDetails.forEach((block, index) => {
      doc.moveDown(0.45);
      doc.fontSize(12).fillColor('#1a1714').text(`Дефект № ${index + 1}`);
      doc.fontSize(10);
      doc.text(`Помещение: ${block.room}`);
      doc.text(`Заголовок: ${block.title}`);
      doc.text(`Описание: ${block.description || '—'}`);
      doc.text(`Критичность: ${block.severity} (не юридическая оценка)`);
      doc.text(`Статус: ${block.status}`);
      doc.text(`Место: ${block.location || '—'}`);
      if (block.measures.length) block.measures.forEach((m) => doc.text(`Замер: ${m}`));
      else doc.text('Замеров нет.');
      doc.text(block.photoCount ? `Фото: ${block.photoCount}` : 'Фото нет.');
    });
    doc.end();
  });
}

async function generateReportVersion(inspection, user) {
  const progress = await progressFor(inspection.id);
  const defects = await listDefects(inspection.id);
  const defectDetails = [];
  for (const defect of defects) {
    const photos = await listPhotos(defect.id);
    const measures = await listMeasurements(defect.id);
    defectDetails.push({
      room: defect.room_name || 'Общее',
      title: defect.title,
      description: defect.description,
      severity: SEVERITIES[defect.severity] || defect.severity,
      status: defect.status,
      location: defect.location_description,
      measures: measures.map(
        (m) =>
          `${MEASURE_TYPES[m.measure_type] || m.measure_type}: ${m.value_numeric} ${MEASURE_UNITS[m.unit] || m.unit} ${m.note || ''}`
      ),
      photoCount: photos.length,
    });
  }

  await storage.uploadReport(Buffer.from(await buildReportHtml(inspection, user), 'utf8'), {
    ext: 'html',
  });
  const pdf = await buildPdfBuffer(inspection, user, progress, progress.rooms, defectDetails);
  const uploaded = await storage.uploadReport(pdf, { ext: 'pdf' });

  const report = await pool.query(
    `INSERT INTO inspection_reports (inspection_id)
     VALUES ($1)
     ON CONFLICT (inspection_id) DO UPDATE SET inspection_id = EXCLUDED.inspection_id
     RETURNING *`,
    [inspection.id]
  );
  const reportId = report.rows[0].id;
  const ver = await pool.query(
    `INSERT INTO inspection_report_versions (report_id, version, format, storage_key)
     VALUES (
       $1,
       COALESCE((SELECT MAX(version) + 1 FROM inspection_report_versions WHERE report_id = $1), 1),
       'pdf',
       $2
     )
     RETURNING *`,
    [reportId, uploaded.storageKey]
  );
  await pool.query(
    `INSERT INTO inspection_history (inspection_id, user_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, 'report_generated', 'report_version', $3, $4::jsonb)`,
    [inspection.id, user.id, ver.rows[0].id, JSON.stringify({ version: ver.rows[0].version, format: 'pdf' })]
  );
  return ver.rows[0];
}

async function latestReportVersion(inspectionId) {
  const { rows } = await pool.query(
    `SELECT v.*
     FROM inspection_report_versions v
     JOIN inspection_reports r ON r.id = v.report_id
     WHERE r.inspection_id = $1
     ORDER BY v.version DESC
     LIMIT 1`,
    [inspectionId]
  );
  return rows[0] || null;
}

module.exports = {
  buildReportHtml,
  generateReportVersion,
  latestReportVersion,
};
