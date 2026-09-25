const { pool } = require('../db');
const { PRODUCT_INSPECTION } = require('./constants');

async function grantUnpaidEntitlement(userId, projectId, client = pool) {
  await client.query(
    `INSERT INTO billing_entitlements
      (user_id, product_id, subject_type, subject_id, source)
     VALUES ($1, $2, 'inspection_project', $3, 'unpaid_confirm')
     ON CONFLICT (user_id, product_id, subject_type, subject_id) DO NOTHING`,
    [userId, PRODUCT_INSPECTION, projectId]
  );
}

async function hasEntitlement(userId, projectId, client = pool) {
  const { rows } = await client.query(
    `SELECT 1 FROM billing_entitlements
     WHERE user_id = $1 AND product_id = $2
       AND subject_type = 'inspection_project' AND subject_id = $3
     LIMIT 1`,
    [userId, PRODUCT_INSPECTION, projectId]
  );
  return Boolean(rows[0]);
}

/** Idempotent payment event processor for future PSP / test provider. */
async function processPaymentEvent(
  { provider, providerEventId, userId, projectId, payload },
  client = pool
) {
  const inserted = await client.query(
    `INSERT INTO billing_payment_events
      (provider, provider_event_id, product_id, subject_type, subject_id, payload)
     VALUES ($1, $2, $3, 'inspection_project', $4, $5::jsonb)
     ON CONFLICT (provider, provider_event_id) DO NOTHING
     RETURNING id`,
    [provider, providerEventId, PRODUCT_INSPECTION, projectId, JSON.stringify(payload || {})]
  );
  if (!inserted.rowCount) {
    return { duplicate: true };
  }
  await client.query(
    `INSERT INTO billing_entitlements
      (user_id, product_id, subject_type, subject_id, source, provider_event_id)
     VALUES ($1, $2, 'inspection_project', $3, $4, $5)
     ON CONFLICT (user_id, product_id, subject_type, subject_id) DO NOTHING`,
    [userId, PRODUCT_INSPECTION, projectId, `payment:${provider}`, providerEventId]
  );
  return { duplicate: false };
}

module.exports = {
  grantUnpaidEntitlement,
  hasEntitlement,
  processPaymentEvent,
};
