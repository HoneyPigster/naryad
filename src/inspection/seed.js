const { pool } = require('../db');

/** Seed apartment checklist v1 + defect phrase templates. Idempotent by template name+version. */
async function seedInspectionCatalog(client = pool) {
  const existing = await client.query(
    `SELECT t.id, v.id AS version_id
     FROM checklist_templates t
     JOIN checklist_template_versions v ON v.template_id = t.id
     WHERE t.name = $1 AND v.version = 1
     LIMIT 1`,
    ['Квартира — базовая приёмка']
  );
  if (!existing.rowCount) {
    const tpl = await client.query(
      `INSERT INTO checklist_templates (name, property_type, is_active)
       VALUES ($1, 'APARTMENT', TRUE) RETURNING id`,
      ['Квартира — базовая приёмка']
    );
    const version = await client.query(
      `INSERT INTO checklist_template_versions (template_id, version)
       VALUES ($1, 1) RETURNING id`,
      [tpl.rows[0].id]
    );
    const versionId = version.rows[0].id;
    let sectionOrder = 0;
    for (const section of SECTIONS) {
      sectionOrder += 1;
      const sec = await client.query(
        `INSERT INTO checklist_sections (version_id, name, sort_order)
         VALUES ($1, $2, $3) RETURNING id`,
        [versionId, section.name, sectionOrder]
      );
      let itemOrder = 0;
      for (const item of section.items) {
        itemOrder += 1;
        await client.query(
          `INSERT INTO checklist_items
            (section_id, title, instruction, sort_order, scope, finish_tags, requires_measurement, severity_default)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            sec.rows[0].id,
            item.title,
            item.instruction || '',
            itemOrder,
            item.scope,
            item.tags,
            Boolean(item.measure),
            item.severity || 'MINOR',
          ]
        );
      }
    }
  }

  const phrases = await client.query('SELECT COUNT(*)::int AS n FROM defect_templates');
  if (!phrases.rows[0].n) {
    let i = 0;
    for (const row of DEFECT_PHRASES) {
      i += 1;
      await client.query(
        `INSERT INTO defect_templates (title, body, sort_order, is_active)
         VALUES ($1, $2, $3, TRUE)`,
        [row.title, row.body, i]
      );
    }
  }
}

const SECTIONS = [
  {
    name: 'Документы и общие параметры',
    items: [
      {
        title: 'Документы на объект под рукой (договор / ДДУ / акт)',
        instruction: 'Сверьте адрес, номер квартиры и стороны договора.',
        scope: 'PROJECT',
        tags: ['docs'],
      },
      {
        title: 'План / планировка доступны для сверки',
        instruction: 'Отметьте расхождения планировки отдельно как замечание.',
        scope: 'PROJECT',
        tags: ['docs'],
      },
      {
        title: 'Адрес, этаж и номер квартиры совпадают с документами',
        instruction: 'Проверьте таблички и ключи.',
        scope: 'PROJECT',
        tags: ['docs'],
      },
    ],
  },
  {
    name: 'Входная дверь',
    items: [
      {
        title: 'Дверь открывается и закрывается без заеданий',
        instruction: 'Проверьте все замки и защёлку.',
        scope: 'PROJECT',
        tags: ['openings', 'base'],
      },
      {
        title: 'Уплотнители и глазок на месте, без повреждений',
        instruction: 'Осмотрите торцы и уплотнение по периметру.',
        scope: 'PROJECT',
        tags: ['openings', 'base'],
      },
    ],
  },
  {
    name: 'Окна и стеклопакеты',
    items: [
      {
        title: 'Створки открываются во всех режимах без заеданий',
        instruction: 'Проверьте поворот, откид и микропроветривание.',
        scope: 'ROOM',
        tags: ['openings', 'base'],
      },
      {
        title: 'Стекло и рама без трещин и сколов',
        instruction: 'Осмотрите под разными углами при дневном свете.',
        scope: 'ROOM',
        tags: ['openings', 'base'],
        severity: 'MAJOR',
      },
      {
        title: 'Уплотнители прилегают, ручки фиксируются',
        instruction: 'При сомнении зафиксируйте зазор замером.',
        scope: 'ROOM',
        tags: ['openings', 'base'],
        measure: true,
      },
    ],
  },
  {
    name: 'Балкон / лоджия',
    items: [
      {
        title: 'Ограждение и остекление без видимых повреждений',
        instruction: 'Проверьте устойчивость и крепления визуально.',
        scope: 'ROOM',
        tags: ['openings', 'structure'],
      },
      {
        title: 'Слив / уклон пола балкона не даёт застоя воды на вид',
        instruction: 'Замечание фиксируйте фото при риске.',
        scope: 'ROOM',
        tags: ['structure', 'base'],
      },
    ],
  },
  {
    name: 'Стены',
    items: [
      {
        title: 'Нет трещин, отслоений и явных выбоин',
        instruction: 'Пройдите взглядом все плоскости комнаты.',
        scope: 'ROOM',
        tags: ['structure', 'base'],
      },
      {
        title: 'Углы и примыкания без критичных зазоров',
        instruction: 'При сомнении — замер отклонения.',
        scope: 'ROOM',
        tags: ['structure', 'base'],
        measure: true,
      },
    ],
  },
  {
    name: 'Потолок',
    items: [
      {
        title: 'Плоскость без трещин и следов протечек',
        instruction: 'Осмотрите стыки со стенами.',
        scope: 'ROOM',
        tags: ['structure', 'base'],
        severity: 'MAJOR',
      },
    ],
  },
  {
    name: 'Пол / стяжка',
    items: [
      {
        title: 'Покрытие / стяжка без выбоин и бухтения на ощупь',
        instruction: 'Пройдитесь по площади; спорные места — замер.',
        scope: 'ROOM',
        tags: ['rough', 'structure'],
        measure: true,
      },
      {
        title: 'Перепады на вид в пределах ожидаемого; иначе замер',
        instruction: 'Не делайте вывод о норме без документа — только факт замера.',
        scope: 'ROOM',
        tags: ['rough', 'structure'],
        measure: true,
      },
    ],
  },
  {
    name: 'Межкомнатные двери',
    items: [
      {
        title: 'Полотно закрывается, замок работает',
        instruction: 'Проверьте притвор и ручку.',
        scope: 'ROOM',
        tags: ['base', 'finish'],
      },
    ],
  },
  {
    name: 'Электрика',
    items: [
      {
        title: 'Розетки и выключатели на местах, корпуса целы',
        instruction: 'Не разбирайте щит — только визуально и тестером если есть.',
        scope: 'ROOM',
        tags: ['mep', 'base'],
      },
      {
        title: 'Щит доступен, автоматы подписаны/на местах (визуально)',
        instruction: 'Не отключайте чужие линии без необходимости.',
        scope: 'PROJECT',
        tags: ['mep'],
      },
    ],
  },
  {
    name: 'Освещение',
    items: [
      {
        title: 'Штатные точки света включаются (если подано питание)',
        instruction: 'Если питания нет — отметьте Н/П и зафиксируйте в заметке.',
        scope: 'ROOM',
        tags: ['mep', 'base'],
      },
    ],
  },
  {
    name: 'Сантехника и вода',
    items: [
      {
        title: 'Нет видимых протечек на соединениях',
        instruction: 'Осмотрите сифоны и углы.',
        scope: 'ROOM',
        tags: ['mep', 'wet'],
        severity: 'CRITICAL',
      },
      {
        title: 'Смесители / краны открываются и закрываются',
        instruction: 'Проверьте горячую и холодную, если подача есть.',
        scope: 'ROOM',
        tags: ['wet', 'finish'],
      },
    ],
  },
  {
    name: 'Канализация',
    items: [
      {
        title: 'Сливы принимают воду без явного подпора (если можно проверить)',
        instruction: 'При отсутствии воды — Н/П.',
        scope: 'ROOM',
        tags: ['mep', 'wet'],
      },
    ],
  },
  {
    name: 'Отопление',
    items: [
      {
        title: 'Радиаторы / конвекторы на местах, без повреждений',
        instruction: 'Осмотрите кронштейны и клапаны визуально.',
        scope: 'ROOM',
        tags: ['mep', 'base'],
      },
    ],
  },
  {
    name: 'Вентиляция',
    items: [
      {
        title: 'Решётка на месте; тяга ощущается (лист/анемометр по возможности)',
        instruction: 'Зафиксируйте отсутствие тяги как замечание.',
        scope: 'ROOM',
        tags: ['mep', 'base'],
      },
    ],
  },
  {
    name: 'Счётчики',
    items: [
      {
        title: 'Счётчики на месте; показания и пломбы зафиксированы фото',
        instruction: 'Сфотографируйте крупно цифры и пломбы.',
        scope: 'PROJECT',
        tags: ['mep', 'docs'],
      },
    ],
  },
  {
    name: 'Отделка',
    items: [
      {
        title: 'Покрытия стен без отслоений, пузырей и явных пятен',
        instruction: 'Обои/краска/панели — по факту отделки.',
        scope: 'ROOM',
        tags: ['finish'],
      },
      {
        title: 'Плинтусы и примыкания без критичных щелей',
        instruction: 'При щели — замер и фото.',
        scope: 'ROOM',
        tags: ['finish'],
        measure: true,
      },
      {
        title: 'Плитка без сколов; швы ровные на вид',
        instruction: 'Проверьте углы и пороги во влажных зонах.',
        scope: 'ROOM',
        tags: ['finish', 'wet'],
      },
    ],
  },
  {
    name: 'Кухонная зона',
    items: [
      {
        title: 'Мойка, столешница и фартук без повреждений (если смонтированы)',
        instruction: 'Иначе Н/П.',
        scope: 'ROOM',
        tags: ['kitchen', 'finish'],
      },
    ],
  },
  {
    name: 'Санузлы',
    items: [
      {
        title: 'Чаша / душевой поддон без сколов; герметик без разрывов',
        instruction: 'Осмотрите примыкания к стенам.',
        scope: 'ROOM',
        tags: ['wet', 'finish'],
        severity: 'MAJOR',
      },
    ],
  },
  {
    name: 'Оборудование',
    items: [
      {
        title: 'Штатное оборудование на местах согласно комплектации',
        instruction: 'Отсутствующие позиции — отдельным замечанием.',
        scope: 'PROJECT',
        tags: ['equip'],
      },
    ],
  },
  {
    name: 'Итоговая проверка',
    items: [
      {
        title: 'Все помещения обойдены; ключевые фото сделаны',
        instruction: 'Вернитесь к непроверенным пунктам при необходимости.',
        scope: 'PROJECT',
        tags: ['final'],
      },
      {
        title: 'Замечания сформулированы понятно для передачи стороне',
        instruction: 'Проверьте формулировки без юридических обещаний.',
        scope: 'PROJECT',
        tags: ['final', 'docs'],
      },
    ],
  },
];

const DEFECT_PHRASES = [
  { title: 'Царапина / скол', body: 'На поверхности обнаружена царапина / скол.' },
  { title: 'Отклонение / зазор', body: 'Выявлено отклонение / зазор; выполнен замер.' },
  { title: 'Заедание', body: 'Элемент работает с заеданием / не фиксируется штатно.' },
  { title: 'След влаги', body: 'Видимый след протечки / увлажнения в указанной зоне.' },
  { title: 'Комплектация', body: 'Отсутствует или повреждён элемент комплектации.' },
  { title: 'Трещина', body: 'Обнаружена трещина на поверхности.' },
];

module.exports = { seedInspectionCatalog, SECTIONS };
