// generateClinicData.cjs — generate 1000 mock clinic patients with full history.
// Demographics + insurance + dental history + appointments + payments + communications
// + recall schedule + medical history + family + risk profile.
//
// Run: node generateClinicData.cjs
// Output: writes to clinic.db (separate from eligibility.db).

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'clinic.db');
const N_PATIENTS = 1000;
const SEED = 20260530;

// ── Seeded PRNG (mulberry32) for reproducibility
function makeRng(seed) {
  let t = seed;
  return function () {
    t |= 0; t = t + 0x6D2B79F5 | 0;
    let r = Math.imul(t ^ t >>> 15, 1 | t);
    r = r + Math.imul(r ^ r >>> 7, 61 | r) ^ r;
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}
const rng = makeRng(SEED);
const pick = (arr) => arr[Math.floor(rng() * arr.length)];
const pickWeighted = (arr) => {
  const total = arr.reduce((s, x) => s + x.w, 0);
  let r = rng() * total;
  for (const item of arr) { r -= item.w; if (r <= 0) return item.v; }
  return arr[arr.length - 1].v;
};
const between = (a, b) => a + rng() * (b - a);
const intBetween = (a, b) => Math.floor(between(a, b + 1));
const isoDate = (d) => d.toISOString().slice(0, 10);
const isoDt = (d) => d.toISOString();

const FIRST_NAMES = ['Marcus','Sofia','Priya','Liam','Gregory','Hannah','Tomas','Yusuf','Eleanor','Devon','Aiden','Mia','Noah','Olivia','Lucas','Emma','Ethan','Ava','Mason','Isabella','Logan','Charlotte','James','Amelia','Benjamin','Harper','Sebastian','Evelyn','Carter','Abigail','Jack','Emily','Henry','Elizabeth','William','Sofia','Daniel','Lily','Matthew','Avery','Joseph','Sofia','Samuel','Madison','David','Scarlett','Owen','Victoria','Wyatt','Aria','Theodore','Grace','Jayden','Chloe','Levi','Camila','Asher','Penelope','Julian','Riley','Maverick','Layla','Lincoln','Lillian','Anthony','Nora','Andrew','Zoey','Joshua','Mila','Christopher','Aubrey','Caleb','Hannah','Ryan','Lily','Hudson','Addison','Adrian','Eleanor','Aaron','Natalie','Jose','Luna','Eli','Savannah','Jonathan','Brooklyn','Dylan','Leah','Charles','Zoe','Christian','Stella','Adam','Hazel','Connor','Ellie','Robert','Paisley','Nathan','Audrey'];
const LAST_NAMES = ['Halloway','Renteria','Nandakumar','Okafor','Vasquez','Brinstol','Eklund','Demir','Whitcomb','Marsh','Chen','Garcia','Patel','Rodriguez','Kim','Singh','Martinez','Nguyen','Lee','Smith','Johnson','Williams','Brown','Jones','Miller','Davis','Wilson','Anderson','Taylor','Thomas','Moore','Jackson','White','Harris','Martin','Thompson','Robinson','Clark','Lewis','Walker','Hall','Allen','Young','Hernandez','King','Wright','Lopez','Hill','Scott','Green','Adams','Baker','Gonzalez','Nelson','Carter','Mitchell','Perez','Roberts','Turner','Phillips','Campbell','Parker','Evans','Edwards','Collins','Stewart','Sanchez','Morris','Rogers','Reed','Cook','Morgan','Bell','Murphy','Bailey','Rivera','Cooper','Richardson','Cox','Howard','Ward','Torres','Peterson','Gray','Ramirez','James','Watson','Brooks','Kelly','Sanders','Price','Bennett','Wood','Barnes','Ross','Henderson','Coleman','Jenkins','Perry','Powell','Long','Patterson','Hughes'];
const PAYER_IDS = ['DDCA','DDPA','METLIFE','AETNA','CIGNA','GUARDIAN','UCC','HUMANA','BCBS','UNITEDHEALTHCARE'];
const PLAN_TYPES = [{v:'PPO',w:70},{v:'DHMO',w:15},{v:'Indemnity',w:5},{v:'self_pay',w:10}];
const PREFERRED_CHANNEL = [{v:'sms',w:55},{v:'email',w:25},{v:'call',w:15},{v:'voicemail',w:5}];
const LANGUAGES = [{v:'en',w:75},{v:'es',w:18},{v:'zh',w:3},{v:'vi',w:2},{v:'ar',w:1},{v:'ru',w:1}];
const ALLERGIES_POOL = ['Penicillin','Latex','Lidocaine','Codeine','NSAIDs','Sulfa','Iodine','Aspirin','Erythromycin','None'];
const MEDS_POOL = ['Lisinopril','Atorvastatin','Metformin','Amlodipine','Levothyroxine','Albuterol','Sertraline','Omeprazole','Gabapentin','Hydrochlorothiazide','None'];
const CONDITIONS_POOL = ['Hypertension','Type 2 Diabetes','Asthma','GERD','Hypothyroid','Anxiety','Heart Disease','Osteoporosis','Pregnancy','None'];
const TREATMENTS_POOL = [
  {code:'D0120',desc:'Periodic oral evaluation',fee:95,cat:'diagnostic'},
  {code:'D0150',desc:'Comprehensive oral evaluation',fee:135,cat:'diagnostic'},
  {code:'D0210',desc:'X-rays — FMX',fee:165,cat:'diagnostic'},
  {code:'D0274',desc:'Bitewings — four films',fee:90,cat:'diagnostic'},
  {code:'D1110',desc:'Prophylaxis — adult',fee:130,cat:'preventive'},
  {code:'D1120',desc:'Prophylaxis — child',fee:90,cat:'preventive'},
  {code:'D1206',desc:'Topical fluoride',fee:50,cat:'preventive'},
  {code:'D2391',desc:'Composite — 1 surface',fee:250,cat:'basic'},
  {code:'D2392',desc:'Composite — 2 surface',fee:325,cat:'basic'},
  {code:'D2740',desc:'Crown — porcelain/ceramic',fee:1300,cat:'major'},
  {code:'D2750',desc:'Crown — porcelain fused to metal',fee:1200,cat:'major'},
  {code:'D3310',desc:'Root canal — anterior',fee:850,cat:'major'},
  {code:'D3330',desc:'Root canal — molar',fee:1250,cat:'major'},
  {code:'D4341',desc:'Periodontal scaling — quadrant',fee:265,cat:'basic'},
  {code:'D6240',desc:'Pontic — PFM',fee:1100,cat:'major'},
  {code:'D6750',desc:'Retainer crown — PFM',fee:1100,cat:'major'},
  {code:'D7140',desc:'Extraction — erupted',fee:215,cat:'basic'},
  {code:'D7210',desc:'Surgical extraction',fee:325,cat:'major'},
  {code:'D8080',desc:'Comprehensive ortho',fee:5500,cat:'ortho'},
];
const APPT_TYPES = ['hygiene','exam','filling','crown_prep','crown_seat','root_canal','extraction','consult','ortho_adjust','emergency'];
const PAYMENT_METHODS = ['credit_card','cash','check','HSA','financing','insurance'];
const CITIES = ['San Francisco','Oakland','Berkeley','San Jose','Palo Alto','Mountain View','Sunnyvale','Fremont','Hayward','Daly City'];

// Risk archetypes — drives appointment + payment + outreach behavior
const RISK_ARCHETYPES = [
  { name:'reliable',  w:40, noShowBase:0.03, ledgerCleanProb:0.95, recallCompliance:0.95, lateProb:0.05 },
  { name:'moderate',  w:30, noShowBase:0.15, ledgerCleanProb:0.80, recallCompliance:0.70, lateProb:0.20 },
  { name:'problem',   w:20, noShowBase:0.35, ledgerCleanProb:0.55, recallCompliance:0.40, lateProb:0.40 },
  { name:'chronic',   w:10, noShowBase:0.60, ledgerCleanProb:0.30, recallCompliance:0.20, lateProb:0.55 },
];

function genPatient(idx) {
  const archetype = pickWeighted(RISK_ARCHETYPES.map(a => ({v:a, w:a.w})));
  const firstName = pick(FIRST_NAMES);
  const lastName = pick(LAST_NAMES);
  const ageBucket = pickWeighted([{v:'child',w:15},{v:'young_adult',w:25},{v:'adult',w:40},{v:'senior',w:20}]);
  let dobYear;
  if (ageBucket === 'child') dobYear = 2026 - intBetween(3, 17);
  else if (ageBucket === 'young_adult') dobYear = 2026 - intBetween(18, 34);
  else if (ageBucket === 'adult') dobYear = 2026 - intBetween(35, 64);
  else dobYear = 2026 - intBetween(65, 89);
  const dobMonth = intBetween(1, 12).toString().padStart(2, '0');
  const dobDay = intBetween(1, 28).toString().padStart(2, '0');
  const dob = dobYear + '-' + dobMonth + '-' + dobDay;
  const age = 2026 - dobYear;
  const id = 'CP-' + String(idx).padStart(5, '0');
  const memberId = ['DDX','MET','AET','CIG','GRD','UCC','HUM','BCB','UHC'][intBetween(0, 8)] + intBetween(100000000, 999999999);
  const planType = pickWeighted(PLAN_TYPES);
  const payerId = planType === 'self_pay' ? null : pick(PAYER_IDS);
  const language = pickWeighted(LANGUAGES);
  const channel = pickWeighted(PREFERRED_CHANNEL);
  const phoneOk = rng() > 0.05;
  const emailOk = rng() > 0.12;
  const smsOk = rng() > 0.08;
  const firstVisitYearsAgo = intBetween(0, 12);
  const firstVisit = new Date(Date.now() - firstVisitYearsAgo * 365 * 24 * 60 * 60 * 1000);

  return {
    patient_id: id,
    first_name: firstName,
    last_name: lastName,
    date_of_birth: dob,
    age,
    gender: pick(['M','F','NB','prefer_not_to_say']),
    address: intBetween(100, 9999) + ' ' + pick(['Maple','Oak','Pine','Elm','Cedar','Willow','Spruce','Hickory','Sycamore','Aspen']) + ' ' + pick(['St','Ave','Ln','Dr','Blvd','Way','Ct','Pl']),
    city: pick(CITIES),
    state: 'CA',
    zip: String(intBetween(94000, 95999)),
    phone: '+1' + intBetween(2000000000, 9999999999),
    email: (firstName + '.' + lastName + intBetween(1, 99) + '@' + pick(['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com'])).toLowerCase(),
    emergency_contact_name: pick(FIRST_NAMES) + ' ' + lastName,
    emergency_contact_phone: '+1' + intBetween(2000000000, 9999999999),
    preferred_language: language,
    preferred_channel: channel,
    sms_opt_in: smsOk,
    email_opt_in: emailOk,
    phone_ok: phoneOk,
    member_id: memberId,
    payer_id: payerId,
    plan_type: planType,
    first_visit_date: isoDate(firstVisit),
    risk_archetype: archetype.name,
    risk_noshow_base: archetype.noShowBase,
    risk_ledger_clean_prob: archetype.ledgerCleanProb,
    risk_recall_compliance: archetype.recallCompliance,
    risk_late_prob: archetype.lateProb,
    family_id: rng() < 0.35 ? 'FAM-' + intBetween(1, 400) : null,
    // Medical
    allergies: JSON.stringify(Array.from(new Set(Array.from({length: intBetween(0, 3)}, () => pick(ALLERGIES_POOL)))).filter(a => a !== 'None').slice(0, 3)),
    medications: JSON.stringify(Array.from(new Set(Array.from({length: intBetween(0, 4)}, () => pick(MEDS_POOL)))).filter(m => m !== 'None').slice(0, 4)),
    medical_conditions: JSON.stringify(Array.from(new Set(Array.from({length: intBetween(0, 3)}, () => pick(CONDITIONS_POOL)))).filter(c => c !== 'None').slice(0, 3)),
    // Caries + perio risk (independent of no-show risk)
    caries_risk: pickWeighted([{v:'low',w:50},{v:'medium',w:35},{v:'high',w:15}]),
    perio_risk: pickWeighted([{v:'low',w:55},{v:'medium',w:30},{v:'high',w:15}]),
    // Recall
    last_cleaning_date: isoDate(new Date(Date.now() - intBetween(60, 600) * 24 * 60 * 60 * 1000)),
    recall_interval_months: pick([3, 4, 6, 6, 6, 6, 9, 12]),
    // Pending treatment plan
    pending_treatment_value: rng() < 0.4 ? Math.round(between(200, 5500)) : 0,
    pending_treatment_acceptance_date: null,
  };
}

function genAppointments(patient) {
  const yearsActive = Math.max(1, 2026 - new Date(patient.first_visit_date).getFullYear());
  const totalAppts = intBetween(Math.max(2, yearsActive * 2), yearsActive * 6);
  const appts = [];
  const startDate = new Date(patient.first_visit_date).getTime();
  const endDate = Date.now() + 90 * 24 * 60 * 60 * 1000; // include up to 3 months future
  for (let i = 0; i < totalAppts; i++) {
    const scheduledAt = new Date(startDate + (rng() * (endDate - startDate)));
    // Outcome derives from risk archetype + small variability
    const noShowProb = patient.risk_noshow_base * (0.7 + rng() * 0.6);
    const cancelProb = noShowProb * 0.5; // some no-shows would have been cancellations with notice
    const lateProb = patient.risk_late_prob * (0.8 + rng() * 0.4);
    const r = rng();
    let outcome;
    if (scheduledAt > new Date()) outcome = 'scheduled';
    else if (r < noShowProb) outcome = 'no_show';
    else if (r < noShowProb + cancelProb) outcome = rng() < 0.5 ? 'cancelled_same_day' : 'cancelled_in_advance';
    else if (rng() < lateProb) outcome = 'kept_late';
    else outcome = 'kept';
    const apptType = pick(APPT_TYPES);
    const apptValue = apptType === 'crown_prep' || apptType === 'crown_seat' ? intBetween(800, 1400)
                    : apptType === 'root_canal' ? intBetween(700, 1300)
                    : apptType === 'extraction' ? intBetween(200, 450)
                    : apptType === 'ortho_adjust' ? intBetween(100, 200)
                    : apptType === 'emergency' ? intBetween(150, 800)
                    : intBetween(95, 250);
    appts.push({
      patient_id: patient.patient_id,
      appt_id: 'APT-' + patient.patient_id.slice(3) + '-' + String(i).padStart(3, '0'),
      scheduled_at: isoDt(scheduledAt),
      appt_type: apptType,
      provider_id: 'DDS-' + intBetween(1, 5),
      outcome,
      duration_min: pick([30, 30, 45, 60, 60, 90, 120]),
      planned_value: apptValue,
      reminder_sent_24h: rng() < 0.7,
      reminder_sent_2h: rng() < 0.4,
      confirmation_received: outcome === 'kept' || outcome === 'kept_late' ? rng() < 0.6 : rng() < 0.2,
      cancel_lead_time_hours: outcome === 'cancelled_in_advance' ? intBetween(24, 168) : (outcome === 'cancelled_same_day' ? intBetween(0, 12) : null),
      no_show_followup_completed: outcome === 'no_show' ? rng() < 0.45 : null,
      notes: null,
    });
  }
  return appts.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
}

function genTreatments(patient, appointments) {
  const treatments = [];
  for (const a of appointments) {
    if (a.outcome !== 'kept' && a.outcome !== 'kept_late') continue;
    // Randomly tie 1-3 procedures to this kept appointment
    const n = intBetween(1, 3);
    for (let i = 0; i < n; i++) {
      const t = pick(TREATMENTS_POOL);
      treatments.push({
        patient_id: patient.patient_id,
        treatment_id: 'TX-' + patient.patient_id.slice(3) + '-' + a.appt_id.split('-')[2] + '-' + i,
        appt_id: a.appt_id,
        ada_code: t.code,
        description: t.desc,
        category: t.cat,
        tooth_number: t.cat === 'basic' || t.cat === 'major' ? intBetween(1, 32) : null,
        surface: t.cat === 'basic' && t.code.startsWith('D23') ? pick(['M','O','D','MO','OD','MOD']) : null,
        billed_amount: t.fee * (0.85 + rng() * 0.3),
        provider_id: a.provider_id,
        treated_at: a.scheduled_at,
        status: 'completed'
      });
    }
  }
  return treatments;
}

function genPayments(patient, treatments) {
  const payments = [];
  let runningBalance = 0;
  for (const t of treatments) {
    const billed = t.billed_amount;
    // Insurance pays a portion if not self-pay
    const insurancePct = patient.plan_type === 'self_pay' ? 0 : (t.category === 'preventive' || t.category === 'diagnostic' ? 100 : (t.category === 'basic' ? 80 : (t.category === 'major' ? 50 : 0)));
    const insurancePaid = billed * (insurancePct / 100);
    const patientResponsibility = billed - insurancePaid;
    runningBalance += patientResponsibility;
    // Payment behavior tied to ledger_clean_prob
    const paysPromptly = rng() < patient.risk_ledger_clean_prob;
    const daysToPayment = paysPromptly ? intBetween(0, 30) : intBetween(45, 365);
    const treatedAt = new Date(t.treated_at);
    const paidAt = new Date(treatedAt.getTime() + daysToPayment * 24 * 60 * 60 * 1000);
    const isFutureUnpaid = paidAt > new Date();
    if (insurancePaid > 0) {
      payments.push({
        patient_id: patient.patient_id,
        payment_id: 'PAY-' + t.treatment_id + '-INS',
        treatment_id: t.treatment_id,
        amount: Math.round(insurancePaid * 100) / 100,
        method: 'insurance',
        paid_at: t.treated_at,
        status: 'posted',
        days_to_pay: null,
      });
    }
    if (patientResponsibility > 0.01) {
      payments.push({
        patient_id: patient.patient_id,
        payment_id: 'PAY-' + t.treatment_id + '-PT',
        treatment_id: t.treatment_id,
        amount: Math.round(patientResponsibility * 100) / 100,
        method: paysPromptly ? pick(PAYMENT_METHODS.filter(m => m !== 'insurance')) : 'financing',
        paid_at: isFutureUnpaid ? null : isoDt(paidAt),
        status: isFutureUnpaid ? 'outstanding' : 'posted',
        days_to_pay: isFutureUnpaid ? null : daysToPayment
      });
    }
  }
  return payments;
}

function genCommunications(patient, appointments) {
  // Build a communications log linked to appointment reminders + outreach
  const comms = [];
  for (const a of appointments) {
    if (a.reminder_sent_24h) {
      comms.push({
        patient_id: patient.patient_id,
        comm_id: 'COM-' + a.appt_id + '-R24',
        appt_id: a.appt_id,
        channel: patient.preferred_channel,
        direction: 'outbound',
        purpose: 'appt_reminder_24h',
        sent_at: isoDt(new Date(new Date(a.scheduled_at).getTime() - 24 * 60 * 60 * 1000)),
        delivered: rng() < 0.92,
        opened: rng() < (patient.preferred_channel === 'email' ? 0.55 : 0.85),
        responded: rng() < (a.confirmation_received ? 0.7 : 0.1),
        status: 'completed'
      });
    }
    if (a.reminder_sent_2h) {
      comms.push({
        patient_id: patient.patient_id,
        comm_id: 'COM-' + a.appt_id + '-R02',
        appt_id: a.appt_id,
        channel: 'sms',
        direction: 'outbound',
        purpose: 'appt_reminder_2h',
        sent_at: isoDt(new Date(new Date(a.scheduled_at).getTime() - 2 * 60 * 60 * 1000)),
        delivered: rng() < 0.95,
        opened: rng() < 0.88,
        responded: rng() < (a.confirmation_received ? 0.6 : 0.08),
        status: 'completed'
      });
    }
    if (a.outcome === 'no_show' && a.no_show_followup_completed) {
      comms.push({
        patient_id: patient.patient_id,
        comm_id: 'COM-' + a.appt_id + '-NS',
        appt_id: a.appt_id,
        channel: pick(['call','sms']),
        direction: 'outbound',
        purpose: 'no_show_followup',
        sent_at: isoDt(new Date(new Date(a.scheduled_at).getTime() + intBetween(1, 5) * 24 * 60 * 60 * 1000)),
        delivered: rng() < 0.85,
        opened: rng() < 0.5,
        responded: rng() < 0.3,
        status: 'completed'
      });
    }
  }
  return comms;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clinic_patients (
      patient_id TEXT PRIMARY KEY,
      first_name TEXT, last_name TEXT, date_of_birth TEXT, age INTEGER, gender TEXT,
      address TEXT, city TEXT, state TEXT, zip TEXT, phone TEXT, email TEXT,
      emergency_contact_name TEXT, emergency_contact_phone TEXT,
      preferred_language TEXT, preferred_channel TEXT,
      sms_opt_in INTEGER, email_opt_in INTEGER, phone_ok INTEGER,
      member_id TEXT, payer_id TEXT, plan_type TEXT,
      first_visit_date TEXT,
      risk_archetype TEXT, risk_noshow_base REAL, risk_ledger_clean_prob REAL,
      risk_recall_compliance REAL, risk_late_prob REAL,
      family_id TEXT,
      allergies TEXT, medications TEXT, medical_conditions TEXT,
      caries_risk TEXT, perio_risk TEXT,
      last_cleaning_date TEXT, recall_interval_months INTEGER,
      pending_treatment_value REAL, pending_treatment_acceptance_date TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cp_lname ON clinic_patients(last_name);
    CREATE INDEX IF NOT EXISTS idx_cp_risk ON clinic_patients(risk_archetype);
    CREATE INDEX IF NOT EXISTS idx_cp_family ON clinic_patients(family_id);

    CREATE TABLE IF NOT EXISTS appointments (
      appt_id TEXT PRIMARY KEY,
      patient_id TEXT NOT NULL,
      scheduled_at TEXT NOT NULL,
      appt_type TEXT,
      provider_id TEXT,
      outcome TEXT,
      duration_min INTEGER,
      planned_value REAL,
      reminder_sent_24h INTEGER,
      reminder_sent_2h INTEGER,
      confirmation_received INTEGER,
      cancel_lead_time_hours INTEGER,
      no_show_followup_completed INTEGER,
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_appt_pid ON appointments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_appt_outcome ON appointments(outcome);
    CREATE INDEX IF NOT EXISTS idx_appt_sched ON appointments(scheduled_at);

    CREATE TABLE IF NOT EXISTS treatments (
      treatment_id TEXT PRIMARY KEY,
      patient_id TEXT, appt_id TEXT,
      ada_code TEXT, description TEXT, category TEXT,
      tooth_number INTEGER, surface TEXT,
      billed_amount REAL, provider_id TEXT,
      treated_at TEXT, status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_pid ON treatments(patient_id);

    CREATE TABLE IF NOT EXISTS payments (
      payment_id TEXT PRIMARY KEY,
      patient_id TEXT, treatment_id TEXT,
      amount REAL, method TEXT,
      paid_at TEXT, status TEXT, days_to_pay INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pay_pid ON payments(patient_id);
    CREATE INDEX IF NOT EXISTS idx_pay_status ON payments(status);

    CREATE TABLE IF NOT EXISTS communications (
      comm_id TEXT PRIMARY KEY,
      patient_id TEXT, appt_id TEXT,
      channel TEXT, direction TEXT, purpose TEXT,
      sent_at TEXT, delivered INTEGER, opened INTEGER, responded INTEGER,
      status TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_com_pid ON communications(patient_id);

    CREATE TABLE IF NOT EXISTS outreach_campaigns (
      campaign_id TEXT PRIMARY KEY,
      created_at TEXT,
      patient_id TEXT,
      channel TEXT,
      message_type TEXT,
      payload_json TEXT,
      sent_at TEXT,
      status TEXT
    );
  `);
}

function main() {
  if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  initSchema(db);

  const insPatient = db.prepare(`INSERT INTO clinic_patients VALUES (
    @patient_id,@first_name,@last_name,@date_of_birth,@age,@gender,
    @address,@city,@state,@zip,@phone,@email,
    @emergency_contact_name,@emergency_contact_phone,
    @preferred_language,@preferred_channel,
    @sms_opt_in,@email_opt_in,@phone_ok,
    @member_id,@payer_id,@plan_type,@first_visit_date,
    @risk_archetype,@risk_noshow_base,@risk_ledger_clean_prob,@risk_recall_compliance,@risk_late_prob,
    @family_id,
    @allergies,@medications,@medical_conditions,@caries_risk,@perio_risk,
    @last_cleaning_date,@recall_interval_months,
    @pending_treatment_value,@pending_treatment_acceptance_date
  )`);
  const insAppt = db.prepare(`INSERT INTO appointments VALUES (@appt_id,@patient_id,@scheduled_at,@appt_type,@provider_id,@outcome,@duration_min,@planned_value,@reminder_sent_24h,@reminder_sent_2h,@confirmation_received,@cancel_lead_time_hours,@no_show_followup_completed,@notes)`);
  const insTx = db.prepare(`INSERT INTO treatments VALUES (@treatment_id,@patient_id,@appt_id,@ada_code,@description,@category,@tooth_number,@surface,@billed_amount,@provider_id,@treated_at,@status)`);
  const insPay = db.prepare(`INSERT INTO payments VALUES (@payment_id,@patient_id,@treatment_id,@amount,@method,@paid_at,@status,@days_to_pay)`);
  const insCom = db.prepare(`INSERT INTO communications VALUES (@comm_id,@patient_id,@appt_id,@channel,@direction,@purpose,@sent_at,@delivered,@opened,@responded,@status)`);

  let totalAppts = 0, totalTx = 0, totalPay = 0, totalCom = 0;
  const startTime = Date.now();
  const txAll = db.transaction(() => {
    for (let i = 1; i <= N_PATIENTS; i++) {
      const p = genPatient(i);
      // Normalize booleans to 0/1 for SQLite
      ['sms_opt_in','email_opt_in','phone_ok'].forEach(k => { p[k] = p[k] ? 1 : 0; });
      insPatient.run(p);
      const appts = genAppointments(p);
      for (const a of appts) {
        ['reminder_sent_24h','reminder_sent_2h','confirmation_received','no_show_followup_completed'].forEach(k => { a[k] = a[k] === null ? null : (a[k] ? 1 : 0); });
        insAppt.run(a);
      }
      totalAppts += appts.length;
      const tx = genTreatments(p, appts);
      for (const t of tx) insTx.run(t);
      totalTx += tx.length;
      const pay = genPayments(p, tx);
      for (const py of pay) insPay.run(py);
      totalPay += pay.length;
      const com = genCommunications(p, appts);
      for (const c of com) {
        ['delivered','opened','responded'].forEach(k => { c[k] = c[k] === null ? null : (c[k] ? 1 : 0); });
        insCom.run(c);
      }
      totalCom += com.length;
    }
  });
  txAll();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  db.close();

  console.log('═══ Mock clinic database generated ═══');
  console.log('  patients:        ' + N_PATIENTS);
  console.log('  appointments:    ' + totalAppts);
  console.log('  treatments:      ' + totalTx);
  console.log('  payments:        ' + totalPay);
  console.log('  communications:  ' + totalCom);
  console.log('  db: ' + DB_PATH);
  console.log('  elapsed: ' + elapsed + 's');
}

if (require.main === module) main();

module.exports = { DB_PATH, N_PATIENTS };
