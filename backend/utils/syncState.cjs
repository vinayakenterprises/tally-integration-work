/**
 * syncState.cjs
 * Contains utilities for hashing, saving, and loading sync snapshots.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = path.join(__dirname, '..', 'tally-sync-state');
if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

function stateFilePath(type, dateStr) {
  return path.join(STATE_DIR, `last-sync-${type}-${dateStr}.json`);
}

function hashJson(obj) {
  const str = JSON.stringify(obj);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function loadLastSnapshot(type, dateStr) {
  const file = stateFilePath(type, dateStr);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`[State] Could not read previous snapshot for ${type} on ${dateStr}: ${err.message}`);
    return null;
  }
}

function saveSnapshot(type, dateStr, hash, data) {
  const file = stateFilePath(type, dateStr);
  const payload = { hash, savedAt: new Date().toISOString(), data };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

function saveOutgoingJson(type, dateStr, data) {
  const file = path.join(STATE_DIR, `outgoing-${type}-${dateStr}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  return file;
}

module.exports = {
  STATE_DIR,
  hashJson,
  loadLastSnapshot,
  saveSnapshot,
  saveOutgoingJson
};
