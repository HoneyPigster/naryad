const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function inspectionRoot() {
  const base = process.env.PHOTO_DIR || path.join(process.cwd(), 'data', 'photos');
  return path.resolve(base, 'inspection');
}

async function ensureRoot() {
  const root = inspectionRoot();
  await fs.promises.mkdir(root, { recursive: true });
  return root;
}

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function uploadImage(buffer, { prefix = 'defect' } = {}) {
  const ext = sniffImage(buffer);
  if (!ext) {
    const err = new Error('INVALID_IMAGE');
    err.code = 'INVALID_IMAGE';
    throw err;
  }
  if (buffer.length > 5 * 1024 * 1024) {
    const err = new Error('FILE_TOO_LARGE');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  const root = await ensureRoot();
  const name = `${prefix}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
  const full = path.join(root, name);
  await fs.promises.writeFile(full, buffer);
  return { storedName: name, fullPath: full, ext };
}

async function uploadReport(buffer, { prefix = 'report', ext = 'html' } = {}) {
  const root = await ensureRoot();
  const reports = path.join(root, 'reports');
  await fs.promises.mkdir(reports, { recursive: true });
  const name = `${prefix}-${crypto.randomBytes(12).toString('hex')}.${ext}`;
  const full = path.join(reports, name);
  await fs.promises.writeFile(full, buffer);
  return { storageKey: `reports/${name}`, fullPath: full };
}

function resolveStored(storedName) {
  const root = inspectionRoot();
  const base = path.basename(storedName);
  const full = path.resolve(root, base);
  if (!full.startsWith(root + path.sep) && full !== root) {
    return null;
  }
  return full;
}

function resolveReportKey(storageKey) {
  const root = inspectionRoot();
  const cleaned = String(storageKey || '').replace(/^\/+/, '');
  if (cleaned.includes('..')) return null;
  const full = path.resolve(root, cleaned);
  if (!full.startsWith(root + path.sep)) return null;
  return full;
}

async function deleteStored(storedName) {
  const full = resolveStored(storedName);
  if (!full) return;
  await fs.promises.unlink(full).catch(() => {});
}

module.exports = {
  inspectionRoot,
  ensureRoot,
  sniffImage,
  uploadImage,
  uploadReport,
  resolveStored,
  resolveReportKey,
  deleteStored,
};
