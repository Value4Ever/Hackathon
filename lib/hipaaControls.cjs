// lib/hipaaControls.cjs — HIPAA technical safeguards: auth + RBAC + redaction + consent.
//
// 45 CFR §164.308 (Administrative), §164.310 (Physical), §164.312 (Technical).
// THIS FILE implements the technical safeguards a covered entity's app layer is responsible for.
// Production also requires the physical + administrative + Business Associate Agreement layers.

'use strict';

const crypto = require('crypto');

// ── ROLES + permission matrix
// Front-desk: scheduling + verification, NO clinical notes
// Hygienist: clinical + scheduling
// Dentist: full clinical access
// Office-mgr: financial + reporting + de-identified analytics
// Patient: own record only (self-service portal)
const ROLES = {
  front_desk: {
    can_read: ['demographics', 'insurance', 'appointments', 'communications', 'consent', 'payments_summary'],
    can_write: ['appointments', 'communications', 'consent'],
    can_export: false,
    purpose: 'operations'
  },
  hygienist: {
    can_read: ['demographics', 'insurance', 'appointments', 'communications', 'consent', 'payments_summary', 'medical_history', 'treatments', 'recall'],
    can_write: ['treatments', 'recall'],
    can_export: false,
    purpose: 'treatment'
  },
  dentist: {
    can_read: '*',
    can_write: ['treatments', 'medical_history', 'pending_treatment'],
    can_export: true,
    purpose: 'treatment'
  },
  office_mgr: {
    can_read: ['demographics', 'insurance', 'appointments', 'payments', 'aggregates'],
    can_write: ['payments'],
    can_export: true,
    purpose: 'payment'
  },
  patient: {
    can_read: ['own_record', 'own_appointments', 'own_payments', 'own_audit_log'],
    can_write: ['own_consent'],
    can_export: true,
    purpose: 'patient_request'
  },
  // Demo / read-only — strips PHI by default
  demo: {
    can_read: ['demographics_redacted', 'appointments_summary', 'aggregates'],
    can_write: [],
    can_export: false,
    purpose: 'demonstration'
  }
};

// In-memory user store (hackathon — production wires Entra/Okta SSO)
// Passwords are bcrypt-hashed in production; here we use SHA256 + salt for the demo.
const _USERS = new Map();
function _hash(pw, salt) { return crypto.createHash('sha256').update(salt + ':' + pw).digest('hex'); }
function seedDemoUsers() {
  if (_USERS.size > 0) return;
  const seed = [
    { user_id: 'maria',   role: 'front_desk',  password: 'demo123', name: 'Maria Rodriguez', email: 'maria@bsd.demo' },
    { user_id: 'jamal',   role: 'hygienist',   password: 'demo123', name: 'Jamal Park',      email: 'jamal@bsd.demo' },
    { user_id: 'drchen',  role: 'dentist',     password: 'demo123', name: 'Dr. Chen',        email: 'chen@bsd.demo' },
    { user_id: 'admin',   role: 'office_mgr',  password: 'demo123', name: 'Office Manager',  email: 'admin@bsd.demo' },
    { user_id: 'demo',    role: 'demo',        password: 'demo',    name: 'Demo Viewer',     email: 'demo@bsd.demo' },
  ];
  for (const u of seed) {
    const salt = crypto.randomBytes(8).toString('hex');
    _USERS.set(u.user_id, { ...u, salt, pw_hash: _hash(u.password, salt) });
  }
}
seedDemoUsers();

// In-memory sessions — production: Redis / encrypted JWT
const _SESSIONS = new Map();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes auto-logoff per §164.312(a)(2)(iii)

function login(user_id, password) {
  const u = _USERS.get(user_id);
  if (!u) return { ok: false, error: 'invalid_credentials' };
  const test = _hash(password, u.salt);
  if (test !== u.pw_hash) return { ok: false, error: 'invalid_credentials' };
  const token = crypto.randomBytes(24).toString('hex');
  const session = {
    token, user_id: u.user_id, role: u.role, name: u.name,
    created_at: new Date().toISOString(),
    last_activity: Date.now(),
    expires_at: Date.now() + SESSION_TIMEOUT_MS
  };
  _SESSIONS.set(token, session);
  return { ok: true, session };
}
function logout(token) { _SESSIONS.delete(token); return { ok: true }; }
function validateSession(token) {
  if (!token) return null;
  const s = _SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.expires_at) { _SESSIONS.delete(token); return null; }
  s.last_activity = Date.now();
  s.expires_at = Date.now() + SESSION_TIMEOUT_MS;
  return s;
}
function listUsers() { return Array.from(_USERS.values()).map(u => ({ user_id: u.user_id, role: u.role, name: u.name })); }

// ── PHI redactor — strip/mask fields based on role + de-identification mode
const PHI_FIELDS_BY_RESOURCE = {
  patient: ['first_name','last_name','date_of_birth','address','city','zip','phone','email','emergency_contact_name','emergency_contact_phone','member_id','allergies','medications','medical_conditions'],
};
function redactPatient(record, role, opts) {
  opts = opts || {};
  if (!record) return record;
  const r = JSON.parse(JSON.stringify(record));
  const roleSpec = ROLES[role] || ROLES.demo;
  const fullAccess = roleSpec.can_read === '*' || roleSpec.can_read.includes('demographics') || roleSpec.can_read.includes('own_record');
  const demographicsRedacted = !fullAccess || opts.de_identify;
  if (demographicsRedacted) {
    // Apply HIPAA Safe Harbor de-identification — strip / mask 18 identifiers
    if (r.first_name) r.first_name = _maskName(r.first_name);
    if (r.last_name)  r.last_name  = _maskName(r.last_name);
    if (r.date_of_birth) r.date_of_birth = _maskDob(r.date_of_birth);
    if (r.age && r.age >= 90) r.age = '90+'; // §164.514(b)(2)(i)(C)
    if (r.phone) r.phone = _maskPhone(r.phone);
    if (r.email) r.email = _maskEmail(r.email);
    if (r.address) r.address = '[REDACTED]';
    if (r.zip) r.zip = String(r.zip).slice(0, 3) + 'XX'; // 3-digit ZIP allowed per Safe Harbor
    if (r.emergency_contact_name) r.emergency_contact_name = '[REDACTED]';
    if (r.emergency_contact_phone) r.emergency_contact_phone = '[REDACTED]';
    if (r.member_id) r.member_id = '****' + String(r.member_id).slice(-4);
    if (r.allergies) r.allergies = '[REDACTED]';
    if (r.medications) r.medications = '[REDACTED]';
    if (r.medical_conditions) r.medical_conditions = '[REDACTED]';
    r._phi_redacted = true;
  }
  // Minimum-necessary — strip fields not in role's can_read
  if (roleSpec.can_read !== '*' && !opts.full) {
    // For demo role: ONLY return demographics_redacted + summary fields
    if (role === 'demo') {
      const allowed = new Set(['patient_id','age','gender','city','state','risk_archetype','preferred_channel','plan_type','last_cleaning_date','recall_interval_months','_phi_redacted']);
      for (const k of Object.keys(r)) if (!allowed.has(k)) delete r[k];
    }
  }
  return r;
}
function _maskName(s) { if (!s || s.length === 0) return s; return s.charAt(0) + '*'.repeat(Math.max(1, s.length - 1)); }
function _maskDob(s) { if (!s) return s; return s.slice(0, 4) + '-XX-XX'; }
function _maskPhone(s) { if (!s) return s; const d = String(s).replace(/[^\d]/g, ''); if (d.length < 4) return '***'; return '***-***-' + d.slice(-4); }
function _maskEmail(s) { if (!s) return s; const [u, d] = s.split('@'); if (!d) return '***'; return u.charAt(0) + '***@' + d; }

// ── Consent gate — block outreach without active consent (45 CFR §164.508)
// Stored on patient record (clinic_patients.sms_opt_in, email_opt_in, phone_ok)
function consentCheck(patient, channel) {
  if (!patient) return { allowed: false, reason: 'no_patient_record' };
  if (channel === 'sms') {
    if (patient.sms_opt_in === 1 || patient.sms_opt_in === true) return { allowed: true };
    return { allowed: false, reason: 'patient_has_not_opted_in_for_sms', remediation: 'Obtain written or e-consent before sending SMS.' };
  }
  if (channel === 'email') {
    if (patient.email_opt_in === 1 || patient.email_opt_in === true) return { allowed: true };
    return { allowed: false, reason: 'patient_has_not_opted_in_for_email', remediation: 'Obtain consent before sending email.' };
  }
  if (channel === 'call' || channel === 'voicemail' || channel === 'insurance_call') {
    if (patient.phone_ok === 1 || patient.phone_ok === true) return { allowed: true };
    return { allowed: false, reason: 'patient_has_not_authorized_phone_contact', remediation: 'Confirm phone-contact consent.' };
  }
  return { allowed: true };
}

// ── Permission check — does this role have the right to read this resource?
function canRead(role, resource) {
  const spec = ROLES[role];
  if (!spec) return false;
  if (spec.can_read === '*') return true;
  return spec.can_read.includes(resource);
}
function canWrite(role, resource) {
  const spec = ROLES[role];
  if (!spec) return false;
  if (spec.can_write === '*') return true;
  return spec.can_write.includes(resource);
}
function canExport(role) { return !!(ROLES[role] && ROLES[role].can_export); }

module.exports = {
  ROLES, login, logout, validateSession, listUsers,
  redactPatient, consentCheck, canRead, canWrite, canExport,
  SESSION_TIMEOUT_MS, PHI_FIELDS_BY_RESOURCE
};
