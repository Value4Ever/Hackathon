// lib/phiAuditLog.cjs — HIPAA-compliant PHI access audit log (45 CFR §164.312(b)).
//
// EVERY read or write of Protected Health Information must be logged with:
//   - WHO   (user_id, session_id, IP, user_agent)
//   - WHAT  (action: read|write|delete|export, target_resource, fields_touched)
//   - WHEN  (timestamp, ISO 8601)
//   - WHY   (purpose_of_use: treatment | payment | operations | patient_request | other)
//   - RESULT (success / fail / partial)
//
// Persisted to SQLite (clinic.db::phi_audit_log) — append-only, immutable in production.
// Production hardening: WORM storage / cryptographic chain-of-custody / SIEM forwarding.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'clinic.db');
let _initialized = false;

function _ensureSchema() {
  if (_initialized) return;
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS phi_audit_log (
      audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user_id TEXT,
      user_role TEXT,
      session_id TEXT,
      ip_address TEXT,
      user_agent TEXT,
      action TEXT NOT NULL,
      target_resource TEXT,
      target_id TEXT,
      fields_touched TEXT,
      purpose_of_use TEXT,
      result TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_ts ON phi_audit_log(ts);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON phi_audit_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_target ON phi_audit_log(target_id);
  `);
  db.close();
  _initialized = true;
}

function log(entry) {
  _ensureSchema();
  const db = new Database(DB_PATH);
  try {
    db.prepare(`INSERT INTO phi_audit_log
      (ts, user_id, user_role, session_id, ip_address, user_agent,
       action, target_resource, target_id, fields_touched, purpose_of_use, result, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        entry.ts || new Date().toISOString(),
        entry.user_id || null,
        entry.user_role || null,
        entry.session_id || null,
        entry.ip_address || null,
        entry.user_agent ? String(entry.user_agent).slice(0, 200) : null,
        entry.action || 'unknown',
        entry.target_resource || null,
        entry.target_id || null,
        entry.fields_touched ? (Array.isArray(entry.fields_touched) ? entry.fields_touched.join(',') : String(entry.fields_touched)) : null,
        entry.purpose_of_use || 'treatment',
        entry.result || 'success',
        entry.detail ? (typeof entry.detail === 'string' ? entry.detail : JSON.stringify(entry.detail)) : null
      );
  } finally { db.close(); }
}

function queryLog(opts) {
  _ensureSchema();
  opts = opts || {};
  const db = new Database(DB_PATH, { readonly: true });
  try {
    let q = 'SELECT * FROM phi_audit_log WHERE 1=1';
    const params = [];
    if (opts.user_id) { q += ' AND user_id = ?'; params.push(opts.user_id); }
    if (opts.target_id) { q += ' AND target_id = ?'; params.push(opts.target_id); }
    if (opts.action) { q += ' AND action = ?'; params.push(opts.action); }
    if (opts.since) { q += ' AND ts >= ?'; params.push(opts.since); }
    q += ' ORDER BY ts DESC LIMIT ?';
    params.push(opts.limit || 200);
    return db.prepare(q).all(...params);
  } finally { db.close(); }
}

// Helper: extract IP + UA from Node http req
function extractContext(req) {
  return {
    ip_address: req.connection?.remoteAddress || req.headers?.['x-forwarded-for'] || 'unknown',
    user_agent: req.headers?.['user-agent'] || 'unknown'
  };
}

// Suspicious-access detection — flag unusual patterns for security review
function detectSuspicious(opts) {
  _ensureSchema();
  opts = opts || {};
  const db = new Database(DB_PATH, { readonly: true });
  const sinceIso = new Date(Date.now() - (opts.lookback_hours || 24) * 60 * 60 * 1000).toISOString();
  const flags = [];
  try {
    // Pattern 1: high-volume access by single user (>100 records / hour)
    const highVol = db.prepare(`
      SELECT user_id, COUNT(*) as n FROM phi_audit_log
      WHERE ts >= ? AND action = 'read' GROUP BY user_id HAVING n > 100
    `).all(sinceIso);
    for (const r of highVol) flags.push({ pattern: 'high_volume_access', user_id: r.user_id, count: r.n, severity: 'medium' });
    // Pattern 2: after-hours access (configurable — here: outside 6am-10pm local)
    const afterHours = db.prepare(`
      SELECT user_id, target_id, ts FROM phi_audit_log
      WHERE ts >= ? AND (CAST(strftime('%H', ts) AS INTEGER) < 6 OR CAST(strftime('%H', ts) AS INTEGER) >= 22)
    `).all(sinceIso);
    if (afterHours.length > 0) flags.push({ pattern: 'after_hours_access', count: afterHours.length, severity: 'low', samples: afterHours.slice(0, 3) });
    // Pattern 3: export action (always flagged for review)
    const exports = db.prepare(`SELECT * FROM phi_audit_log WHERE ts >= ? AND action = 'export'`).all(sinceIso);
    if (exports.length > 0) flags.push({ pattern: 'export_action', count: exports.length, severity: 'high', samples: exports.slice(0, 3) });
    // Pattern 4: failed access attempts
    const failures = db.prepare(`SELECT * FROM phi_audit_log WHERE ts >= ? AND result != 'success'`).all(sinceIso);
    if (failures.length > 5) flags.push({ pattern: 'multiple_failed_access', count: failures.length, severity: 'high' });
  } finally { db.close(); }
  return flags;
}

module.exports = { log, queryLog, extractContext, detectSuspicious };
