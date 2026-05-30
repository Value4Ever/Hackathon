// lib/demoRunner.cjs — end-to-end demo of the entire app.
//
// Plays a scripted 18-step timeline that exercises:
//   - Outbound morning campaign for critical-risk patients
//   - Voice call attempt → voicemail → SMS follow-up
//   - WhatsApp updates to staff group + doctor + patient
//   - Inbound patient call → multi-agent orchestrator
//   - Insurance verification with retry loop on failure
//   - Cost estimate built from real coverage data
//   - Risk-aware scheduling with deposit policy
//   - Patient confirmation SMS + deposit link
//   - Exception flow with human-in-the-loop WhatsApp escalation
//   - End-of-shift summary to office manager
//
// Real engine calls drive every decision (verifyEngine, schedulerEngine,
// spcEngine, agentOrchestrator). Voice/SMS/WhatsApp are mocked at the
// messagingChannels boundary — swap to Twilio + Meta in production.

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const { send, sendToPatient, sendToStaff, sendToDoctor } = require('./messagingChannels.cjs');
const { analyzePatient, rankAllPatients } = require('./spcEngine.cjs');
const { buildCampaign, buildBatchCampaign } = require('./schedulerEngine.cjs');
const { startCall, processTurn } = require('./agentOrchestrator.cjs');
const { verifyTreatmentPlan } = require('../verifyEngine.cjs');
const { classifyVerifyExceptions } = require('../exceptionRouter.cjs');

const CLINIC_DB = path.join(__dirname, '..', 'clinic.db');
const ELIG_DB = path.join(__dirname, '..', 'eligibility.db');

const STAFF_GROUP = '+15552223333';   // mock WhatsApp group number for staff
const DOCTOR_PHONE = '+15551112222';   // Dr. Chen's WhatsApp
const OFFICE_MGR_PHONE = '+15553334444'; // Office manager
const CLINIC_NAME = 'Bright Smile Dental';

// ── Step builder — returns the full timeline (NOT executed yet)
function buildScript(options) {
  options = options || {};
  const cdb = new Database(CLINIC_DB, { readonly: true });
  const edb = new Database(ELIG_DB, { readonly: true });

  // Pick a chronic-risk patient who exists in BOTH databases (for full flow)
  // For our demo we'll synthesize: clinic patient + mapped eligibility record
  const criticalPatients = cdb.prepare("SELECT * FROM clinic_patients WHERE risk_archetype IN ('chronic','problem') ORDER BY risk_archetype DESC LIMIT 10").all();
  const callPatient = criticalPatients[0]; // outbound call target
  const inboundPatient = criticalPatients[1]; // inbound call simulation (different patient)
  const declinedPatient = criticalPatients[2]; // patient who escalates

  // Reference eligibility records (10 mock vendor patients available)
  const eligPatients = edb.prepare('SELECT record_json FROM patients').all().map(r => JSON.parse(r.record_json));
  const activePatient = eligPatients.find(p => p.coverage.status === 'active' && p.coverage.in_network);
  const terminatedPatient = eligPatients.find(p => p.coverage.status === 'terminated');

  cdb.close();
  edb.close();

  return [
    // ───────────────────────── MORNING SETUP ─────────────────────────
    { step: 1, time_offset_ms: 0, scene: '08:30 — Morning Setup',
      title: 'Maria opens the front-desk hub',
      description: 'Hub shows 170 critical-risk patients, 17% no-show rate clinic-wide. Maria reviews the morning workflow.',
      action: null, // visual only
      ui_event: { type: 'scene_change', scene: 'hub' }
    },
    { step: 2, time_offset_ms: 2000, scene: '08:32 — Batch Campaign',
      title: 'Run morning outreach batch',
      description: 'Top-20 critical/high-risk patients selected by SPC engine. 47 touchpoints planned across SMS + voice.',
      action: () => {
        const campaigns = buildBatchCampaign({ max: 20 });
        const tps = campaigns.reduce((s, c) => s + c.n_touchpoints_planned, 0);
        return { campaigns_built: campaigns.length, touchpoints: tps, top_3: campaigns.slice(0,3).map(c => c.patient.name) };
      }
    },
    { step: 3, time_offset_ms: 3500, scene: '08:33 — Staff Notification',
      title: 'WhatsApp to staff group',
      description: 'Notify the team that the morning campaign is rolling out.',
      action: () => sendToStaff('whatsapp', STAFF_GROUP,
        '🌅 Morning campaign rolling out: 20 patients, 47 touchpoints. Critical-risk patients getting personal voice calls first. ETA 90 min.',
        { purpose: 'staff_briefing', campaign_id: 'CAMP-' + Date.now() }
      )
    },

    // ───────────────────────── OUTBOUND CALL ATTEMPT ─────────────────────────
    { step: 4, time_offset_ms: 5000, scene: '08:34 — Outbound Voice Call',
      title: 'Voice call attempt: ' + callPatient.first_name + ' ' + callPatient.last_name,
      description: 'Critical-risk patient (' + callPatient.risk_archetype + '), last cleaning ' + callPatient.last_cleaning_date + '. Outbound voice with empathy script.',
      action: () => sendToPatient(callPatient, 'voice',
        'Hi ' + callPatient.first_name + ', this is Maria from ' + CLINIC_NAME + '. I want to check in personally — we have not seen you in over a year. I know life gets busy. Could you give me a call back at +1-415-555-0142? Talk soon.',
        { purpose: 'outbound_recall_call', from: '+14155550142' }
      )
    },
    { step: 5, time_offset_ms: 7000, scene: '08:35 — Voicemail + SMS Follow-up',
      title: 'No answer → voicemail + SMS',
      description: 'Voice call goes to voicemail. Immediately follow up with SMS so the patient has both touchpoints.',
      action: () => sendToPatient(callPatient, 'sms',
        'Hi ' + callPatient.first_name + ', this is ' + CLINIC_NAME + '. We left a voicemail — your cleaning is overdue. Reply with a day next week that works (Mon-Sat) and we will get you scheduled. We will hold a $25 deposit (refundable on arrival) to confirm.',
        { purpose: 'outbound_recall_sms_followup' }
      )
    },
    { step: 6, time_offset_ms: 9000, scene: '08:36 — Live Response Tracking',
      title: 'WhatsApp to staff: 4 patients already responded',
      description: 'Early responses come in. Staff group sees live progress.',
      action: () => sendToStaff('whatsapp', STAFF_GROUP,
        '🎯 4 patients responded in 6 min. 2 ready to schedule, 1 declined (cost), 1 needs callback.',
        { purpose: 'campaign_progress' }
      )
    },

    // ───────────────────────── INBOUND CALL FLOW ─────────────────────────
    { step: 7, time_offset_ms: 11000, scene: '09:15 — Inbound Call',
      title: 'Inbound call from ' + inboundPatient.first_name + ' ' + inboundPatient.last_name,
      description: 'Phone rings. Intake Agent answers. PMS lookup by phone finds existing patient → skip new-patient intake.',
      action: () => {
        const session = startCall(inboundPatient.phone);
        return { session_id: session.session_id, agent: 'intake_agent', triage_result: session.patient_status, transcript: session.transcript.slice(-1) };
      },
      stores: 'inbound_session'
    },
    { step: 8, time_offset_ms: 13000, scene: '09:16 — Reason for Visit',
      title: 'Patient: "I think I need a filling"',
      description: 'Intake Agent maps the spoken reason to ADA codes (D0120 + D2391). Hands off to Insurance Agent.',
      action: (state) => {
        // Pretend the orchestrator's existing-patient PMS record links to the active mock eligibility patient
        const session = state.inbound_session;
        // Substitute the PMS record's session_data so the insurance verification hits a mock vendor patient
        session.session_data.member_id = activePatient.patient.member_id;
        session.session_data.first_name = activePatient.patient.first_name;
        session.session_data.last_name = activePatient.patient.last_name;
        session.session_data.date_of_birth = activePatient.patient.date_of_birth;
        session.session_data.preferred_channel = inboundPatient.preferred_channel;
        const updated = processTurn(session, { text: 'filling' });
        return { state: updated.state, transcript: updated.transcript.slice(-3) };
      }
    },
    { step: 9, time_offset_ms: 15500, scene: '09:17 — Verification Loop Attempt 1',
      title: 'Insurance Agent: 270 request to ' + (activePatient.payer.name || 'carrier'),
      description: 'First attempt at electronic eligibility query. If the carrier API times out, we retry.',
      action: () => ({ attempt: 1, method: '270_electronic', carrier: activePatient.payer.name, status: 'timeout' })
    },
    { step: 10, time_offset_ms: 17000, scene: '09:17 — Verification Loop Attempt 2',
      title: 'Retry with web-scrape fallback',
      description: 'Per the whiteboard "API call OR Staff call" — auto-retry with web-portal scrape on timeout.',
      action: () => {
        const verify = verifyTreatmentPlan(activePatient, [
          { ada_code: 'D0120', fee: 95 }, { ada_code: 'D2391', fee: 250 }
        ]);
        verify.exceptions = classifyVerifyExceptions(verify);
        return {
          attempt: 2, method: 'web_portal_scrape', status: 'success',
          coverage: verify.coverage_status,
          totals: verify.totals,
          exceptions: verify.exceptions.length
        };
      },
      stores: 'verify_result'
    },
    { step: 11, time_offset_ms: 19000, scene: '09:18 — Cost Estimate Spoken to Patient',
      title: 'Cost Estimate Agent reads the breakdown',
      description: 'Patient hears: "Good news — your cleaning is covered 100%, and the filling: insurance pays $X, you pay $Y."',
      action: (state) => {
        const v = state.verify_result;
        const oop = v.totals.patient_pays.toFixed(2);
        const ins = v.totals.carrier_pays.toFixed(2);
        return {
          spoken: 'Good news — your cleaning is covered 100%. For the filling, your insurance pays $' + ins + ' and you pay $' + oop + ' (after your $50 deductible).',
          insurance_pays: ins, patient_pays: oop
        };
      }
    },
    { step: 12, time_offset_ms: 21000, scene: '09:20 — Scheduling Proposal',
      title: 'Scheduling Agent proposes slot · SPC risk-aware policy',
      description: 'Critical-risk patient → morning slot + 50% deposit requirement. Patient says "Tuesday morning works."',
      action: () => {
        const spc = analyzePatient(inboundPatient.patient_id);
        const camp = buildCampaign(inboundPatient, spc);
        return {
          risk_band: camp.risk_band,
          policy: camp.policy.front_desk_priority,
          deposit_pct: camp.policy.deposit_amount_pct || 0,
          proposed_slot: 'Tuesday 9:00 AM',
          patient_response: 'Tuesday morning works'
        };
      }
    },
    { step: 13, time_offset_ms: 23000, scene: '09:21 — Patient Confirmation SMS',
      title: 'Confirmation SMS sent',
      description: 'Patient gets text with appt details, cost estimate, deposit link, reply-to-confirm options.',
      action: (state) => {
        const v = state.verify_result;
        const oop = v.totals.patient_pays.toFixed(2);
        return sendToPatient(inboundPatient, 'sms',
          'Confirming your filling appointment at ' + CLINIC_NAME + ' for Tuesday 9:00 AM. Estimated out-of-pocket: $' + oop + ' (insurance pays $' + v.totals.carrier_pays.toFixed(2) + '). $50 deposit link: stripe.test/d/abc123. Reply C to confirm, R to reschedule.',
          { purpose: 'appointment_confirmation' }
        );
      }
    },
    { step: 14, time_offset_ms: 24500, scene: '09:21 — WhatsApp to Doctor',
      title: 'Dr. Chen notified of next appointment',
      description: 'Doctor sees who is on schedule for Tuesday morning + key clinical context (pending tx, medical history flags).',
      action: () => sendToDoctor('whatsapp', DOCTOR_PHONE,
        '📋 New booking: ' + inboundPatient.first_name + ' ' + inboundPatient.last_name + ' — Tue 9:00 AM — D0120 + D2391. SPC risk: critical (' + inboundPatient.risk_archetype + '). Medical: ' + (JSON.parse(inboundPatient.allergies || '[]').join(', ') || 'no allergies on file') + '. Pending tx value $' + inboundPatient.pending_treatment_value + '.',
        { purpose: 'doctor_briefing' }
      )
    },
    { step: 15, time_offset_ms: 26000, scene: '09:22 — Patient WhatsApp Confirmation',
      title: 'WhatsApp follow-up to patient (preferred channel)',
      description: 'Patient prefers WhatsApp — confirmation + map + insurance card upload link sent.',
      action: () => sendToPatient(inboundPatient, 'whatsapp',
        '✓ Confirmed! Tuesday 9:00 AM at ' + CLINIC_NAME + '.\n📍 1234 Main St, San Francisco\n💳 Deposit: stripe.test/d/abc123\n📷 Upload your insurance card before the visit: bsd.test/upload/' + inboundPatient.patient_id + '\nReply STOP to opt out of WhatsApp.',
        { purpose: 'whatsapp_confirmation' }
      )
    },

    // ───────────────────────── EXCEPTION FLOW ─────────────────────────
    { step: 16, time_offset_ms: 28000, scene: '10:05 — Exception Detected',
      title: 'Verification fails on ' + declinedPatient.first_name + ' ' + declinedPatient.last_name + ' — coverage terminated',
      description: 'Periodic eligibility scan hits a problem. Patient appears terminated. Cannot schedule — needs human follow-up.',
      action: () => {
        // Simulate terminated verification
        const v = verifyTreatmentPlan(terminatedPatient, [{ ada_code: 'D0120', fee: 95 }]);
        return { exception_code: 'COVERAGE_TERMINATED', coverage_status: v.coverage_status, patient_pays_total: v.totals.patient_pays };
      }
    },
    { step: 17, time_offset_ms: 29500, scene: '10:06 — WhatsApp to Staff (Escalation)',
      title: 'Human-in-the-loop WhatsApp escalation',
      description: 'Auto-generated call script + one-tap action buttons sent to Maria. She handles personally.',
      action: () => sendToStaff('whatsapp', STAFF_GROUP,
        '⚠ HUMAN FOLLOW-UP NEEDED\n\nPatient: ' + declinedPatient.first_name + ' ' + declinedPatient.last_name + ' (' + declinedPatient.patient_id + ')\nException: COVERAGE_TERMINATED\nLast verified active: 2024-03\n\n📞 CALL SCRIPT:\n1. Confirm coverage change vs error\n2. Get new carrier + member ID if available\n3. Offer self-pay option (~$95)\n4. Document outcome\n\nReply ✅ when resolved, ⏭ to defer, 👤 to reassign.',
        { purpose: 'human_escalation' }
      )
    },

    // ───────────────────────── END OF SHIFT ─────────────────────────
    { step: 18, time_offset_ms: 32000, scene: '17:00 — End-of-Shift Summary',
      title: 'WhatsApp summary to office manager',
      description: 'Daily KPI roll-up — campaigns sent, appointments booked, no-shows averted, revenue protected, exceptions handled.',
      action: () => sendToStaff('whatsapp', OFFICE_MGR_PHONE,
        '📊 End-of-shift · ' + new Date().toLocaleDateString() + '\n\n• Outreach campaigns: 47 touchpoints across 20 patients\n• Responses: 14 (30% response rate)\n• Appointments booked: 9 (vs avg 4)\n• No-shows averted (SPC-flagged + deposit): est. 3, ≈$1,200 revenue protected\n• Exceptions resolved: 3 (1 still open — coverage termination)\n• Pending tx scheduled: $4,200 in restorative work\n\nDetail: bsd.test/eod/' + new Date().toISOString().slice(0,10),
        { audience: 'office_mgr', purpose: 'end_of_shift_summary' }
      )
    }
  ];
}

// ── Player — runs the script with realistic timing (or "fast" mode for demo)
async function runScript(opts) {
  opts = opts || {};
  const speed = opts.speed || 'normal'; // 'fast' = 100ms steps, 'normal' = realistic, 'slow' = 3s steps
  const onEvent = opts.onEvent || (() => {});
  const script = buildScript(opts);
  const state = {};
  const startedAt = Date.now();
  const results = [];

  for (const step of script) {
    if (speed === 'fast') await _sleep(150);
    else if (speed === 'slow') await _sleep(2500);
    else {
      const elapsed = Date.now() - startedAt;
      const target = step.time_offset_ms / 2; // half-speed compared to scripted timing
      if (target > elapsed) await _sleep(target - elapsed);
    }

    let actionResult = null;
    if (step.action) {
      try {
        actionResult = step.action(state);
        if (step.stores) state[step.stores] = actionResult.session_id ? state.inbound_session : actionResult;
        if (step.stores === 'inbound_session' && actionResult.session_id) {
          // Re-fetch the session — it's stored elsewhere; for the demo, mock holds the orchestrator session
        }
      } catch (e) {
        actionResult = { error: e.message };
      }
    }
    const event = {
      step: step.step,
      scene: step.scene,
      title: step.title,
      description: step.description,
      ui_event: step.ui_event || null,
      result: actionResult,
      at: new Date().toISOString()
    };
    results.push(event);
    onEvent(event);
  }
  return { steps_run: results.length, results };
}

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { buildScript, runScript };

// CLI: node lib/demoRunner.cjs [--fast|--slow]
if (require.main === module) {
  const speed = process.argv.includes('--fast') ? 'fast' : process.argv.includes('--slow') ? 'slow' : 'fast';
  console.log('Running demo at speed=' + speed);
  runScript({
    speed,
    onEvent: (e) => {
      console.log();
      console.log('[Step ' + e.step + '] ' + e.scene);
      console.log('  ' + e.title);
      console.log('  ' + e.description);
      if (e.result && !e.result.error) console.log('  ✓ ' + JSON.stringify(e.result).slice(0, 200));
      if (e.result && e.result.error) console.log('  ✗ ' + e.result.error);
    }
  }).then(r => {
    console.log();
    console.log('═══ Demo complete · ' + r.steps_run + ' steps ═══');
    process.exit(0);
  });
}
