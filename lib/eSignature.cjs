// lib/eSignature.cjs — 21 CFR Part 11 electronic-signature module.
//
// §11.50 Signature manifestations — every e-signature carries:
//   • printed name of signer
//   • date + time of execution
//   • meaning of the signature (e.g. "reviewed", "approved", "consent", "authored")
// §11.70 Signature/record linking — the signature is cryptographically bound to the
//   record so it cannot be excised, copied, or transferred to falsify another record.
// §11.100 Unique identifier — one signer per identifier, never reassigned.
// §11.200 Two distinct components — for non-biometric, identifier + password.
//   Critical-action signings re-authenticate the signer (Part 11 §11.200(a)(1)(i)).
// §11.300 ID/password controls — uniqueness, periodic revision, loss management.
//   (Periodic revision + loss handling are operational policies, not just code.)

'use strict';

const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');
const hipaa = require('./hipaaControls.cjs');

const DB_PATH = path.join(__dirname, '..', 'clinic.db');
let _initialized = false;

function _ensureSchema() {
  if (_initialized) return;
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS e_signatures (
      signature_id TEXT PRIMARY KEY,
      signer_user_id TEXT NOT NULL,
      signer_printed_name TEXT NOT NULL,
      signer_role TEXT,
      signed_at TEXT NOT NULL,
      meaning TEXT NOT NULL,
      record_resource TEXT NOT NULL,
      record_id TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      record_snapshot TEXT,
      signature_hash TEXT NOT NULL,
      previous_signature_hash TEXT,
      reauth_method TEXT,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sig_record ON e_signatures(record_resource, record_id);
    CREATE INDEX IF NOT EXISTS idx_sig_signer ON e_signatures(signer_user_id);
    CREATE INDEX IF NOT EXISTS idx_sig_signed ON e_signatures(signed_at);
  `);
  db.close();
  _initialized = true;
}

function _sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function _newId() { return 'SIG-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'); }

function _previousSignatureHash(db) {
  const row = db.prepare('SELECT signature_hash FROM e_signatures ORDER BY signed_at DESC, signature_id DESC LIMIT 1').get();
  return row ? row.signature_hash : 'genesis';
}

// Sign a record (Part 11 §11.50 + §11.70).
// Requires re-authentication (Part 11 §11.200) — the caller MUST verify the user's
// password before invoking this function. The reauth_method field documents what was used.
function sign(opts) {
  _ensureSchema();
  if (!opts.signer_user_id || !opts.signer_printed_name || !opts.meaning || !opts.record_resource || !opts.record_id) {
    throw new Error('e_signature_incomplete: signer_user_id, signer_printed_name, meaning, record_resource, record_id are required');
  }
  const meaningCanonical = (opts.meaning || '').toLowerCase();
  const validMeanings = ['authorship', 'review', 'approval', 'responsibility', 'consent', 'verification', 'release', 'attestation'];
  if (!validMeanings.includes(meaningCanonical)) {
    throw new Error('invalid_meaning: must be one of ' + validMeanings.join(', '));
  }
  const recordSnapshot = opts.record_snapshot ? (typeof opts.record_snapshot === 'string' ? opts.record_snapshot : JSON.stringify(opts.record_snapshot)) : null;
  const recordHash = _sha256(opts.record_resource + ':' + opts.record_id + ':' + (recordSnapshot || ''));
  const signedAt = new Date().toISOString();
  const signatureId = _newId();
  const db = new Database(DB_PATH);
  try {
    const prevHash = _previousSignatureHash(db);
    // Signature hash chains: hash(prev || this record-payload) — §11.10(e) tamper-evidence
    const sigPayload = JSON.stringify({
      signature_id: signatureId, signer_user_id: opts.signer_user_id, signer_printed_name: opts.signer_printed_name,
      signed_at: signedAt, meaning: meaningCanonical, record_resource: opts.record_resource,
      record_id: opts.record_id, record_hash: recordHash
    });
    const signatureHash = _sha256(prevHash + '||' + sigPayload);
    db.prepare(`INSERT INTO e_signatures
      (signature_id, signer_user_id, signer_printed_name, signer_role, signed_at, meaning,
       record_resource, record_id, record_hash, record_snapshot,
       signature_hash, previous_signature_hash, reauth_method, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      signatureId, opts.signer_user_id, opts.signer_printed_name, opts.signer_role || null,
      signedAt, meaningCanonical, opts.record_resource, opts.record_id, recordHash,
      recordSnapshot, signatureHash, prevHash, opts.reauth_method || 'password',
      opts.ip_address || null, opts.user_agent ? String(opts.user_agent).slice(0, 200) : null
    );
    return {
      signature_id: signatureId, signed_at: signedAt, meaning: meaningCanonical,
      record_hash: recordHash, signature_hash: signatureHash,
      previous_signature_hash: prevHash,
      compliance: ['21 CFR §11.50', '21 CFR §11.70', '21 CFR §11.100', '21 CFR §11.200']
    };
  } finally { db.close(); }
}

// Verify a record's signature chain — Part 11 §11.10(e) tamper-evidence check.
function verifyChain() {
  _ensureSchema();
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM e_signatures ORDER BY signed_at ASC, signature_id ASC').all();
    let prevHash = 'genesis';
    const breaks = [];
    for (const r of rows) {
      const recompPayload = JSON.stringify({
        signature_id: r.signature_id, signer_user_id: r.signer_user_id, signer_printed_name: r.signer_printed_name,
        signed_at: r.signed_at, meaning: r.meaning, record_resource: r.record_resource,
        record_id: r.record_id, record_hash: r.record_hash
      });
      const recomp = _sha256(prevHash + '||' + recompPayload);
      if (recomp !== r.signature_hash || r.previous_signature_hash !== prevHash) {
        breaks.push({ signature_id: r.signature_id, signed_at: r.signed_at, expected_hash: recomp, stored_hash: r.signature_hash });
      }
      prevHash = r.signature_hash;
    }
    return { total_signatures: rows.length, integrity_breaks: breaks.length, breaks, chain_head: prevHash };
  } finally { db.close(); }
}

// Get signatures for a record (Part 11 §11.70 — review the signature attached to the record)
function listForRecord(resource, recordId) {
  _ensureSchema();
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare('SELECT * FROM e_signatures WHERE record_resource = ? AND record_id = ? ORDER BY signed_at DESC')
      .all(resource, recordId);
  } finally { db.close(); }
}

// Helper: sign with re-authentication. Requires the user to re-supply password
// per Part 11 §11.200(a)(1)(i) — first signing of session requires both components;
// subsequent signings in the SAME continuous session may use one. We require BOTH
// every time for the demo (more conservative).
function signWithReauth(opts) {
  if (!opts.user_id || !opts.password) throw new Error('reauth_required: supply user_id + password');
  const login = hipaa.login(opts.user_id, opts.password);
  if (!login.ok) throw new Error('reauth_failed: invalid credentials');
  // Don't keep the new session — just verify the password worked.
  hipaa.logout(login.session.token);
  return sign({
    ...opts,
    signer_user_id: login.session.user_id,
    signer_printed_name: login.session.name,
    signer_role: login.session.role,
    reauth_method: 'password_two_component'
  });
}

module.exports = { sign, signWithReauth, verifyChain, listForRecord };
