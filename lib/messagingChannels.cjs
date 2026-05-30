// lib/messagingChannels.cjs — outbound + inbound messaging abstraction.
//
// Supports 4 channels:
//   - sms        (Twilio Messaging API in prod; mock log here)
//   - whatsapp   (Twilio WhatsApp Business / Meta Cloud API in prod; mock log here)
//   - voice      (Twilio Voice / Vonage in prod; mock log here)
//   - email      (SendGrid / SES in prod; mock log here)
//
// All sends route through `send(opts)` which:
//   1. Honors consent (`lib/hipaaControls.cjs::consentCheck`) — refuses if not opted-in
//   2. Persists to `messaging_log` SQLite table
//   3. Returns a receipt with delivery status (mocked)
//
// Per HIPAA §164.502(a) — SMS/email are direct identifiers; only send the minimum-
// necessary content. Production swap: replace the `_mockDeliver()` function with real
// vendor API calls + BAA in place.

'use strict';

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const hipaa = require('./hipaaControls.cjs');

const DB_PATH = path.join(__dirname, '..', 'clinic.db');
let _initialized = false;

function _ensureSchema() {
  if (_initialized) return;
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messaging_log (
      message_id TEXT PRIMARY KEY,
      sent_at TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      to_address TEXT,
      from_address TEXT,
      patient_id TEXT,
      audience TEXT,
      purpose TEXT,
      body TEXT,
      subject TEXT,
      provider TEXT,
      provider_message_id TEXT,
      status TEXT,
      delivered_at TEXT,
      read_at TEXT,
      response_at TEXT,
      response_body TEXT,
      consent_check_passed INTEGER,
      consent_check_reason TEXT,
      campaign_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_pid ON messaging_log(patient_id);
    CREATE INDEX IF NOT EXISTS idx_msg_sent ON messaging_log(sent_at);
    CREATE INDEX IF NOT EXISTS idx_msg_channel ON messaging_log(channel);
    CREATE INDEX IF NOT EXISTS idx_msg_status ON messaging_log(status);
  `);
  db.close();
  _initialized = true;
}

function _newId(prefix) { return prefix + '-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex'); }

// Mock delivery — simulates realistic vendor behavior.
// Production: replace with Twilio.messages.create / Meta WhatsApp / SendGrid / Vonage.
function _mockDeliver(channel, opts) {
  // Simulate delivery + read receipts based on channel
  let deliveryRate = 0.92;
  let readRate = 0.65;
  let respondRate = 0.18;
  if (channel === 'whatsapp') { deliveryRate = 0.96; readRate = 0.82; respondRate = 0.34; }
  if (channel === 'sms') { deliveryRate = 0.94; readRate = 0.78; respondRate = 0.22; }
  if (channel === 'voice') { deliveryRate = 0.55; readRate = 0.55; respondRate = 0.30; } // 'read' = answered
  if (channel === 'email') { deliveryRate = 0.97; readRate = 0.42; respondRate = 0.08; }
  const r = Math.random();
  const delivered = r < deliveryRate;
  const read = delivered && Math.random() < readRate;
  const responded = read && Math.random() < respondRate;
  return {
    provider: 'mock',
    provider_message_id: _newId('mock'),
    status: delivered ? (read ? 'read' : 'delivered') : 'failed',
    delivered: delivered,
    read: read,
    responded: responded,
    delivered_at: delivered ? new Date().toISOString() : null,
    read_at: read ? new Date().toISOString() : null
  };
}

function send(opts) {
  _ensureSchema();
  if (!opts.channel) throw new Error('channel required');
  if (!opts.to) throw new Error('to required');
  if (!opts.body && !opts.subject) throw new Error('body or subject required');

  // ── HIPAA consent gate
  let consent_check_passed = true;
  let consent_check_reason = null;
  if (opts.patient) {
    const c = hipaa.consentCheck(opts.patient, opts.channel);
    consent_check_passed = c.allowed;
    consent_check_reason = c.reason || null;
    if (!consent_check_passed && !opts.bypass_consent_for_emergency) {
      // Block + log + return refusal
      const msgId = _newId('MSG');
      const db = new Database(DB_PATH);
      try {
        db.prepare(`INSERT INTO messaging_log
          (message_id, sent_at, channel, direction, to_address, from_address, patient_id, audience, purpose, body, subject, provider, provider_message_id, status, consent_check_passed, consent_check_reason, campaign_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          msgId, new Date().toISOString(), opts.channel, opts.direction || 'outbound',
          opts.to, opts.from || null, opts.patient_id || null, opts.audience || 'patient',
          opts.purpose || null, opts.body || null, opts.subject || null,
          'consent_blocked', null, 'blocked_no_consent', 0, consent_check_reason, opts.campaign_id || null
        );
      } finally { db.close(); }
      return { ok: false, blocked: true, reason: consent_check_reason, message_id: msgId };
    }
  }

  const receipt = _mockDeliver(opts.channel, opts);
  const messageId = _newId('MSG');
  const db = new Database(DB_PATH);
  try {
    db.prepare(`INSERT INTO messaging_log
      (message_id, sent_at, channel, direction, to_address, from_address, patient_id, audience, purpose, body, subject, provider, provider_message_id, status, delivered_at, read_at, consent_check_passed, consent_check_reason, campaign_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      messageId, new Date().toISOString(), opts.channel, opts.direction || 'outbound',
      opts.to, opts.from || null, opts.patient_id || null, opts.audience || 'patient',
      opts.purpose || null, opts.body || null, opts.subject || null,
      receipt.provider, receipt.provider_message_id, receipt.status,
      receipt.delivered_at, receipt.read_at, consent_check_passed ? 1 : 0, consent_check_reason,
      opts.campaign_id || null
    );
  } finally { db.close(); }
  return { ok: true, message_id: messageId, ...receipt };
}

function listMessages(opts) {
  _ensureSchema();
  opts = opts || {};
  const db = new Database(DB_PATH, { readonly: true });
  try {
    let q = 'SELECT * FROM messaging_log WHERE 1=1';
    const params = [];
    if (opts.channel) { q += ' AND channel = ?'; params.push(opts.channel); }
    if (opts.audience) { q += ' AND audience = ?'; params.push(opts.audience); }
    if (opts.patient_id) { q += ' AND patient_id = ?'; params.push(opts.patient_id); }
    if (opts.campaign_id) { q += ' AND campaign_id = ?'; params.push(opts.campaign_id); }
    if (opts.since) { q += ' AND sent_at >= ?'; params.push(opts.since); }
    q += ' ORDER BY sent_at DESC LIMIT ?';
    params.push(opts.limit || 200);
    return db.prepare(q).all(...params);
  } finally { db.close(); }
}

// Convenience helpers for specific audiences
function sendToPatient(patient, channel, body, opts) {
  opts = opts || {};
  const to = channel === 'email' ? patient.email
           : channel === 'whatsapp' ? patient.phone   // WhatsApp uses phone number
           : channel === 'sms' || channel === 'voice' ? patient.phone
           : patient.phone;
  return send({
    channel, to, patient, patient_id: patient.patient_id,
    audience: 'patient', body, ...opts
  });
}
function sendToStaff(channel, to, body, opts) {
  opts = opts || {};
  return send({
    channel, to, audience: 'staff', body, bypass_consent_for_emergency: true, ...opts
  });
}
function sendToDoctor(channel, to, body, opts) {
  opts = opts || {};
  return send({
    channel, to, audience: 'doctor', body, bypass_consent_for_emergency: true, ...opts
  });
}

module.exports = { send, listMessages, sendToPatient, sendToStaff, sendToDoctor };
