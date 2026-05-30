// lib/spcEngine.cjs — SPC p-chart + Western Electric rules for no-show risk.
//
// Per patient, build a time-ordered binary series:
//   1 = missed (no_show OR cancelled_same_day)
//   0 = attended (kept OR kept_late)
// (cancelled_in_advance is excluded — patient gave notice, not a no-show)
//
// Compute:
//   - p_bar       = overall mean (no-show rate)
//   - sigma_p     = sqrt(p_bar(1-p_bar)/n) for individuals (n=1 since each appt is one trial)
//                   In practice we use the binary series itself; control limits are
//                   centerline ± k * stddev of the moving statistic.
//                 For a Bernoulli individuals chart, σ = sqrt(p̄(1-p̄)).
//   - UCL/LCL     = p_bar ± 3σ (bounded to [0,1])
//   - WE rule findings — Western Electric Rules 1-8 applied to the series.
//
// Output: { patient_id, n, p_bar, sigma, ucl, lcl, series, points_outside_3sigma,
//           we_rules_triggered: [{rule, idx_range, description}],
//           risk_score: 0..1 (probability the next appointment will be missed),
//           risk_band: 'low' | 'moderate' | 'high' | 'critical' }
//
// The risk_score combines:
//   - Centerline p̄ (long-run rate)
//   - WE rule severity (special-cause penalty)
//   - Recency weighting (last 5 appointments weighted higher than full history)

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'clinic.db');

function _db() { return new Database(DB_PATH, { readonly: true }); }

function _seriesForPatient(db, patientId) {
  const rows = db.prepare(`
    SELECT scheduled_at, outcome
    FROM appointments
    WHERE patient_id = ?
      AND outcome != 'scheduled'
      AND outcome != 'cancelled_in_advance'
    ORDER BY scheduled_at ASC
  `).all(patientId);
  return rows.map(r => ({
    at: r.scheduled_at,
    missed: (r.outcome === 'no_show' || r.outcome === 'cancelled_same_day') ? 1 : 0
  }));
}

// ── Western Electric Rules 1-8 (applied to a binary {0,1} series with centerline p̄)
// For a Bernoulli series we use σ = sqrt(p̄(1-p̄)). The "zones" are:
//   Zone C: centerline ± 1σ
//   Zone B: 1σ to 2σ
//   Zone A: 2σ to 3σ
// For binary data the zones often collapse; we still apply the rules pragmatically:
//   - Rule 1: any point > p̄ + 3σ → almost always means a streak of 1s in low-p̄ patient
//   - Rule 2: 9 consecutive on same side of centerline (above → trending bad)
//   - Rule 3: 6 consecutive trending up (cumulative missed count rising) or down
//   - Rule 4: 14 in a row alternating up/down (instability)
//   - Rule 5: 2 of 3 outside 2σ on same side → big swing above mean
//   - Rule 6: 4 of 5 outside 1σ on same side
//   - Rule 7: 15 in a row within 1σ → unusually consistent (could be either)
//   - Rule 8: 8 in a row outside 1σ on either side → bimodal / unstable
function _applyWERules(series, pBar, sigma) {
  if (series.length < 8) return [];
  const findings = [];
  const vals = series.map(s => s.missed);
  const ucl = Math.min(1, pBar + 3 * sigma);
  const lcl = Math.max(0, pBar - 3 * sigma);
  const upper2s = Math.min(1, pBar + 2 * sigma);
  const lower2s = Math.max(0, pBar - 2 * sigma);
  const upper1s = Math.min(1, pBar + 1 * sigma);
  const lower1s = Math.max(0, pBar - 1 * sigma);

  // Rule 1 — any single point outside ±3σ
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > ucl + 1e-9 || vals[i] < lcl - 1e-9) {
      findings.push({ rule: 1, severity: 'critical', idx: i, description: 'Point ' + (i+1) + ' is outside ±3σ control limits (special-cause variation).' });
    }
  }
  // Rule 2 — 9 consecutive on same side of centerline
  let above = 0, below = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > pBar) { above++; below = 0; }
    else if (vals[i] < pBar) { below++; above = 0; }
    else { above = 0; below = 0; }
    if (above >= 9) {
      findings.push({ rule: 2, severity: 'major', idx_range: [i-8, i], description: '9 consecutive points above centerline — shift in no-show rate upward.' });
      above = 0;
    }
    if (below >= 9) {
      findings.push({ rule: 2, severity: 'minor', idx_range: [i-8, i], description: '9 consecutive points below centerline — sustained reliability.' });
      below = 0;
    }
  }
  // Rule 3 — 6 consecutive trending up or down (apply to running average instead of raw 0/1)
  // For Bernoulli, use a cumulative-rate trend: running_rate[i] = sum(vals[0..i])/i+1
  let cum = 0;
  const runRate = vals.map((v, i) => { cum += v; return cum / (i + 1); });
  let up = 1, down = 1;
  for (let i = 1; i < runRate.length; i++) {
    if (runRate[i] > runRate[i-1]) { up++; down = 1; }
    else if (runRate[i] < runRate[i-1]) { down++; up = 1; }
    else { up = 1; down = 1; }
    if (up >= 6) {
      findings.push({ rule: 3, severity: 'major', idx_range: [i-5, i], description: 'Running no-show rate trending UP for 6 consecutive appointments — getting worse.' });
      up = 1;
    }
    if (down >= 6) {
      findings.push({ rule: 3, severity: 'minor', idx_range: [i-5, i], description: 'Running no-show rate trending DOWN for 6 consecutive appointments — improving.' });
      down = 1;
    }
  }
  // Rule 4 — 14 in a row alternating up/down
  let alt = 1, lastDir = 0;
  for (let i = 1; i < vals.length; i++) {
    const dir = vals[i] === vals[i-1] ? 0 : (vals[i] > vals[i-1] ? 1 : -1);
    if (dir !== 0 && dir !== lastDir && lastDir !== 0) alt++;
    else if (dir === 0) alt = 1;
    else alt = 2;
    lastDir = dir;
    if (alt >= 14) {
      findings.push({ rule: 4, severity: 'major', idx_range: [i-13, i], description: '14 consecutive alternating points — unstable / erratic pattern.' });
      alt = 1;
    }
  }
  // Rule 5 — 2 out of 3 outside 2σ on same side
  for (let i = 2; i < vals.length; i++) {
    const window = vals.slice(i-2, i+1);
    const aboveCount = window.filter(v => v > upper2s + 1e-9).length;
    const belowCount = window.filter(v => v < lower2s - 1e-9).length;
    if (aboveCount >= 2) {
      findings.push({ rule: 5, severity: 'major', idx_range: [i-2, i], description: '2 of 3 points beyond +2σ — shift upward.' });
    }
    if (belowCount >= 2) {
      findings.push({ rule: 5, severity: 'minor', idx_range: [i-2, i], description: '2 of 3 points beyond -2σ — shift downward.' });
    }
  }
  // Rule 6 — 4 of 5 outside 1σ on same side
  for (let i = 4; i < vals.length; i++) {
    const window = vals.slice(i-4, i+1);
    const aboveCount = window.filter(v => v > upper1s + 1e-9).length;
    const belowCount = window.filter(v => v < lower1s - 1e-9).length;
    if (aboveCount >= 4) {
      findings.push({ rule: 6, severity: 'minor', idx_range: [i-4, i], description: '4 of 5 points beyond +1σ — emerging upward shift.' });
    }
    if (belowCount >= 4) {
      findings.push({ rule: 6, severity: 'info', idx_range: [i-4, i], description: '4 of 5 points beyond -1σ — emerging downward shift.' });
    }
  }
  // Rule 7 — 15 in a row within 1σ (stratification / unusually consistent)
  if (vals.length >= 15) {
    for (let i = 14; i < vals.length; i++) {
      const window = vals.slice(i-14, i+1);
      const allInner = window.every(v => v >= lower1s - 1e-9 && v <= upper1s + 1e-9);
      if (allInner) {
        findings.push({ rule: 7, severity: 'info', idx_range: [i-14, i], description: '15 consecutive points within ±1σ — unusual consistency (possible measurement-system issue).' });
        break;
      }
    }
  }
  // Rule 8 — 8 in a row outside ±1σ on either side (bimodal / over-control)
  let outside1sStreak = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] > upper1s + 1e-9 || vals[i] < lower1s - 1e-9) outside1sStreak++;
    else outside1sStreak = 0;
    if (outside1sStreak >= 8) {
      findings.push({ rule: 8, severity: 'minor', idx_range: [i-7, i], description: '8 consecutive points outside ±1σ — bimodal / over-correction pattern.' });
      outside1sStreak = 0;
    }
  }
  return findings;
}

function _riskScore(series, pBar, weFindings, recentWindow = 5) {
  // Weight recent appointments more heavily (recency bias).
  if (series.length === 0) return { score: 0.10, band: 'low', breakdown: { reason: 'no history' } };
  const recent = series.slice(-recentWindow);
  const recentRate = recent.reduce((s, x) => s + x.missed, 0) / recent.length;
  // Combine long-run (40%) + recent (50%) + WE rule penalty (10%)
  let wePenalty = 0;
  for (const f of weFindings) {
    if (f.severity === 'critical') wePenalty += 0.10;
    else if (f.severity === 'major') wePenalty += 0.06;
    else if (f.severity === 'minor') wePenalty += 0.02;
  }
  // Only penalize for "bad-direction" rules (upward shifts toward no-show)
  // Heuristic: penalty is positive when recent rate > p_bar
  const directionalPenalty = recentRate > pBar ? wePenalty : -wePenalty * 0.3;
  let score = 0.40 * pBar + 0.50 * recentRate + directionalPenalty;
  score = Math.max(0, Math.min(1, score));
  let band;
  if (score < 0.10) band = 'low';
  else if (score < 0.25) band = 'moderate';
  else if (score < 0.50) band = 'high';
  else band = 'critical';
  return {
    score,
    band,
    breakdown: {
      p_bar: pBar,
      recent_rate: recentRate,
      recent_window: recent.length,
      we_penalty: directionalPenalty,
      n_we_findings: weFindings.length,
    }
  };
}

function analyzePatient(patientId) {
  const db = _db();
  try {
    const patient = db.prepare('SELECT * FROM clinic_patients WHERE patient_id = ?').get(patientId);
    if (!patient) return null;
    const series = _seriesForPatient(db, patientId);
    const n = series.length;
    if (n === 0) {
      return {
        patient_id: patientId, patient,
        n: 0, p_bar: null, sigma: null, ucl: null, lcl: null,
        series: [], we_rules_triggered: [],
        risk: { score: 0.15, band: 'low', breakdown: { reason: 'no completed appointments yet' } }
      };
    }
    const sum = series.reduce((s, x) => s + x.missed, 0);
    const pBar = sum / n;
    const sigma = Math.sqrt(pBar * (1 - pBar)); // Bernoulli individuals σ
    const ucl = Math.min(1, pBar + 3 * sigma);
    const lcl = Math.max(0, pBar - 3 * sigma);
    const weFindings = _applyWERules(series, pBar, sigma);
    const risk = _riskScore(series, pBar, weFindings);
    return {
      patient_id: patientId,
      patient: {
        patient_id: patient.patient_id, first_name: patient.first_name, last_name: patient.last_name,
        age: patient.age, risk_archetype: patient.risk_archetype, preferred_channel: patient.preferred_channel,
        phone: patient.phone, email: patient.email, last_cleaning_date: patient.last_cleaning_date,
        recall_interval_months: patient.recall_interval_months
      },
      n, p_bar: pBar, sigma, ucl, lcl,
      zones: {
        upper_3s: ucl, upper_2s: Math.min(1, pBar + 2 * sigma), upper_1s: Math.min(1, pBar + 1 * sigma),
        centerline: pBar,
        lower_1s: Math.max(0, pBar - 1 * sigma), lower_2s: Math.max(0, pBar - 2 * sigma), lower_3s: lcl
      },
      series,
      we_rules_triggered: weFindings,
      risk
    };
  } finally {
    db.close();
  }
}

function rankAllPatients(opts) {
  opts = opts || {};
  const db = _db();
  try {
    const patientIds = db.prepare('SELECT patient_id FROM clinic_patients').all().map(r => r.patient_id);
    db.close();
    const results = [];
    for (const pid of patientIds) {
      const r = analyzePatient(pid);
      if (r) {
        results.push({
          patient_id: pid,
          name: r.patient.first_name + ' ' + r.patient.last_name,
          archetype: r.patient.risk_archetype,
          n: r.n,
          p_bar: r.p_bar,
          risk_score: r.risk.score,
          risk_band: r.risk.band,
          we_rules_count: r.we_rules_triggered.length,
          we_critical_count: r.we_rules_triggered.filter(f => f.severity === 'critical').length,
          we_major_count: r.we_rules_triggered.filter(f => f.severity === 'major').length,
          channel: r.patient.preferred_channel,
          last_cleaning_date: r.patient.last_cleaning_date,
          recall_interval_months: r.patient.recall_interval_months,
        });
      }
    }
    results.sort((a, b) => b.risk_score - a.risk_score);
    if (opts.band) return results.filter(r => r.risk_band === opts.band);
    if (opts.limit) return results.slice(0, opts.limit);
    return results;
  } catch (e) {
    db.close();
    throw e;
  }
}

module.exports = { analyzePatient, rankAllPatients, DB_PATH };

// CLI: node lib/spcEngine.cjs <patient_id> | --top
if (require.main === module) {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node lib/spcEngine.cjs <patient_id> | --top [N] | --band high|critical|moderate|low');
    process.exit(1);
  }
  if (arg === '--top') {
    const limit = parseInt(process.argv[3] || '20', 10);
    const r = rankAllPatients({ limit });
    console.log(('Patient').padEnd(10) + ('Name').padEnd(24) + ('Arch').padEnd(11) + 'n   p̄     risk   band     WE');
    for (const p of r) {
      console.log(p.patient_id.padEnd(10) + p.name.padEnd(24) + p.archetype.padEnd(11) +
        String(p.n).padEnd(4) + (p.p_bar*100).toFixed(0).padStart(3) + '%   ' +
        (p.risk_score*100).toFixed(0).padStart(3) + '%   ' + p.risk_band.padEnd(9) +
        p.we_rules_count + ' (' + p.we_critical_count + ' crit, ' + p.we_major_count + ' major)');
    }
  } else if (arg === '--band') {
    const band = process.argv[3];
    const r = rankAllPatients({ band });
    console.log('Patients in band "' + band + '": ' + r.length);
    for (const p of r.slice(0, 30)) console.log('  ' + p.patient_id + '  ' + p.name + '  risk=' + (p.risk_score*100).toFixed(0) + '%  archetype=' + p.archetype);
  } else {
    const r = analyzePatient(arg);
    if (!r) { console.error('Patient not found'); process.exit(1); }
    console.log('Patient:', r.patient.first_name, r.patient.last_name, '(' + r.patient_id + ')');
    console.log('Archetype:', r.patient.risk_archetype);
    console.log('Appointments analyzed:', r.n);
    console.log('p̄ (long-run no-show rate):', r.p_bar !== null ? (r.p_bar*100).toFixed(1) + '%' : 'n/a');
    if (r.p_bar !== null) {
      console.log('σ:', r.sigma.toFixed(3), ' UCL:', r.ucl.toFixed(3), ' LCL:', r.lcl.toFixed(3));
    }
    console.log('Risk:', (r.risk.score*100).toFixed(0) + '% (' + r.risk.band + ')');
    console.log('  breakdown:', JSON.stringify(r.risk.breakdown));
    console.log('Western Electric rules triggered:', r.we_rules_triggered.length);
    for (const f of r.we_rules_triggered.slice(0, 10)) console.log('  [Rule ' + f.rule + ', ' + f.severity + '] ' + f.description);
  }
}
