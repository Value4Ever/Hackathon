// lib/schedulerEngine.cjs — risk-aware outreach scheduler.
//
// Given a patient + their SPC risk analysis, build an outreach campaign:
//   - WHICH channels (SMS / call / email / voicemail)
//   - HOW MANY reminders (1 for low-risk, 3-4 for critical)
//   - WHEN (lead times tuned to risk)
//   - WHAT message (recall-due / pending-treatment / general scheduling)
//   - VOICE SCRIPT for the front desk (or for an IVR/voice agent)
//   - Optional Opus 4.8 personalization
//
// API:
//   buildCampaign(patient_record, spc_result, options) → campaign object
//   buildBatchCampaign(filter, options) → array of campaigns ranked by priority

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { analyzePatient, rankAllPatients } = require('./spcEngine.cjs');

const CLINIC_DB = path.join(__dirname, '..', 'clinic.db');

function _db() { return new Database(CLINIC_DB, { readonly: true }); }

// ── Outreach policy by risk band
const RISK_POLICY = {
  low: {
    cadence: [{ at: 'T-7d', channel: 'sms' }, { at: 'T-1d', channel: 'sms' }],
    deposit_required: false,
    confirmation_required: false,
    overbooking_acceptable: false,
    front_desk_priority: 'low',
  },
  moderate: {
    cadence: [{ at: 'T-7d', channel: 'sms' }, { at: 'T-2d', channel: 'sms' }, { at: 'T-2h', channel: 'sms' }],
    deposit_required: false,
    confirmation_required: true,
    overbooking_acceptable: false,
    front_desk_priority: 'medium',
  },
  high: {
    cadence: [{ at: 'T-10d', channel: 'call' }, { at: 'T-3d', channel: 'sms' }, { at: 'T-1d', channel: 'call' }, { at: 'T-2h', channel: 'sms' }],
    deposit_required: true,
    deposit_amount_pct: 25,
    confirmation_required: true,
    overbooking_acceptable: true,
    front_desk_priority: 'high',
  },
  critical: {
    cadence: [{ at: 'T-14d', channel: 'call' }, { at: 'T-7d', channel: 'sms' }, { at: 'T-3d', channel: 'call' }, { at: 'T-1d', channel: 'sms' }, { at: 'T-3h', channel: 'call' }],
    deposit_required: true,
    deposit_amount_pct: 50,
    confirmation_required: true,
    overbooking_acceptable: true,
    front_desk_priority: 'urgent',
    suggest_morning_slot: true,  // morning slots have lower no-show rates
    suggest_short_lead_time: true,  // schedule sooner to avoid intent decay
  },
};

// ── Templates per (channel, purpose, language)
const TEMPLATES = {
  // ── SMS templates ────────────────────────────────────────────────
  sms_recall_low: {
    en: 'Hi {first_name}, this is {clinic_name}. You\'re due for your cleaning — your last visit was {months_since_cleaning} months ago. Reply with a day that works (Mon–Sat) and we\'ll get you set.',
    es: 'Hola {first_name}, le habla {clinic_name}. Es hora de su limpieza dental — su última visita fue hace {months_since_cleaning} meses. Responda con un día que le funcione (Lun–Sáb).'
  },
  sms_recall_moderate: {
    en: 'Hi {first_name}, friendly reminder from {clinic_name} — your cleaning is overdue ({months_since_cleaning} months since last). We have openings next week. Reply with your preferred day + AM/PM and we\'ll lock it in.',
    es: 'Hola {first_name}, recordatorio de {clinic_name} — su limpieza está atrasada ({months_since_cleaning} meses). Tenemos turnos la próxima semana.'
  },
  sms_recall_high: {
    en: 'Hi {first_name}, this is {clinic_name}. Your cleaning is now {months_since_cleaning} months overdue. Because we\'ve had a few missed visits, we\'re asking for a $25 hold to confirm any new appointment — fully refundable when you arrive. Reply YES + a preferred day to schedule.',
    es: 'Hola {first_name}, le habla {clinic_name}. Su limpieza está {months_since_cleaning} meses atrasada. Por las últimas citas perdidas, pedimos $25 de depósito reembolsable al asistir. Responda SÍ + día preferido.'
  },
  sms_pending_tx: {
    en: 'Hi {first_name}, this is {clinic_name}. You have a pending treatment plan totaling ~${pending_value} we discussed in your last visit. Want to schedule that out? Reply with your top 2 days that work.',
    es: 'Hola {first_name}, hay un plan de tratamiento pendiente de ~${pending_value}. ¿Quiere agendar? Responda con sus 2 días preferidos.'
  },
  sms_confirm: {
    en: 'Hi {first_name}, confirming your {appt_type} appointment with {clinic_name} on {appt_date} at {appt_time}. Reply C to confirm, R to reschedule, X to cancel.',
    es: 'Hola {first_name}, confirmando su cita de {appt_type} en {clinic_name} el {appt_date} a las {appt_time}. Responda C para confirmar, R para reprogramar, X para cancelar.'
  },

  // ── Email templates ──────────────────────────────────────────────
  email_recall: {
    en: {
      subject: 'Time for your dental cleaning, {first_name}',
      body: 'Hi {first_name},\n\nWe noticed it has been {months_since_cleaning} months since your last cleaning at {clinic_name}. Most insurance plans cover two cleanings per year at 100% — yours included.\n\nWe have these openings next week:\n  - {slot_1}\n  - {slot_2}\n  - {slot_3}\n\nReply to this email with your pick, or call us at {clinic_phone}.\n\nWarmly,\n{clinic_name}'
    },
    es: {
      subject: 'Es hora de su limpieza dental, {first_name}',
      body: 'Hola {first_name},\n\nHan pasado {months_since_cleaning} meses desde su última limpieza en {clinic_name}.\n\nResponda con su día preferido o llámenos al {clinic_phone}.\n\nAtentamente,\n{clinic_name}'
    }
  },

  // ── Voice/call scripts ───────────────────────────────────────────
  call_recall_high: {
    en: [
      'Hi {first_name}, this is {agent_name} calling from {clinic_name}.',
      'I\'m reaching out because it has been {months_since_cleaning} months since your last cleaning — we want to make sure you\'re due in soon.',
      'I see we\'ve had to reschedule a few of your past appointments. To make sure we hold a spot just for you, we\'re asking for a $25 deposit that we apply to your bill the day of your visit.',
      'Could we schedule you for next week? I have Tuesday morning or Thursday afternoon — which works better?',
      'Great. To confirm: {appt_date} at {appt_time}. I will text you the deposit link right after this call. Talk soon.'
    ],
    es: [
      'Hola {first_name}, le habla {agent_name} de {clinic_name}.',
      'Le llamo porque han pasado {months_since_cleaning} meses desde su última limpieza.',
      'Como hemos tenido que reagendar algunas citas anteriores, pedimos un depósito de $25 que se aplica a su cuenta el día de la visita.',
      '¿Podríamos agendarle la próxima semana? Tengo martes en la mañana o jueves en la tarde — ¿cuál le funciona?'
    ]
  },
  call_recall_critical: {
    en: [
      'Hi {first_name}, this is {agent_name} from {clinic_name}.',
      'I want to check in personally — we have not seen you in {months_since_cleaning} months and we miss having you.',
      'I know life gets busy. Is there something specific that is making it hard to come in — timing, cost, anxiety about the visit? I want to help solve it.',
      '(Listen — note the answer)',
      'Here is what I can offer: a morning slot (those have worked best for our schedules historically), a $50 deposit to hold the spot (refundable on arrival), and we will personally text you the night before to confirm.',
      'Could we get you in next Tuesday or Wednesday morning?',
      'Great. {appt_date} at {appt_time}. I will send the deposit link now + a calendar invite. See you then.'
    ],
    es: [
      'Hola {first_name}, le habla {agent_name} de {clinic_name}.',
      'Quería ver cómo está — no le hemos visto en {months_since_cleaning} meses.',
      'Sé que la vida se ocupa. ¿Hay algo específico que dificulta venir — horario, costo, ansiedad por la visita?',
      '(Escuche)',
      'Le ofrezco: un turno en la mañana, un depósito de $50 reembolsable al asistir, y le confirmamos la noche anterior por mensaje.'
    ]
  },
  call_voicemail: {
    en: [
      'Hi {first_name}, this is {agent_name} at {clinic_name}.',
      'Just calling to check in — we noticed it has been {months_since_cleaning} months since your last cleaning.',
      'Give us a call back at {clinic_phone} when you have a moment, or text us at the same number. We will get you in this week.',
      'Thanks {first_name} — talk soon.'
    ]
  }
};

function _monthsSince(dateIso) {
  if (!dateIso) return null;
  const ms = Date.now() - new Date(dateIso).getTime();
  return Math.round(ms / (30.44 * 24 * 60 * 60 * 1000));
}
function _fmt(tpl, fields) {
  if (typeof tpl === 'string') {
    let out = tpl;
    for (const [k, v] of Object.entries(fields || {})) {
      out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
    return out;
  }
  if (Array.isArray(tpl)) return tpl.map(line => _fmt(line, fields));
  if (typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) out[k] = _fmt(v, fields);
    return out;
  }
  return tpl;
}
function _pickTemplate(name, lang) {
  const t = TEMPLATES[name];
  if (!t) return null;
  if (typeof t === 'string' || Array.isArray(t)) return t;
  return t[lang] || t.en || Object.values(t)[0];
}

function buildCampaign(patient, spcResult, options) {
  options = options || {};
  const clinicName = options.clinic_name || 'Bright Smile Dental';
  const clinicPhone = options.clinic_phone || '+1-415-555-0142';
  const agentName = options.agent_name || 'Maria';
  const lang = (patient.preferred_language === 'es') ? 'es' : 'en';
  const band = spcResult?.risk?.band || 'low';
  const policy = RISK_POLICY[band];
  const monthsSinceCleaning = _monthsSince(patient.last_cleaning_date);
  const recallDue = monthsSinceCleaning >= (patient.recall_interval_months || 6);
  const hasPendingTx = (patient.pending_treatment_value || 0) > 0;

  // Determine primary purpose
  const purpose = hasPendingTx ? 'pending_treatment'
                : recallDue ? 'recall_due'
                : 'general_check_in';

  // Build the touchpoint plan (which message goes on which channel + when)
  const fieldValues = {
    first_name: patient.first_name,
    clinic_name: clinicName,
    clinic_phone: clinicPhone,
    agent_name: agentName,
    months_since_cleaning: monthsSinceCleaning || '?',
    pending_value: (patient.pending_treatment_value || 0).toFixed(0),
    appt_date: '{TBD}', appt_time: '{TBD}', appt_type: 'cleaning',
    slot_1: 'Tuesday 9:00 AM', slot_2: 'Thursday 2:30 PM', slot_3: 'Saturday 10:00 AM'
  };

  const touchpoints = [];
  for (const step of policy.cadence) {
    const tp = { when: step.at, channel: step.channel };
    if (step.channel === 'sms') {
      const tplName = purpose === 'pending_treatment' ? 'sms_pending_tx'
                    : (band === 'low' ? 'sms_recall_low' : band === 'high' || band === 'critical' ? 'sms_recall_high' : 'sms_recall_moderate');
      tp.template_id = tplName;
      tp.body = _fmt(_pickTemplate(tplName, lang), fieldValues);
    } else if (step.channel === 'email') {
      tp.template_id = 'email_recall';
      const e = _fmt(_pickTemplate('email_recall', lang), fieldValues);
      tp.subject = e.subject; tp.body = e.body;
    } else if (step.channel === 'call') {
      const tplName = band === 'critical' ? 'call_recall_critical' : 'call_recall_high';
      tp.template_id = tplName;
      tp.script = _fmt(_pickTemplate(tplName, lang), fieldValues);
      tp.voicemail_fallback = _fmt(_pickTemplate('call_voicemail', lang), fieldValues);
    }
    touchpoints.push(tp);
  }

  // Honor opt-in flags — strip channels patient has opted out of
  const respected = touchpoints.filter(tp => {
    if (tp.channel === 'sms' && patient.sms_opt_in === 0) return false;
    if (tp.channel === 'email' && patient.email_opt_in === 0) return false;
    if ((tp.channel === 'call' || tp.channel === 'voicemail') && patient.phone_ok === 0) return false;
    return true;
  });

  // Compute priority score — used to rank in batch dashboard
  const priority =
    (spcResult?.risk?.score || 0) * 0.6 +
    (recallDue ? 0.2 : 0) +
    (hasPendingTx ? 0.15 : 0) +
    (monthsSinceCleaning && monthsSinceCleaning > 12 ? 0.05 : 0);

  return {
    campaign_id: 'CAMP-' + patient.patient_id + '-' + Date.now(),
    patient: {
      patient_id: patient.patient_id,
      name: patient.first_name + ' ' + patient.last_name,
      preferred_channel: patient.preferred_channel,
      preferred_language: patient.preferred_language,
      phone: patient.phone, email: patient.email
    },
    risk_band: band,
    risk_score: spcResult?.risk?.score || 0,
    risk_breakdown: spcResult?.risk?.breakdown || null,
    we_rules_triggered: spcResult?.we_rules_triggered?.length || 0,
    purpose,
    recall_due: recallDue,
    months_since_cleaning: monthsSinceCleaning,
    pending_treatment_value: patient.pending_treatment_value || 0,
    policy,
    touchpoints: respected,
    n_touchpoints_planned: respected.length,
    n_touchpoints_skipped_optout: touchpoints.length - respected.length,
    priority,
    created_at: new Date().toISOString()
  };
}

function buildBatchCampaign(opts) {
  // Iterates the patient ranking + builds campaigns for top N by risk + recall-due
  opts = opts || {};
  const max = opts.max || 100;
  const minRisk = opts.min_risk || 0;
  const rank = rankAllPatients();
  const db = _db();
  const campaigns = [];
  for (const r of rank) {
    if (r.risk_score < minRisk) continue;
    const patient = db.prepare('SELECT * FROM clinic_patients WHERE patient_id = ?').get(r.patient_id);
    if (!patient) continue;
    const spc = analyzePatient(r.patient_id);
    const camp = buildCampaign(patient, spc, opts);
    // Only include if there's a real reason to reach out
    if (camp.recall_due || camp.pending_treatment_value > 0 || camp.risk_band === 'critical') {
      campaigns.push(camp);
    }
    if (campaigns.length >= max) break;
  }
  db.close();
  // Sort by priority desc
  campaigns.sort((a, b) => b.priority - a.priority);
  return campaigns;
}

module.exports = { buildCampaign, buildBatchCampaign, RISK_POLICY, TEMPLATES };

// CLI
if (require.main === module) {
  const arg = process.argv[2];
  if (arg === '--batch') {
    const max = parseInt(process.argv[3] || '20', 10);
    const campaigns = buildBatchCampaign({ max });
    console.log('=== Batch outreach campaign ===');
    console.log('Total: ' + campaigns.length + ' campaigns generated');
    for (const c of campaigns.slice(0, 15)) {
      console.log('  [' + c.risk_band.padEnd(8) + '] ' + c.patient.name.padEnd(24) + ' priority=' + c.priority.toFixed(2) + '  ' + c.n_touchpoints_planned + ' touchpoints  purpose=' + c.purpose + '  monthsSince=' + c.months_since_cleaning);
    }
  } else if (arg) {
    const db = _db();
    const patient = db.prepare('SELECT * FROM clinic_patients WHERE patient_id = ?').get(arg);
    db.close();
    if (!patient) { console.error('Patient not found'); process.exit(1); }
    const spc = analyzePatient(arg);
    const camp = buildCampaign(patient, spc);
    console.log(JSON.stringify(camp, null, 2));
  } else {
    console.error('Usage: node lib/schedulerEngine.cjs <patient_id> | --batch [N]');
  }
}
