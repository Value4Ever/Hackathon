// _hackathon_dental/exceptionRouter.cjs — verification exception classifier
// + action-plan generator. The "human-loop fallback engine."
//
// Given a verification query + verify result (or a not-found envelope),
// classify the failure into one or more exception codes, then return a
// structured action plan: who to contact, via what channel, with what script.

'use strict';

const ACTION_TEMPLATES = {
  // ── Patient outreach (SMS) ───────────────────────────────────────
  sms_request_member_id: {
    channel: 'sms',
    template_id: 'sms_request_member_id',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Insurance verification',
    body_template: 'Hi {first_name}, this is {practice} confirming your insurance for your upcoming visit. Could you text back your dental insurance member ID and the carrier name? (e.g. "DDX448120731 Delta Dental"). Thank you!'
  },
  sms_request_card_photo: {
    channel: 'sms',
    template_id: 'sms_request_card_photo',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Insurance card photo',
    body_template: 'Hi {first_name}, we could not match your insurance on our first lookup. Please reply with a photo of the front + back of your dental insurance card. Secure upload: {secure_link}. Thank you!'
  },
  sms_request_dob: {
    channel: 'sms',
    template_id: 'sms_request_dob',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Confirm date of birth',
    body_template: 'Hi {first_name}, we have a name match on your insurance but the date of birth on file does not match what you gave us. Could you confirm your DOB so we can complete verification? Thanks!'
  },
  sms_defer_until: {
    channel: 'sms',
    template_id: 'sms_defer_until',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Procedure timing — coverage update',
    body_template: 'Hi {first_name}, your insurance covers {procedure_desc} again starting {next_eligible_date} (frequency limit on the last service). Want to schedule for {next_eligible_date} or later? Or we can do it sooner as self-pay (~${self_pay_estimate}).'
  },
  sms_waiting_period: {
    channel: 'sms',
    template_id: 'sms_waiting_period',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Waiting period notice',
    body_template: 'Hi {first_name}, your insurance has a {waiting_months}-month waiting period for {procedure_desc} that ends {waiting_end_date}. Options: schedule after that date, or proceed now as self-pay (~${self_pay_estimate}). Let us know.'
  },
  sms_missing_tooth_alternate: {
    channel: 'sms',
    template_id: 'sms_missing_tooth_alternate',
    target: 'patient',
    eta_minutes: 5,
    subject: 'Treatment alternatives',
    body_template: 'Hi {first_name}, your insurance has a missing-tooth clause that excludes the {procedure_desc} we discussed. We have alternative treatments your insurance does cover, or we can proceed with the original plan as self-pay (~${self_pay_estimate}). Want to set up a quick chat?'
  },

  // ── Patient outreach (Phone call) ────────────────────────────────
  call_patient_verify_id: {
    channel: 'call',
    template_id: 'call_patient_verify_id',
    target: 'patient',
    eta_minutes: 10,
    subject: 'Call patient to verify insurance ID',
    script: [
      'Hi {first_name}, this is {practice} — we are confirming your insurance for {appointment_date}.',
      'I am calling because our verification system could not match the insurance info we have on file ({attempted_member_id}).',
      'Could you read me your dental insurance member ID? — (write it down)',
      'And the name of the carrier on your card? — (confirm payer)',
      'And just to confirm, your date of birth is {dob}? — (confirm)',
      'Great, I will re-verify and call you back if anything else is needed.'
    ],
    required_fields: ['member_id', 'payer_name', 'dob_confirmation']
  },
  call_patient_terminated: {
    channel: 'call',
    template_id: 'call_patient_terminated',
    target: 'patient',
    eta_minutes: 10,
    subject: 'Coverage terminated — clarify next step',
    script: [
      'Hi {first_name}, this is {practice}.',
      'When we verified your insurance for {appointment_date}, your {payer_name} coverage shows as terminated (effective {term_date}).',
      'Has your insurance changed? — (yes/no)',
      'If yes: Could you give me the new carrier + member ID?',
      'If no insurance: We can offer a self-pay estimate (~${self_pay_estimate}) or reschedule. Which works?',
      'Confirm next step and document outcome.'
    ],
    required_fields: ['new_carrier?', 'self_pay_consent?', 'reschedule?']
  },
  call_patient_oon: {
    channel: 'call',
    template_id: 'call_patient_oon',
    target: 'patient',
    eta_minutes: 10,
    subject: 'Out-of-network — set expectations',
    script: [
      'Hi {first_name}, this is {practice}.',
      'Your insurance ({payer_name}) is active, but we are out-of-network for them.',
      'Out-of-network means: insurance covers a lower percentage, and you may be billed for the difference between our fee and what they call the "usual and customary" amount.',
      'For your planned treatment, we estimate your out-of-pocket at $${oon_estimate} vs about $${in_network_estimate} if you were in-network.',
      'Three options: (1) proceed as-is, (2) we can refer you to an in-network provider, (3) we can submit for an out-of-network gap exception with your insurance.',
      'Which would you like to do?'
    ],
    required_fields: ['choice']
  },
  call_patient_cob: {
    channel: 'call',
    template_id: 'call_patient_cob',
    target: 'patient',
    eta_minutes: 10,
    subject: 'Coordination of benefits — clarify primary',
    script: [
      'Hi {first_name}, this is {practice}.',
      'We see you have two dental insurance plans on file: {primary_name} and {secondary_name}.',
      'For your visit, we need to confirm which is your primary insurance — typically the one tied to your own employer (vs. a spouse or parent).',
      'Is {primary_name} your own employer plan?',
      'And {secondary_name} — is that through a spouse or another family member?',
      'Great, I will mark {confirmed_primary} as primary. We will bill primary first, then submit any remaining balance to secondary.'
    ],
    required_fields: ['confirmed_primary', 'confirmed_secondary']
  },

  // ── Insurance carrier outreach ───────────────────────────────────
  call_insurance_verify: {
    channel: 'insurance_call',
    template_id: 'call_insurance_verify',
    target: 'insurance',
    eta_minutes: 20,
    subject: 'Manual insurance verification call',
    phone: '{payer_phone}',
    npi_needed: true,
    script: [
      'Hi, this is {provider_name} (NPI {provider_npi}) calling to verify dental benefits.',
      'Member name: {first_name} {last_name}',
      'Member DOB: {dob}',
      'Member ID: {member_id}',
      'Subscriber relationship: {subscriber_relationship}',
      'Please confirm:',
      '  1. Coverage status + effective dates',
      '  2. Annual maximum + amount used YTD',
      '  3. Deductible + amount met',
      '  4. Coverage percentages by category (diagnostic / preventive / basic / major / ortho)',
      '  5. Waiting periods for basic + major',
      '  6. Procedure-specific limits for: {procedure_codes}',
      '  7. Reference number for this call: ____'
    ],
    required_fields: ['reference_number', 'rep_name', 'callback_date']
  },
  call_insurance_preauth: {
    channel: 'insurance_call',
    template_id: 'call_insurance_preauth',
    target: 'insurance',
    eta_minutes: 30,
    subject: 'Submit preauthorization',
    phone: '{payer_phone}',
    script: [
      'Hi, this is {provider_name} (NPI {provider_npi}) submitting preauth for member {member_id}.',
      'Patient: {first_name} {last_name}, DOB {dob}.',
      'Requested procedures requiring preauth: {preauth_codes}.',
      'Clinical justification will be faxed/emailed: include x-rays, periodontal chart, narrative.',
      'Get preauth reference + expected turnaround time.'
    ],
    required_fields: ['preauth_reference', 'turnaround_days']
  },

  // ── Self-service / web ───────────────────────────────────────────
  web_form_eligibility: {
    channel: 'web_form',
    template_id: 'web_form_eligibility',
    target: 'payer_portal',
    eta_minutes: 15,
    subject: 'Submit web eligibility form',
    note: 'Some carriers (Aetna, Cigna) require web portal verification instead of phone — login + form submission.',
    deep_link: '{payer_portal_url}',
    required_fields: ['portal_response_received', 'reference_number']
  }
};

// Per-payer phone + portal directory (mock — fill from real carrier list)
const PAYER_DIRECTORY = {
  DDCA:   { name: 'Delta Dental of California', phone: '800-765-6003', portal: 'https://www.deltadentalins.com/dentists' },
  DDPA:   { name: 'Delta Dental of Pennsylvania', phone: '800-471-1010', portal: 'https://www.deltadentalins.com/dentists' },
  METLIFE:{ name: 'MetLife Dental', phone: '877-638-3379', portal: 'https://metdental.com' },
  AETNA:  { name: 'Aetna Dental', phone: '877-238-6200', portal: 'https://www.aetna.com/health-care-professionals/dental.html' },
  CIGNA:  { name: 'Cigna Dental', phone: '800-244-6224', portal: 'https://cignaforhcp.cigna.com' },
  GUARDIAN:{ name: 'Guardian Dental', phone: '800-541-7846', portal: 'https://www.guardianlife.com/dental-insurance' },
  UCC:    { name: 'United Concordia', phone: '866-357-3304', portal: 'https://www.unitedconcordia.com/dental-insurance' },
  HUMANA: { name: 'Humana Dental', phone: '800-233-4013', portal: 'https://www.humana.com/provider' }
};

function _resolvePayerInfo(payer_id, fallback_name) {
  const entry = PAYER_DIRECTORY[payer_id];
  if (entry) return { phone: entry.phone, portal: entry.portal, name: entry.name };
  return { phone: '(not on file)', portal: null, name: fallback_name || payer_id || 'unknown carrier' };
}

function _fmtScript(arr, fields) {
  return arr.map(line => {
    for (const [k, v] of Object.entries(fields || {})) {
      line = line.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
    }
    return line;
  });
}

function _fmtTemplate(tpl, fields) {
  let out = tpl;
  for (const [k, v] of Object.entries(fields || {})) {
    out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
  }
  return out;
}

function _buildAction(templateId, fields) {
  const tpl = ACTION_TEMPLATES[templateId];
  if (!tpl) return null;
  const action = {
    channel: tpl.channel,
    template_id: tpl.template_id,
    target: tpl.target,
    eta_minutes: tpl.eta_minutes,
    subject: _fmtTemplate(tpl.subject, fields),
  };
  if (tpl.body_template) action.body = _fmtTemplate(tpl.body_template, fields);
  if (tpl.script) action.script = _fmtScript(tpl.script, fields);
  if (tpl.phone) action.phone = _fmtTemplate(tpl.phone, fields);
  if (tpl.deep_link) action.deep_link = _fmtTemplate(tpl.deep_link, fields);
  if (tpl.required_fields) action.required_fields = tpl.required_fields;
  if (tpl.note) action.note = tpl.note;
  return action;
}

// ────────────────────────────────────────────────────────────────────
// PUBLIC API
// ────────────────────────────────────────────────────────────────────

// Classify a not-found / partial-match eligibility lookup.
function classifyEligibilityFailure(query, allPatients) {
  // query: { member_id?, first_name?, last_name?, date_of_birth?, payer_id? }
  // allPatients: array of patient list rows (from db.listPatients())
  const exceptions = [];
  const memberId = query.member_id;
  const fname = (query.first_name || '').toLowerCase().trim();
  const lname = (query.last_name || '').toLowerCase().trim();
  const dob = query.date_of_birth;
  const payerId = query.payer_id;

  // ── Look for partial matches in the registry
  let partialMatches = [];
  if (fname || lname) {
    partialMatches = (allPatients || []).filter(p => {
      const fOk = !fname || (p.first_name || '').toLowerCase() === fname;
      const lOk = !lname || (p.last_name || '').toLowerCase() === lname;
      return (fOk || lOk);
    });
  }
  const nameMatchOnly = partialMatches.filter(p => {
    return (p.first_name || '').toLowerCase() === fname &&
           (p.last_name || '').toLowerCase() === lname;
  });

  // ── Decide failure type
  if (!memberId && (!fname || !lname || !dob)) {
    exceptions.push({
      code: 'INCOMPLETE_IDENTIFIERS',
      severity: 'high',
      summary: 'Request missing identifiers from the patient — neither member_id nor full name+DOB was provided.',
      action_plan: [_buildAction('sms_request_member_id', { first_name: fname || 'there', practice: '{practice}', secure_link: '{secure_link}' })]
    });
    return exceptions;
  }

  if (nameMatchOnly.length === 1 && nameMatchOnly[0].date_of_birth !== dob) {
    const p = nameMatchOnly[0];
    exceptions.push({
      code: 'PARTIAL_MATCH_DOB',
      severity: 'medium',
      summary: 'Name matches a member on file (' + p.patient_id + ') but DOB does not (' + p.date_of_birth + ' vs supplied ' + dob + '). Likely a typo.',
      candidate_patient_id: p.patient_id,
      action_plan: [_buildAction('sms_request_dob', { first_name: fname, practice: '{practice}' }),
                    _buildAction('call_patient_verify_id', { first_name: fname, practice: '{practice}', appointment_date: '{appointment_date}', attempted_member_id: memberId || 'name+DOB lookup', dob: dob })]
    });
    return exceptions;
  }

  if (nameMatchOnly.length === 1 && payerId && nameMatchOnly[0].payer_id !== payerId) {
    const p = nameMatchOnly[0];
    exceptions.push({
      code: 'PARTIAL_MATCH_PAYER',
      severity: 'medium',
      summary: 'Patient on file with a different carrier (' + p.payer_id + ' on file vs supplied ' + payerId + '). Coverage may have changed.',
      candidate_patient_id: p.patient_id,
      action_plan: [_buildAction('call_patient_verify_id', { first_name: fname, practice: '{practice}', appointment_date: '{appointment_date}', attempted_member_id: memberId || 'name+DOB lookup', dob: dob })]
    });
    return exceptions;
  }

  // Catch-all not-found
  exceptions.push({
    code: 'MEMBER_NOT_FOUND',
    severity: 'high',
    summary: 'No matching member on file with the supplied identifiers. Likely needs patient to confirm or send insurance card.',
    action_plan: [
      _buildAction('sms_request_member_id', { first_name: fname || 'there', practice: '{practice}', secure_link: '{secure_link}' }),
      _buildAction('sms_request_card_photo', { first_name: fname || 'there', practice: '{practice}', secure_link: '{secure_link}' }),
      _buildAction('call_patient_verify_id', { first_name: fname, practice: '{practice}', appointment_date: '{appointment_date}', attempted_member_id: memberId || 'name+DOB lookup', dob: dob || 'unknown' })
    ]
  });
  return exceptions;
}

// Classify exceptions in a successful verify result (active patient but with issues).
function classifyVerifyExceptions(verifyResult) {
  const exceptions = [];
  if (!verifyResult || !verifyResult.patient) return exceptions;
  const r = verifyResult;
  const p = r.patient;
  const payerInfo = _resolvePayerInfo(r.payer?.payer_id, r.payer?.name);

  // ── Terminated coverage
  if (r.coverage_status && r.coverage_status !== 'active') {
    exceptions.push({
      code: 'COVERAGE_TERMINATED',
      severity: 'high',
      summary: 'Coverage status is "' + r.coverage_status + '". Patient may have new insurance or need to self-pay.',
      action_plan: [
        _buildAction('call_patient_terminated', {
          first_name: p.first_name, practice: '{practice}', appointment_date: '{appointment_date}',
          payer_name: r.payer?.name || '?', term_date: r.coverage?.termination_date || '?',
          self_pay_estimate: (r.totals?.usual_fees || 0).toFixed(2)
        })
      ]
    });
  }

  // ── Out-of-network
  if (r.coverage?.in_network === false || r.coverage_active && r.coverage?.in_network === false) {
    exceptions.push({
      code: 'OUT_OF_NETWORK',
      severity: 'medium',
      summary: 'Plan is active but provider is out-of-network. Patient pays a higher share + potential balance billing.',
      action_plan: [
        _buildAction('call_patient_oon', {
          first_name: p.first_name, practice: '{practice}',
          payer_name: r.payer?.name || '?',
          oon_estimate: (r.totals?.patient_pays || 0).toFixed(2),
          in_network_estimate: 'TBD (call carrier for in-network fee schedule)'
        })
      ]
    });
  }

  // ── Per-line gates: waiting period, frequency, missing tooth, preauth
  const waitingLines = (r.lines || []).filter(l => l.not_covered_reason && /waiting period/i.test(l.not_covered_reason));
  const freqLines = (r.lines || []).filter(l => l.not_covered_reason && /frequency|eligible until|eligible:/i.test(l.not_covered_reason));
  const missingToothLines = (r.lines || []).filter(l => l.not_covered_reason && /missing tooth/i.test(l.not_covered_reason));
  const preauthLines = (r.lines || []).filter(l => (l.reasons || []).some(rs => /pre-authorization|preauth/i.test(rs)));

  for (const l of waitingLines) {
    const mt = l.not_covered_reason.match(/(\d+)\s*months?/i);
    const months = mt ? mt[1] : '?';
    exceptions.push({
      code: 'WAITING_PERIOD_BLOCK',
      severity: 'medium',
      summary: 'Procedure ' + l.ada_code + ' is in a ' + months + '-month waiting period.',
      affected_ada_code: l.ada_code,
      action_plan: [
        _buildAction('sms_waiting_period', {
          first_name: p.first_name, waiting_months: months, procedure_desc: l.description || l.ada_code,
          waiting_end_date: '{calc from effective_date + waiting_period_months}',
          self_pay_estimate: (l.usual_fee || 0).toFixed(2)
        })
      ]
    });
  }
  for (const l of freqLines) {
    const dt = l.not_covered_reason.match(/(\d{4}-\d{2}-\d{2})/);
    exceptions.push({
      code: 'FREQUENCY_LIMIT_BLOCK',
      severity: 'low',
      summary: 'Procedure ' + l.ada_code + ' is frequency-limited; next eligible ' + (dt ? dt[1] : 'unknown'),
      affected_ada_code: l.ada_code,
      action_plan: [
        _buildAction('sms_defer_until', {
          first_name: p.first_name, procedure_desc: l.description || l.ada_code,
          next_eligible_date: dt ? dt[1] : 'next benefit period',
          self_pay_estimate: (l.usual_fee || 0).toFixed(2)
        })
      ]
    });
  }
  for (const l of missingToothLines) {
    exceptions.push({
      code: 'MISSING_TOOTH_EXCLUSION',
      severity: 'high',
      summary: 'Procedure ' + l.ada_code + ' is excluded by the missing tooth clause. Patient needs alternatives.',
      affected_ada_code: l.ada_code,
      action_plan: [
        _buildAction('sms_missing_tooth_alternate', {
          first_name: p.first_name, procedure_desc: l.description || l.ada_code,
          self_pay_estimate: (l.usual_fee || 0).toFixed(2)
        })
      ]
    });
  }
  for (const l of preauthLines) {
    exceptions.push({
      code: 'PREAUTH_REQUIRED',
      severity: 'high',
      summary: 'Procedure ' + l.ada_code + ' requires pre-authorization before scheduling.',
      affected_ada_code: l.ada_code,
      action_plan: [
        _buildAction('call_insurance_preauth', {
          provider_name: '{provider_name}', provider_npi: '{provider_npi}',
          member_id: '{member_id}', first_name: p.first_name, last_name: p.last_name,
          dob: p.date_of_birth, preauth_codes: l.ada_code,
          payer_phone: payerInfo.phone
        })
      ]
    });
  }

  // ── COB unclear (multiple plans without clear primary)
  if (r.cob && r.cob.this_plan_order === 'unknown') {
    exceptions.push({
      code: 'COB_UNCLEAR',
      severity: 'medium',
      summary: 'Two dental plans on file but primary unclear. Call patient to clarify.',
      action_plan: [
        _buildAction('call_patient_cob', {
          first_name: p.first_name, practice: '{practice}',
          primary_name: r.payer?.name || '?', secondary_name: r.cob.secondary?.name || '?',
          confirmed_primary: '{TBD}'
        })
      ]
    });
  }

  return exceptions;
}

// Mock contact execution — log + return a receipt. Real impl wires Twilio, etc.
function executeContact(action, contextData) {
  const receipt = {
    action_id: 'ACT-' + Date.now(),
    template_id: action.template_id,
    channel: action.channel,
    target: action.target,
    sent_at: new Date().toISOString(),
    status: 'sent_mock',
    body_preview: (action.body || (action.script ? action.script.join(' / ') : '')).slice(0, 200)
  };
  return receipt;
}

module.exports = {
  classifyEligibilityFailure,
  classifyVerifyExceptions,
  executeContact,
  PAYER_DIRECTORY,
  ACTION_TEMPLATES
};
