// lib/agentOrchestrator.cjs — multi-agent orchestration per whiteboard flow:
//
//   Patient calls (new or existing)
//        ↓
//   TRIAGE  (PMS / Nexhealth lookup by phone — new vs existing)
//        ↓
//   INTAKE AGENT (voice)   — only for new patients; collects basic identifiers
//        ↓                  + insurance card details (OCR mock)
//   INSURANCE AGENT        — eligibility verification (verifyEngine.cjs)
//                            uses 270 request OR web scrape OR voice call to carrier;
//                            triggers exceptionRouter on failure → HUMAN_ESCALATION
//        ↓
//   COST ESTIMATE AGENT    — runs verifyTreatmentPlan over the requested procedures,
//                            generates patient-facing OOP estimate
//        ↓
//   SCHEDULING AGENT       — proposes appointment slot using risk-aware policy
//                            (SPC + scheduler engine — deposit, lead time, etc.)
//        ↓
//   CONFIRMATION           — send appt confirmation text with cost estimate
//                            (or → HUMAN_ESCALATION if patient declines / can't decide)
//
// Each turn the orchestrator returns:
//   { state, agent, transcript_line, options[], session_data, escalation_reason? }
// The UI plays this turn-by-turn; the orchestrator is pure state.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { verifyTreatmentPlan } = require('../verifyEngine.cjs');
const { classifyEligibilityFailure, classifyVerifyExceptions } = require('../exceptionRouter.cjs');
const { buildCampaign } = require('./schedulerEngine.cjs');
const { analyzePatient } = require('./spcEngine.cjs');

const ELIG_DB = path.join(__dirname, '..', 'eligibility.db');
const CLINIC_DB = path.join(__dirname, '..', 'clinic.db');

function _eligDb() { return new Database(ELIG_DB, { readonly: true }); }
function _clinicDb() { return new Database(CLINIC_DB, { readonly: true }); }

// ── PMS / Nexhealth lookup mock — find by caller phone in clinic.db
function pmsLookupByPhone(phone) {
  if (!phone) return null;
  const db = _clinicDb();
  try {
    // Exact match first; then normalize (strip +1, dashes)
    const norm = phone.replace(/[^\d]/g, '').replace(/^1/, '');
    let row = db.prepare('SELECT * FROM clinic_patients WHERE phone = ?').get(phone);
    if (!row) row = db.prepare('SELECT * FROM clinic_patients WHERE phone LIKE ?').get('%' + norm.slice(-7));
    return row;
  } finally { db.close(); }
}

// ── Eligibility lookup that uses the mock vendor DB (verifyEngine.cjs source)
function eligibilityLookup(query) {
  const db = _eligDb();
  try {
    let row = null;
    if (query.member_id) {
      row = db.prepare('SELECT record_json FROM patients WHERE member_id = ?').get(query.member_id);
    }
    if (!row && query.first_name && query.last_name && query.date_of_birth) {
      row = db.prepare(`SELECT record_json FROM patients
        WHERE LOWER(first_name)=LOWER(?) AND LOWER(last_name)=LOWER(?) AND date_of_birth=?`)
        .get(query.first_name, query.last_name, query.date_of_birth);
    }
    return row ? JSON.parse(row.record_json) : null;
  } finally { db.close(); }
}

// ── Default treatment plan for the "what are you coming in for?" flow.
// In a real product the intake agent would parse the spoken reason and map to ADA codes.
const REASON_TO_PROCEDURES = {
  cleaning:       [{ ada_code: 'D0120', fee: 95 }, { ada_code: 'D1110', fee: 130 }, { ada_code: 'D0274', fee: 90 }],
  exam:           [{ ada_code: 'D0150', fee: 135 }, { ada_code: 'D0210', fee: 165 }],
  filling:        [{ ada_code: 'D0120', fee: 95 }, { ada_code: 'D2391', fee: 250 }],
  crown:          [{ ada_code: 'D0150', fee: 135 }, { ada_code: 'D0210', fee: 165 }, { ada_code: 'D2750', fee: 1200 }],
  root_canal:     [{ ada_code: 'D0150', fee: 135 }, { ada_code: 'D3330', fee: 1250 }],
  extraction:     [{ ada_code: 'D0150', fee: 135 }, { ada_code: 'D7140', fee: 215 }],
  emergency:      [{ ada_code: 'D0140', fee: 165 }, { ada_code: 'D0220', fee: 50 }],
  consult:        [{ ada_code: 'D9450', fee: 95 }],
};

// ── State machine
// Each state has: prompt (what the agent says), next(session, response) handler
const STATES = {
  TRIAGE: {
    agent: 'intake_agent',
    prompt: (s) => 'Thanks for calling Bright Smile Dental! May I have your phone number to look you up in our system?',
    expects: 'phone_number',
    next: (s, response) => {
      // PMS lookup by phone
      const existing = pmsLookupByPhone(response.phone_number || response.text);
      if (existing) {
        s.patient_status = 'existing';
        s.pms_record = existing;
        s.session_data.patient_name = existing.first_name + ' ' + existing.last_name;
        s.session_data.member_id = existing.member_id;
        s.session_data.payer_id = existing.payer_id;
        s.session_data.preferred_channel = existing.preferred_channel;
        // Run SPC analysis to inform scheduling-policy upstream
        try { s.session_data.spc = analyzePatient(existing.patient_id); } catch (_) {}
        return 'EXISTING_REASON';
      }
      s.patient_status = 'new';
      return 'INTAKE_NEW_NAME';
    }
  },

  INTAKE_NEW_NAME: {
    agent: 'intake_agent',
    prompt: (s) => 'I don\'t see you in our system — welcome! What\'s your full name?',
    expects: 'name',
    next: (s, response) => {
      const text = (response.text || '').trim();
      const parts = text.split(/\s+/);
      s.session_data.first_name = parts[0] || 'New';
      s.session_data.last_name = parts.slice(1).join(' ') || 'Patient';
      return 'INTAKE_NEW_DOB';
    }
  },

  INTAKE_NEW_DOB: {
    agent: 'intake_agent',
    prompt: (s) => 'Thanks ' + s.session_data.first_name + '. What\'s your date of birth? (e.g. 1989-03-12)',
    expects: 'dob',
    next: (s, response) => {
      s.session_data.date_of_birth = (response.text || '').trim();
      return 'INTAKE_NEW_INSURANCE';
    }
  },

  INTAKE_NEW_INSURANCE: {
    agent: 'intake_agent',
    prompt: (s) => 'Do you have dental insurance? If yes, please read me the member ID + carrier name from your card (e.g. "DDX448120731 Delta Dental"). Say "no" if you\'ll be self-pay.',
    expects: 'insurance_info',
    next: (s, response) => {
      const text = (response.text || '').trim();
      if (/^no$|^none$|^self.?pay/i.test(text)) {
        s.session_data.self_pay = true;
        return 'EXISTING_REASON'; // skip insurance; ask reason next
      }
      // Try to extract member ID + carrier
      const m = text.match(/([A-Z]{2,4}\d{6,12})/i);
      if (m) s.session_data.member_id = m[1].toUpperCase();
      // Extract carrier name (very rough)
      const carriers = ['Delta', 'MetLife', 'Aetna', 'Cigna', 'Guardian', 'United', 'Humana', 'BlueCross'];
      for (const c of carriers) if (new RegExp(c, 'i').test(text)) { s.session_data.payer_name = c; break; }
      // For demo, also accept just a member_id alone
      if (!s.session_data.member_id && /\d{6,}/.test(text)) {
        s.session_data.member_id = text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      }
      return 'INSURANCE_VERIFICATION';
    }
  },

  EXISTING_REASON: {
    agent: 'intake_agent',
    prompt: (s) => 'Hi ' + (s.session_data.patient_name || s.session_data.first_name) + ' — what brings you in? (cleaning / exam / filling / crown / root canal / extraction / emergency / consult)',
    expects: 'reason',
    next: (s, response) => {
      const r = (response.text || '').trim().toLowerCase();
      let key = 'cleaning';
      for (const k of Object.keys(REASON_TO_PROCEDURES)) if (r.includes(k.replace('_', ' ')) || r.includes(k)) { key = k; break; }
      s.session_data.reason = key;
      s.session_data.treatment_plan = REASON_TO_PROCEDURES[key];
      // For existing patient with PMS record we already have insurance; verify now
      if (s.patient_status === 'existing' && !s.session_data.self_pay) return 'INSURANCE_VERIFICATION';
      // Self-pay flow skips eligibility, goes to cost estimate from rack rates
      if (s.session_data.self_pay) return 'COST_ESTIMATE_SELF_PAY';
      return 'INSURANCE_VERIFICATION';
    }
  },

  INSURANCE_VERIFICATION: {
    agent: 'insurance_agent',
    prompt: (s) => 'One moment — calling ' + (s.session_data.payer_name || 'your carrier') + ' to verify your benefits...',
    silent: true, // agent runs without waiting for response
    next: (s) => {
      const query = {
        member_id: s.session_data.member_id,
        first_name: s.session_data.first_name || (s.pms_record && s.pms_record.first_name),
        last_name: s.session_data.last_name || (s.pms_record && s.pms_record.last_name),
        date_of_birth: s.session_data.date_of_birth || (s.pms_record && s.pms_record.date_of_birth),
        payer_id: s.session_data.payer_id
      };
      const rec = eligibilityLookup(query);
      if (!rec) {
        // Not found in mock vendor DB — eligibility failure
        s.session_data.eligibility_failed = true;
        const allPatients = (() => {
          const db = _eligDb();
          try { return db.prepare('SELECT * FROM patients').all().map(r => JSON.parse(r.record_json).patient); }
          finally { db.close(); }
        })();
        s.session_data.exceptions = classifyEligibilityFailure(query, allPatients);
        return 'HUMAN_ESCALATION_VERIFICATION';
      }
      // Reason might not be set yet for new patients — default cleaning
      if (!s.session_data.treatment_plan) {
        s.session_data.reason = 'cleaning';
        s.session_data.treatment_plan = REASON_TO_PROCEDURES.cleaning;
      }
      s.session_data.eligibility_record = rec;
      s.session_data.verify_result = verifyTreatmentPlan(rec, s.session_data.treatment_plan);
      s.session_data.verify_result.exceptions = classifyVerifyExceptions(s.session_data.verify_result);
      // If patient is on terminated coverage or has critical exceptions, escalate
      const blocking = (s.session_data.verify_result.exceptions || []).filter(e => e.severity === 'high' && (e.code === 'COVERAGE_TERMINATED' || e.code === 'MEMBER_NOT_FOUND'));
      if (blocking.length > 0) return 'HUMAN_ESCALATION_VERIFICATION';
      return s.session_data.reason ? 'COST_ESTIMATE' : 'EXISTING_REASON';
    }
  },

  COST_ESTIMATE: {
    agent: 'cost_estimate_agent',
    prompt: (s) => {
      const vr = s.session_data.verify_result;
      const oop = (vr.totals.patient_pays || 0).toFixed(2);
      const ins = (vr.totals.carrier_pays || 0).toFixed(2);
      const lines = [];
      lines.push('Good news — your ' + (s.session_data.reason.replace('_', ' ')) + ' is covered:');
      for (const l of vr.lines) {
        if (l.covered) lines.push('  • ' + l.description + ': insurance pays $' + l.carrier_pays.toFixed(2) + ', you pay $' + l.patient_pays.toFixed(2));
        else lines.push('  • ' + l.description + ': not covered (' + (l.not_covered_reason || 'see notes') + ') — $' + l.usual_fee.toFixed(2));
      }
      lines.push('Total: insurance $' + ins + ' / you pay $' + oop + '.');
      return lines.join('\n');
    },
    expects: 'cost_ack',
    next: (s) => 'SCHEDULING'
  },

  COST_ESTIMATE_SELF_PAY: {
    agent: 'cost_estimate_agent',
    prompt: (s) => {
      const total = (s.session_data.treatment_plan || []).reduce((sum, p) => sum + p.fee, 0);
      return 'Self-pay estimate for ' + s.session_data.reason.replace('_', ' ') + ': $' + total.toFixed(2) + ' total. Would you like to schedule?';
    },
    expects: 'cost_ack',
    next: (s) => 'SCHEDULING'
  },

  SCHEDULING: {
    agent: 'scheduling_agent',
    prompt: (s) => {
      // If existing patient, use SPC-driven policy. If new, default to high-confirmation policy.
      let policy = 'standard'; let depositText = '';
      let suggestedSlot = 'Tuesday 9:00 AM';
      if (s.session_data.spc && s.session_data.spc.risk) {
        const band = s.session_data.spc.risk.band;
        if (band === 'critical') {
          policy = 'critical'; depositText = ' We will need a $50 deposit (refundable on arrival) to hold the spot.';
          suggestedSlot = 'Wednesday 8:30 AM (morning slots have the best on-time rate)';
        } else if (band === 'high') {
          policy = 'high'; depositText = ' We will need a $25 deposit (refundable on arrival).';
          suggestedSlot = 'Thursday 10:00 AM';
        }
      }
      s.session_data.scheduling_policy = policy;
      s.session_data.deposit_required = !!depositText;
      s.session_data.suggested_slot = suggestedSlot;
      return 'What works for you next week? I have ' + suggestedSlot + ' available, or any other Mon–Fri morning or afternoon.' + depositText;
    },
    expects: 'slot_choice',
    next: (s, response) => {
      const t = (response.text || '').trim();
      if (/no|cancel|maybe later|i.?ll think|too expensive/i.test(t)) {
        s.session_data.declined_reason = t;
        return 'HUMAN_ESCALATION_DECLINE';
      }
      // Accept the suggested slot or whatever the patient says
      s.session_data.appt_slot = t.length > 5 ? t : s.session_data.suggested_slot;
      return 'CONFIRMATION';
    }
  },

  CONFIRMATION: {
    agent: 'scheduling_agent',
    prompt: (s) => {
      const vr = s.session_data.verify_result;
      const oop = vr ? (vr.totals.patient_pays || 0).toFixed(2) : ((s.session_data.treatment_plan || []).reduce((sum, p) => sum + p.fee, 0)).toFixed(2);
      const confirmationSms = 'Confirming your ' + s.session_data.reason.replace('_', ' ') +
        ' appointment at Bright Smile Dental for ' + (s.session_data.appt_slot) +
        '. Estimated out-of-pocket: $' + oop + '.' +
        (s.session_data.deposit_required ? ' Deposit link to follow.' : '') +
        ' Reply C to confirm, R to reschedule, X to cancel.';
      s.session_data.confirmation_sms = confirmationSms;
      s.completed = true;
      return 'You\'re all set. I just sent a confirmation text with the details + cost estimate. See you ' + s.session_data.appt_slot + '!';
    },
    terminal: true
  },

  HUMAN_ESCALATION_VERIFICATION: {
    agent: 'escalation',
    prompt: (s) => 'I\'m having trouble verifying your insurance — let me transfer you to one of our team members who can help. One moment...',
    escalation_reason: 'eligibility_failure',
    terminal: true
  },

  HUMAN_ESCALATION_DECLINE: {
    agent: 'escalation',
    prompt: (s) => 'I understand. Let me have one of our team members reach out so we can find the right time + payment plan for you. They\'ll text you within an hour.',
    escalation_reason: 'cost_or_scheduling_decline',
    terminal: true
  }
};

function createSession(callerPhone) {
  return {
    session_id: 'CALL-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
    started_at: new Date().toISOString(),
    caller_phone: callerPhone || null,
    state: 'TRIAGE',
    patient_status: null,
    session_data: {},
    transcript: [],
    completed: false,
    escalation: null
  };
}

function _agentSay(session, text) {
  session.transcript.push({ turn: session.transcript.length + 1, who: 'agent', agent: STATES[session.state]?.agent, text, at: new Date().toISOString() });
}
function _patientSay(session, text) {
  session.transcript.push({ turn: session.transcript.length + 1, who: 'patient', text, at: new Date().toISOString() });
}

// Run any "silent" states forward — when next() returns a new state that is silent,
// keep advancing until we hit a state that needs patient input OR a terminal state.
function _advance(session) {
  let safety = 0;
  while (safety++ < 12) {
    const stateDef = STATES[session.state];
    if (!stateDef) break;
    // Emit the agent's line
    const said = stateDef.prompt(session);
    _agentSay(session, said);
    if (stateDef.terminal) {
      session.completed = true;
      session.escalation = stateDef.escalation_reason || null;
      break;
    }
    if (stateDef.silent) {
      const nextState = stateDef.next(session);
      session.state = nextState;
      continue;
    }
    break; // needs patient response next
  }
  return session;
}

function startCall(callerPhone) {
  const session = createSession(callerPhone);
  _advance(session);
  return session;
}

function processTurn(session, patientResponse) {
  if (session.completed) return session;
  _patientSay(session, patientResponse.text || patientResponse.phone_number || JSON.stringify(patientResponse));
  const stateDef = STATES[session.state];
  if (!stateDef || !stateDef.next) return session;
  const nextState = stateDef.next(session, patientResponse);
  session.state = nextState;
  _advance(session);
  return session;
}

module.exports = { startCall, processTurn, STATES, REASON_TO_PROCEDURES };
