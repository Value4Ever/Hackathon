// _hackathon_dental/verifyEngine.js — coverage decision logic.
//
// Per the mock README design note: this engine prices + annotates a treatment
// plan. It does NOT select the clinical plan. Inputs are an eligibility record
// (mock-vendor shape) + a treatment plan (array of ADA codes with usual fees).
// Output is a per-line breakdown + totals + plain-English explanations.
//
// Edge cases supported (matching the 10 mock scenarios):
//   1. Active coverage with unmet deductible → deductible offsets patient OOP
//   2. Annual maximum partially / fully consumed → carrier-paid cap enforced
//   3. Waiting period not met → not covered, full self-pay
//   4. Age limit (e.g., ortho ≤ 18) → not covered if age out of range
//   5. Terminated coverage → self-pay
//   6. Coordination of Benefits → primary pays, secondary picks up remaining %
//   7. DHMO copay schedule → patient pays fixed copay, no %, no annual max
//   8. Missing tooth clause → bridges/implants on long-missing teeth excluded
//   9. Out-of-network indemnity → UCR + balance billing on the difference
//  10. Frequency-limited → if next_eligible_date is future, not yet covered

'use strict';

function _yearsBetween(dateIsoOlder, dateIsoNewer) {
  const a = new Date(dateIsoOlder);
  const b = new Date(dateIsoNewer);
  return (b - a) / (365.25 * 24 * 60 * 60 * 1000);
}

function _ageOnDate(dobIso, asOfIso) {
  if (!dobIso) return null;
  return _yearsBetween(dobIso, asOfIso || new Date().toISOString().slice(0, 10));
}

function _isFuture(dateIso, asOfIso) {
  if (!dateIso) return false;
  const a = new Date(dateIso);
  const b = new Date(asOfIso || new Date().toISOString().slice(0, 10));
  return a > b;
}

function _findBenefit(record, adaCode) {
  return (record.procedure_benefits || []).find(b => b.ada_code === adaCode) || null;
}

// Standard CDT code → category fallback when a procedure isn't in the plan's
// procedure_benefits but the coverage_by_category map applies.
function _adaCategory(adaCode) {
  if (!adaCode || typeof adaCode !== 'string') return 'unknown';
  const m = adaCode.match(/^D(\d)/);
  if (!m) return 'unknown';
  const block = parseInt(m[1], 10);
  if (block === 0) return 'diagnostic';
  if (block === 1) return 'preventive';
  if (block === 2 || block === 3 || block === 4 || block === 9) return 'basic';
  if (block === 5 || block === 6 || block === 7) return 'major';
  if (block === 8) return 'ortho';
  return 'unknown';
}

function _categoryCoveragePercent(record, category, inNetwork) {
  // Fallback to the category map if a procedure-level percent isn't present.
  const cat = (record.coverage_by_category || {})[category];
  if (!cat) return null;
  return inNetwork ? (cat.in_network_percent ?? cat.percent) : (cat.out_of_network_percent ?? cat.percent);
}

function _missingToothExcluded(record, adaCode) {
  // The mock represents this as a boolean `missing_tooth_clause: true|false`
  // with a sibling `missing_tooth_clause_detail` string. Older shapes used
  // an object `{active, excluded_codes, note}` — support both.
  const lim = record.limitations || {};
  const clauseBool = lim.missing_tooth_clause;
  const clauseObj = (typeof clauseBool === 'object' && clauseBool) ? clauseBool : null;
  const active = clauseObj ? clauseObj.active : clauseBool === true;
  if (!active) return null;
  const excludedCodes = (clauseObj && clauseObj.excluded_codes) || ['D6240', 'D6241', 'D6242', 'D6750', 'D6751', 'D6752', 'D6010', 'D6056', 'D6057', 'D6058', 'D6059'];
  if (excludedCodes.includes(adaCode)) {
    const reason = (clauseObj && clauseObj.note) || lim.missing_tooth_clause_detail
                || 'tooth was missing before coverage began; bridge/implant for that tooth not covered.';
    return { excluded: true, reason: 'Missing tooth clause — ' + reason };
  }
  return null;
}

function _waitingPeriodCheck(benefit, asOfIso) {
  if (!benefit) return { ok: true };
  if (benefit.waiting_period_met === true) return { ok: true };
  if (benefit.waiting_period_met === false) {
    return {
      ok: false,
      reason: 'Waiting period (' + (benefit.waiting_period_months || '?') + ' months) not yet met for this procedure.'
    };
  }
  return { ok: true };
}

function _frequencyCheck(benefit, asOfIso) {
  if (!benefit) return { ok: true };
  if (benefit.frequency_remaining === 0) {
    const nextEligible = benefit.next_eligible_date;
    return {
      ok: false,
      reason: nextEligible
        ? 'Frequency limit reached for ' + asOfIso + '. Next eligible: ' + nextEligible + '.'
        : 'Frequency limit reached for the current benefit period.'
    };
  }
  if (benefit.next_eligible_date && _isFuture(benefit.next_eligible_date, asOfIso)) {
    return {
      ok: false,
      reason: 'Not yet eligible until ' + benefit.next_eligible_date + ' (frequency limit on prior service).'
    };
  }
  return { ok: true };
}

function _ageCheck(benefit, patient, asOfIso) {
  if (!benefit || benefit.age_limit == null) return { ok: true };
  const age = _ageOnDate(patient.date_of_birth, asOfIso);
  if (age == null) return { ok: true };
  if (age > benefit.age_limit) {
    return {
      ok: false,
      reason: 'Age limit ' + benefit.age_limit + ' exceeded (patient is ' + Math.floor(age) + ').'
    };
  }
  return { ok: true };
}

function _explainDownPlain(line) {
  // Turn a structured line decision into a sentence a patient can understand.
  const bits = [];
  if (line.covered) {
    bits.push('Insurance pays $' + line.carrier_pays.toFixed(2));
    if (line.deductible_applied > 0) bits.push('after $' + line.deductible_applied.toFixed(2) + ' deductible');
    if (line.copay != null) bits.push('(fixed copay $' + line.copay.toFixed(2) + ')');
    else if (line.coverage_percent != null && line.coverage_percent < 100) bits.push('(at ' + line.coverage_percent + '%)');
    if (line.annual_max_capped > 0) bits.push('annual max applied — $' + line.annual_max_capped.toFixed(2) + ' would have been paid but plan year cap reached');
    if (line.downgrade_applied) bits.push('downgraded to alternate benefit (' + line.downgrade_from + ' → ' + line.downgrade_to + ')');
    bits.push('You pay $' + line.patient_pays.toFixed(2));
  } else {
    bits.push('Not covered — ' + (line.not_covered_reason || 'see notes'));
    bits.push('You pay full $' + line.usual_fee.toFixed(2));
  }
  return bits.join('. ') + '.';
}

function verifyTreatmentPlan(record, treatmentPlan, opts) {
  // record: full eligibility record (from db.getByPatientId / getByMemberId / findByNameDob)
  // treatmentPlan: array of { ada_code, fee, tooth_number?, surface? }
  // opts: { as_of_date?, in_network_override? }
  opts = opts || {};
  const asOf = opts.as_of_date || new Date().toISOString().slice(0, 10);

  const result = {
    patient: record.patient,
    payer: record.payer,
    coverage_status: record.coverage && record.coverage.status,
    as_of_date: asOf,
    lines: [],
    totals: {
      usual_fees: 0,
      carrier_pays: 0,
      patient_pays: 0,
      deductible_applied: 0,
      annual_max_used: 0,
      annual_max_remaining_after: 0,
    },
    warnings: [],
    annotations: []
  };

  // ── Coverage active check
  if (record.coverage && record.coverage.status !== 'active') {
    result.coverage_active = false;
    for (const item of treatmentPlan) {
      const line = {
        ada_code: item.ada_code,
        description: item.description || (_findBenefit(record, item.ada_code)?.description) || '',
        usual_fee: Number(item.fee) || 0,
        covered: false,
        carrier_pays: 0,
        patient_pays: Number(item.fee) || 0,
        deductible_applied: 0,
        coverage_percent: 0,
        annual_max_capped: 0,
        downgrade_applied: false,
        not_covered_reason: 'Coverage ' + record.coverage.status + ' — treat as self-pay.'
      };
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += line.usual_fee;
      result.totals.patient_pays += line.patient_pays;
    }
    result.annotations.push('Coverage is ' + record.coverage.status + '. All charges are the patient\'s responsibility.');
    return result;
  }
  result.coverage_active = true;

  // ── Working ledger state across the plan year (we apply procedures in order)
  let deductibleRemaining = (record.deductibles && record.deductibles.individual_remaining) || 0;
  let annualMaxRemaining = (record.plan_maximums && record.plan_maximums.annual_remaining) ?? Infinity;
  const annualMaxStart = annualMaxRemaining;
  const deductibleWaivedCats = new Set((record.deductibles && record.deductibles.waived_for_categories) || []);
  const inNetwork = opts.in_network_override !== undefined
    ? !!opts.in_network_override
    : !!(record.coverage && record.coverage.in_network);

  // ── DHMO copay-schedule plan detection (PT-0007 scenario)
  const isCopayPlan = (record.payer && record.payer.plan_type === 'DHMO') ||
                       (record.plan_maximums && record.plan_maximums.annual_maximum == null);

  for (const item of treatmentPlan) {
    const ada = item.ada_code;
    const benefit = _findBenefit(record, ada);
    // If no procedure-level benefit, fall back to CDT code → category map.
    const category = benefit?.category || _adaCategory(ada);
    const fee = Number(item.fee) || 0;

    const line = {
      ada_code: ada,
      description: benefit?.description || item.description || '',
      category,
      usual_fee: fee,
      covered: false,
      carrier_pays: 0,
      patient_pays: 0,
      deductible_applied: 0,
      coverage_percent: 0,
      annual_max_capped: 0,
      downgrade_applied: false,
      downgrade_from: null,
      downgrade_to: null,
      reasons: [],
      not_covered_reason: null
    };

    // ── Gates
    const mt = _missingToothExcluded(record, ada);
    if (mt && mt.excluded) {
      line.not_covered_reason = mt.reason;
      line.patient_pays = fee;
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.patient_pays += fee;
      continue;
    }
    const wp = _waitingPeriodCheck(benefit, asOf);
    if (!wp.ok) {
      line.not_covered_reason = wp.reason;
      line.patient_pays = fee;
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.patient_pays += fee;
      continue;
    }
    const fq = _frequencyCheck(benefit, asOf);
    if (!fq.ok) {
      line.not_covered_reason = fq.reason;
      line.patient_pays = fee;
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.patient_pays += fee;
      continue;
    }
    const ag = _ageCheck(benefit, record.patient, asOf);
    if (!ag.ok) {
      line.not_covered_reason = ag.reason;
      line.patient_pays = fee;
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.patient_pays += fee;
      continue;
    }

    // ── DHMO copay-schedule path (mock field is `patient_copay`)
    if (isCopayPlan) {
      const copay = benefit?.patient_copay ?? benefit?.copay_amount;
      if (copay != null) {
        line.covered = true;
        line.coverage_percent = null;
        line.copay = copay;
        line.carrier_pays = Math.max(0, fee - copay);
        line.patient_pays = copay;
        line.reasons.push('DHMO plan — fixed copay of $' + copay.toFixed(2) + ' per copay schedule. Carrier pays the contracted balance.');
      } else {
        line.covered = false;
        line.patient_pays = fee;
        line.not_covered_reason = 'DHMO plan — no copay listed for this code; not on the schedule.';
      }
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.carrier_pays += line.carrier_pays;
      result.totals.patient_pays += line.patient_pays;
      continue;
    }

    // ── % coverage path (PPO/indemnity)
    const pct = benefit?.coverage_percent ?? _categoryCoveragePercent(record, category, inNetwork);
    if (pct == null) {
      // No coverage info for this procedure → not in fee schedule
      line.not_covered_reason = 'No benefit listed for this ADA code on this plan.';
      line.patient_pays = fee;
      line.plain_english = _explainDownPlain(line);
      result.lines.push(line);
      result.totals.usual_fees += fee;
      result.totals.patient_pays += fee;
      continue;
    }

    // ── Alternate-benefit / downgrade (insurer pays for cheaper alternative)
    let effectiveFee = fee;
    if (benefit?.alternate_benefit && benefit.alternate_benefit.code) {
      const altFee = benefit.alternate_benefit.allowed_amount;
      if (altFee != null && altFee < fee) {
        line.downgrade_applied = true;
        line.downgrade_from = ada;
        line.downgrade_to = benefit.alternate_benefit.code;
        line.reasons.push('Alternate benefit clause: insurer covers up to $' + altFee.toFixed(2) + ' (cost of ' + benefit.alternate_benefit.code + '). You pay the difference.');
        effectiveFee = altFee;
      }
    }

    // ── Apply deductible (if category requires it AND deductible remains)
    let deductibleFromThis = 0;
    if (!deductibleWaivedCats.has(category) && deductibleRemaining > 0) {
      deductibleFromThis = Math.min(deductibleRemaining, effectiveFee);
      deductibleRemaining -= deductibleFromThis;
    }

    // ── Coverage on remaining-after-deductible
    const coverageBase = Math.max(0, effectiveFee - deductibleFromThis);
    let carrierPays = coverageBase * (pct / 100);

    // ── Annual max cap
    let annualMaxCapped = 0;
    if (annualMaxRemaining < carrierPays) {
      annualMaxCapped = carrierPays - annualMaxRemaining;
      carrierPays = annualMaxRemaining;
      line.reasons.push('Annual maximum reached — $' + annualMaxCapped.toFixed(2) + ' that would have been paid is now your responsibility.');
    }
    annualMaxRemaining = Math.max(0, annualMaxRemaining - carrierPays);

    // ── Patient OOP: deductible + (effectiveFee - deductible - carrierPays) + downgrade-balance + cap-overage
    const downgradeBalance = fee - effectiveFee; // patient pays diff when downgraded
    const patientPays = deductibleFromThis + Math.max(0, coverageBase - carrierPays) + downgradeBalance;

    line.covered = true;
    line.coverage_percent = pct;
    line.carrier_pays = carrierPays;
    line.patient_pays = patientPays;
    line.deductible_applied = deductibleFromThis;
    line.annual_max_capped = annualMaxCapped;
    line.plain_english = _explainDownPlain(line);

    if (!inNetwork) {
      line.reasons.push('Out-of-network — balance billing may apply above the carrier\'s allowed amount.');
    }
    if (benefit?.requires_preauth) {
      line.reasons.push('Pre-authorization required before scheduling — confirm with carrier.');
    }

    result.lines.push(line);
    result.totals.usual_fees += fee;
    result.totals.carrier_pays += carrierPays;
    result.totals.patient_pays += patientPays;
    result.totals.deductible_applied += deductibleFromThis;
  }

  // ── COB cascade — apply secondary insurance if present (PT-0006 scenario)
  // Mock uses `has_other_coverage` + `secondary` block; older shapes used
  // `has_secondary`. Support both.
  const cob = record.coordination_of_benefits || {};
  const hasSecondary = (cob.has_other_coverage === true || cob.has_secondary === true) && cob.secondary;
  if (hasSecondary) {
    const sec = cob.secondary;
    const order = cob.this_plan_order || 'primary';
    const remaining = result.totals.patient_pays;

    // ── Secondary estimator (standard-COB method).
    // We don't have the secondary's full benefit detail in the mock — only
    // its identity + a "may cover up to its own allowable" note. Apply a
    // sensible heuristic that the demo can refine when the secondary's
    // benefit detail is available:
    //   - In standard COB, secondary pays MIN(patient_responsibility,
    //     (secondary's_allowable * secondary's_coverage_percent) - what_primary_already_paid)
    //   - Without the secondary's benefit table, we use:
    //       secondary_estimate = remaining × secondary_assumed_coverage_pct
    //     with secondary_assumed_coverage_pct configurable (default 50%).
    //   - This is labeled ESTIMATE in the result so the demo never fabricates.
    const secondaryAssumedPct = (cob.secondary_assumed_coverage_pct != null)
      ? cob.secondary_assumed_coverage_pct
      : (sec.coverage_assumption_percent != null ? sec.coverage_assumption_percent : 50);
    const secondaryEstimate = Math.round(remaining * (secondaryAssumedPct / 100) * 100) / 100;
    const finalPatientOOP = Math.max(0, remaining - secondaryEstimate);

    result.annotations.push(
      'Coordination of Benefits: this plan is ' + order + '; secondary is ' + (sec.name || sec.plan_name || 'unknown') +
      ' (' + (sec.payer_id || '?') + ', member ' + (sec.member_id || '?') + ', ' +
      (sec.subscriber_relationship || 'unknown relationship') + '). ' +
      'Patient responsibility after primary: $' + remaining.toFixed(2) + '. ' +
      'Estimated secondary contribution (' + secondaryAssumedPct + '% of remaining): $' + secondaryEstimate.toFixed(2) + '. ' +
      'Final estimated patient OOP: $' + finalPatientOOP.toFixed(2) + '. ' +
      (sec.note || 'Submit primary EOB with secondary claim for the actual figure.')
    );
    result.cob = {
      this_plan_order: order,
      secondary: { name: sec.name, payer_id: sec.payer_id, member_id: sec.member_id },
      patient_responsibility_after_primary: remaining,
      secondary_assumed_coverage_pct: secondaryAssumedPct,
      secondary_estimated_contribution: secondaryEstimate,
      final_estimated_patient_oop: finalPatientOOP,
      estimate_method: 'standard_cob_heuristic',
      caveat: 'Heuristic: secondary plan benefit detail not loaded; this is an ESTIMATE pending real secondary EOB.'
    };
    // Surface the final estimated OOP at totals level too
    result.totals.patient_pays_after_secondary_estimate = finalPatientOOP;
  }

  result.totals.annual_max_used = annualMaxStart - annualMaxRemaining;
  result.totals.annual_max_remaining_after = annualMaxRemaining === Infinity ? null : annualMaxRemaining;

  if (record.payer && record.payer.plan_type === 'DHMO') result.annotations.push('Plan is DHMO copay-schedule — no annual max, no percent coverage.');
  if (record.limitations && record.limitations.waiting_periods_active) result.annotations.push('Some procedures are still in their waiting period; recheck dates before scheduling.');

  return result;
}

module.exports = { verifyTreatmentPlan };
