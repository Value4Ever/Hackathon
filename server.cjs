// _hackathon_dental/server.cjs — Node API server (no framework, built-in http).
// Mirrors the production-shaped mock vendor endpoints + adds /v1/verify which
// runs the verification engine over a treatment plan and returns the breakdown.

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const db = require('./db.cjs');
const { verifyTreatmentPlan } = require('./verifyEngine.cjs');
const { classifyEligibilityFailure, classifyVerifyExceptions, executeContact } = require('./exceptionRouter.cjs');
const Database = require('better-sqlite3');
const hipaa = require('./lib/hipaaControls.cjs');
const audit = require('./lib/phiAuditLog.cjs');

// ── HIPAA: extract session from request + audit context
function _authContext(req) {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '') || req.headers?.['x-session-token'] || null;
  const session = hipaa.validateSession(token);
  const ctx = audit.extractContext(req);
  return { session, ip: ctx.ip_address, user_agent: ctx.user_agent };
}
function _requireAuth(req, res) {
  const auth = _authContext(req);
  if (!auth.session) {
    send(res, 401, { error: 'unauthenticated', message: 'Login required. POST /v1/auth/login.' });
    return null;
  }
  return auth;
}

// ── Action log (SQLite) — every exception-driven contact recorded
const ACTION_DB_PATH = path.join(__dirname, 'eligibility.db');
function _actionDb() {
  const adb = new Database(ACTION_DB_PATH);
  adb.exec(`
    CREATE TABLE IF NOT EXISTS action_log (
      action_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      patient_id TEXT,
      exception_code TEXT,
      channel TEXT,
      template_id TEXT,
      target TEXT,
      status TEXT,
      body_preview TEXT,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_action_patient ON action_log(patient_id);
  `);
  return adb;
}

const PORT = parseInt(process.env.PORT || '8765', 10);
const UI_DIR = path.join(__dirname, 'ui');

// In-memory call session store (multi-agent orchestrator state)
const _intakeSessions = {};

function send(res, status, body, contentType) {
  res.writeHead(status, {
    'Content-Type': contentType || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', c => { chunks += c; });
    req.on('end', () => {
      if (!chunks) return resolve({});
      try { resolve(JSON.parse(chunks)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function staticFile(res, fileName) {
  const p = path.join(UI_DIR, fileName);
  if (!fs.existsSync(p)) return send(res, 404, { error: 'not_found', path: fileName });
  const ext = path.extname(fileName).toLowerCase();
  const ct = ext === '.html' ? 'text/html; charset=utf-8'
           : ext === '.css'  ? 'text/css'
           : ext === '.js'   ? 'application/javascript'
           : 'application/octet-stream';
  send(res, 200, fs.readFileSync(p, 'utf8'), ct);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const u = url.parse(req.url, true);

  // ── Static UI
  if (u.pathname === '/' || u.pathname === '/index.html') return staticFile(res, 'hub.html');
  if (u.pathname === '/verifier' || u.pathname === '/verifier.html') return staticFile(res, 'index.html');
  if (u.pathname === '/clinic' || u.pathname === '/clinic.html') return staticFile(res, 'clinic.html');
  if (u.pathname === '/inbound' || u.pathname === '/inbound.html') return staticFile(res, 'inbound.html');
  if (u.pathname === '/demo' || u.pathname === '/demo.html') return staticFile(res, 'demo.html');
  if (u.pathname.startsWith('/ui/')) return staticFile(res, u.pathname.slice(4));

  // ── Health (no PHI, no auth required)
  if (u.pathname === '/health') {
    const patients = db.listPatients();
    return send(res, 200, { ok: true, patient_count: patients.length, port: PORT, hipaa_mode: true });
  }

  // ──────────────────────────────────────────────────────────────────
  // HIPAA: Auth + audit endpoints
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/auth/login' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (_) { body = {}; }
    const r = hipaa.login(body.user_id, body.password);
    audit.log({
      ...audit.extractContext(req),
      user_id: body.user_id || 'anonymous',
      action: 'login_attempt',
      result: r.ok ? 'success' : 'fail',
      detail: r.ok ? null : r.error
    });
    if (!r.ok) return send(res, 401, r);
    return send(res, 200, { ok: true, token: r.session.token, user_id: r.session.user_id, role: r.session.role, name: r.session.name, expires_in_ms: hipaa.SESSION_TIMEOUT_MS });
  }
  if (u.pathname === '/v1/auth/logout' && req.method === 'POST') {
    const auth = _authContext(req);
    if (auth.session) {
      audit.log({ ip_address: auth.ip, user_agent: auth.user_agent, user_id: auth.session.user_id, user_role: auth.session.role, session_id: auth.session.token, action: 'logout', result: 'success' });
      hipaa.logout(auth.session.token);
    }
    return send(res, 200, { ok: true });
  }
  if (u.pathname === '/v1/auth/me' && req.method === 'GET') {
    const auth = _authContext(req);
    if (!auth.session) return send(res, 401, { authenticated: false });
    return send(res, 200, { authenticated: true, user_id: auth.session.user_id, role: auth.session.role, name: auth.session.name, expires_at: new Date(auth.session.expires_at).toISOString() });
  }
  if (u.pathname === '/v1/auth/users' && req.method === 'GET') {
    return send(res, 200, { users: hipaa.listUsers() });
  }

  // HIPAA: PHI audit log — viewable by office_mgr role only
  if (u.pathname === '/v1/audit/log' && req.method === 'GET') {
    const auth = _requireAuth(req, res); if (!auth) return;
    if (auth.session.role !== 'office_mgr' && auth.session.role !== 'dentist') {
      audit.log({ ip_address: auth.ip, user_agent: auth.user_agent, user_id: auth.session.user_id, user_role: auth.session.role, action: 'audit_log_access_denied', result: 'fail' });
      return send(res, 403, { error: 'forbidden', message: 'Audit log access restricted to office_mgr and dentist roles.' });
    }
    const params = u.query || {};
    const entries = audit.queryLog({ user_id: params.user_id, target_id: params.target_id, action: params.action, since: params.since, limit: params.limit ? parseInt(params.limit, 10) : 200 });
    audit.log({ ip_address: auth.ip, user_agent: auth.user_agent, user_id: auth.session.user_id, user_role: auth.session.role, session_id: auth.session.token, action: 'audit_log_query', result: 'success', detail: { count: entries.length } });
    return send(res, 200, { count: entries.length, entries });
  }

  // HIPAA: Suspicious-access detection
  if (u.pathname === '/v1/audit/suspicious' && req.method === 'GET') {
    const auth = _requireAuth(req, res); if (!auth) return;
    if (auth.session.role !== 'office_mgr' && auth.session.role !== 'dentist') return send(res, 403, { error: 'forbidden' });
    const flags = audit.detectSuspicious({ lookback_hours: 24 });
    return send(res, 200, { flags, lookback_hours: 24 });
  }

  // ──────────────────────────────────────────────────────────────────
  // 21 CFR Part 11 — Electronic Signatures
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/esig/sign' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (_) { body = {}; }
    const auth = _authContext(req);
    const ctx = audit.extractContext(req);
    const eSig = require('./lib/eSignature.cjs');
    try {
      // Part 11 §11.200 — re-authenticate before signing (two-component)
      const result = eSig.signWithReauth({
        user_id: body.user_id, password: body.password,
        meaning: body.meaning, record_resource: body.record_resource,
        record_id: body.record_id, record_snapshot: body.record_snapshot,
        ip_address: ctx.ip_address, user_agent: ctx.user_agent
      });
      audit.log({
        ip_address: ctx.ip_address, user_agent: ctx.user_agent,
        user_id: body.user_id, user_role: auth.session?.role || 'unknown',
        session_id: auth.session?.token,
        action: 'e_signature_created', target_resource: body.record_resource, target_id: body.record_id,
        purpose_of_use: 'attestation', result: 'success',
        detail: { signature_id: result.signature_id, meaning: result.meaning, signature_hash: result.signature_hash.slice(0, 16) + '...' }
      });
      return send(res, 200, result);
    } catch (e) {
      audit.log({ ip_address: ctx.ip_address, user_id: body.user_id || 'unknown', action: 'e_signature_attempt', result: 'fail', detail: e.message });
      return send(res, 400, { error: e.message });
    }
  }
  if (u.pathname === '/v1/esig/chain' && req.method === 'GET') {
    const auth = _requireAuth(req, res); if (!auth) return;
    if (auth.session.role !== 'office_mgr' && auth.session.role !== 'dentist') return send(res, 403, { error: 'forbidden' });
    const eSig = require('./lib/eSignature.cjs');
    return send(res, 200, eSig.verifyChain());
  }
  const sigForRecord = u.pathname.match(/^\/v1\/esig\/record\/([^/]+)\/([^/]+)$/);
  if (sigForRecord && req.method === 'GET') {
    const auth = _requireAuth(req, res); if (!auth) return;
    const eSig = require('./lib/eSignature.cjs');
    audit.log({ ip_address: auth.ip, user_id: auth.session.user_id, user_role: auth.session.role, session_id: auth.session.token, action: 'read', target_resource: 'e_signatures', target_id: sigForRecord[1] + ':' + sigForRecord[2], purpose_of_use: 'verification', result: 'success' });
    return send(res, 200, { signatures: eSig.listForRecord(sigForRecord[1], sigForRecord[2]) });
  }

  // HIPAA: Patient self-access (right of access under §164.524 — 30-day clock)
  // For demo: pass patient_id directly; production binds to authenticated patient principal.
  if (u.pathname.match(/^\/v1\/patient\/([^/]+)\/export$/) && req.method === 'GET') {
    const patientId = u.pathname.match(/^\/v1\/patient\/([^/]+)\/export$/)[1];
    const auth = _authContext(req);
    const Database2 = require('better-sqlite3');
    const cdb2 = new Database2(path.join(__dirname, 'clinic.db'), { readonly: true });
    try {
      const p = cdb2.prepare('SELECT * FROM clinic_patients WHERE patient_id = ?').get(patientId);
      if (!p) return send(res, 404, { error: 'patient_not_found' });
      const appts = cdb2.prepare('SELECT * FROM appointments WHERE patient_id = ?').all(patientId);
      const tx = cdb2.prepare('SELECT * FROM treatments WHERE patient_id = ?').all(patientId);
      const pay = cdb2.prepare('SELECT * FROM payments WHERE patient_id = ?').all(patientId);
      const com = cdb2.prepare('SELECT * FROM communications WHERE patient_id = ?').all(patientId);
      audit.log({
        ip_address: audit.extractContext(req).ip_address,
        user_id: auth.session?.user_id || 'patient_self',
        user_role: auth.session?.role || 'patient',
        session_id: auth.session?.token,
        action: 'export',
        target_resource: 'patient_full_record',
        target_id: patientId,
        purpose_of_use: 'patient_request',
        result: 'success',
        detail: { appts: appts.length, treatments: tx.length, payments: pay.length, communications: com.length }
      });
      return send(res, 200, {
        export_generated_at: new Date().toISOString(),
        right_of_access_basis: '45 CFR §164.524',
        patient: p,
        appointments: appts,
        treatments: tx,
        payments: pay,
        communications: com,
        export_note: 'You may request corrections under 45 CFR §164.526. To file a complaint, contact OCR at hhs.gov/ocr or the practice Privacy Officer.'
      });
    } finally { cdb2.close(); }
  }


  // ── List patients (dev convenience — matches mock API)
  if (u.pathname === '/v1/patients' && req.method === 'GET') {
    return send(res, 200, { patients: db.listPatients() });
  }

  // ── Get one patient by patient_id
  const m = u.pathname.match(/^\/v1\/patients\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const r = db.getByPatientId(m[1]);
    if (!r) return send(res, 404, { error: 'patient_not_found', patient_id: m[1] });
    return send(res, 200, r);
  }

  // ── Eligibility (production-shaped lookup)
  if (u.pathname === '/v1/eligibility' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalid_json' }); }
    let rec = null;
    if (body.member_id) rec = db.getByMemberId(body.member_id);
    if (!rec && body.first_name && body.last_name && body.date_of_birth) {
      rec = db.findByNameDob(body.first_name, body.last_name, body.date_of_birth, body.payer_id);
    }
    if (!rec) {
      // Auto-classify the failure + return action plan
      const exceptions = classifyEligibilityFailure(body, db.listPatients());
      return send(res, 200, {
        verification: { source: 'mock', status: 'MEMBER_NOT_FOUND' },
        query: body,
        message: 'No matching member found with the supplied identifiers.',
        exceptions
      });
    }
    return send(res, 200, rec);
  }

  // ── Exceptions — classify a query OR a verify result, return action plan
  if (u.pathname === '/v1/exceptions/route' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalid_json' }); }
    const exceptions = [];
    if (body.query) {
      const eligExc = classifyEligibilityFailure(body.query, db.listPatients());
      exceptions.push(...eligExc);
    }
    if (body.verify_result) {
      const verExc = classifyVerifyExceptions(body.verify_result);
      exceptions.push(...verExc);
    }
    return send(res, 200, { exceptions });
  }

  // ── Exceptions — execute a contact (mock: log + return receipt)
  if (u.pathname === '/v1/exceptions/contact' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.action) return send(res, 400, { error: 'action_required' });
    const receipt = executeContact(body.action, body.context || {});
    // Persist to action_log
    try {
      const adb = _actionDb();
      adb.prepare(`INSERT INTO action_log (action_id, created_at, patient_id, exception_code, channel, template_id, target, status, body_preview, payload_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        receipt.action_id, receipt.sent_at, body.patient_id || null, body.exception_code || null,
        receipt.channel, receipt.template_id, receipt.target, receipt.status, receipt.body_preview,
        JSON.stringify({ action: body.action, context: body.context })
      );
      adb.close();
    } catch (e) { /* non-blocking */ }
    return send(res, 200, receipt);
  }

  // ── Exceptions — action log (for audit + UI)
  if (u.pathname === '/v1/exceptions/log' && req.method === 'GET') {
    const adb = _actionDb();
    const rows = adb.prepare(`SELECT * FROM action_log ORDER BY created_at DESC LIMIT 100`).all();
    adb.close();
    return send(res, 200, { actions: rows });
  }

  // ── Verify a treatment plan against a patient's eligibility
  if (u.pathname === '/v1/verify' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalid_json' }); }
    let rec = null;
    if (body.patient_id) rec = db.getByPatientId(body.patient_id);
    if (!rec && body.member_id) rec = db.getByMemberId(body.member_id);
    if (!rec && body.first_name && body.last_name && body.date_of_birth) {
      rec = db.findByNameDob(body.first_name, body.last_name, body.date_of_birth, body.payer_id);
    }
    if (!rec) return send(res, 404, { error: 'patient_not_found', query: body });
    if (!Array.isArray(body.treatment_plan) || body.treatment_plan.length === 0) {
      return send(res, 400, { error: 'treatment_plan_required', hint: 'Send { treatment_plan: [{ada_code, fee}, ...] }' });
    }
    const result = verifyTreatmentPlan(rec, body.treatment_plan, {
      as_of_date: body.as_of_date,
      in_network_override: body.in_network_override
    });
    // Auto-classify per-line exceptions (terminated, OON, waiting period,
    // frequency, missing tooth, preauth, COB) so the UI gets an action plan.
    result.exceptions = classifyVerifyExceptions(result);
    return send(res, 200, result);
  }

  // ──────────────────────────────────────────────────────────────────
  // ELEVENLABS TTS — voice for the demo
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/tts' && req.method === 'POST') {
    try {
      let body; try { body = await readBody(req); } catch (_) { body = {}; }
      const tts = require('./lib/ttsElevenLabs.cjs');
      if (!tts.getApiKey()) return send(res, 503, { error: 'elevenlabs_key_missing', message: 'POST /v1/tts/key with {key:"..."} to configure.' });
      const result = await tts.synthesize(body.text || '', { role: body.role, voice_id: body.voice_id });
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': result.mp3.length,
        'X-Voice-Persona': result.persona,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Voice-Persona'
      });
      res.end(result.mp3);
      return;
    } catch (e) { return send(res, 500, { error: 'tts_failed', detail: e.message }); }
  }
  if (u.pathname === '/v1/tts/voices' && req.method === 'GET') {
    const tts = require('./lib/ttsElevenLabs.cjs');
    return send(res, 200, { configured: !!tts.getApiKey(), personas: tts.listPersonas() });
  }
  if (u.pathname === '/v1/tts/key' && req.method === 'POST') {
    let body; try { body = await readBody(req); } catch (_) { body = {}; }
    if (!body.key) return send(res, 400, { error: 'key_required' });
    const tts = require('./lib/ttsElevenLabs.cjs');
    tts.setApiKey(body.key);
    return send(res, 200, { ok: true, message: 'ElevenLabs key stored in clinic.db::meta.config' });
  }

  // ──────────────────────────────────────────────────────────────────
  // DEMO RUNNER — scripted end-to-end demo
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/demo/script' && req.method === 'GET') {
    try {
      const { buildScript } = require('./lib/demoRunner.cjs');
      const script = buildScript({}).map(s => ({ step: s.step, time_offset_ms: s.time_offset_ms, scene: s.scene, title: s.title, description: s.description }));
      return send(res, 200, { steps: script });
    } catch (e) { return send(res, 500, { error: 'demo_failed', detail: e.message }); }
  }
  if (u.pathname === '/v1/demo/run' && req.method === 'POST') {
    try {
      let body; try { body = await readBody(req); } catch (_) { body = {}; }
      const { runScript } = require('./lib/demoRunner.cjs');
      // For HTTP, run synchronously and return the full result
      runScript({ speed: body.speed || 'fast' }).then(r => send(res, 200, r)).catch(e => send(res, 500, { error: e.message }));
      return;
    } catch (e) { return send(res, 500, { error: 'demo_failed', detail: e.message }); }
  }
  if (u.pathname === '/v1/demo/messages' && req.method === 'GET') {
    try {
      const { listMessages } = require('./lib/messagingChannels.cjs');
      const params = u.query || {};
      const messages = listMessages({ channel: params.channel, audience: params.audience, limit: params.limit ? parseInt(params.limit, 10) : 100 });
      return send(res, 200, { count: messages.length, messages });
    } catch (e) { return send(res, 500, { error: 'msg_failed', detail: e.message }); }
  }

  // ──────────────────────────────────────────────────────────────────
  // INBOUND CALL ORCHESTRATOR — multi-agent flow per whiteboard
  // (Intake → Insurance → Cost Estimate → Scheduling → Confirmation)
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/intake/inbound' && req.method === 'POST') {
    try {
      let body; try { body = await readBody(req); } catch (_) { body = {}; }
      const { startCall } = require('./lib/agentOrchestrator.cjs');
      const session = startCall(body.caller_phone);
      _intakeSessions[session.session_id] = session;
      return send(res, 200, session);
    } catch (e) { return send(res, 500, { error: 'orchestrator_failed', detail: e.message + '\n' + e.stack.split('\n').slice(0, 3).join(' ') }); }
  }
  if (u.pathname === '/v1/intake/turn' && req.method === 'POST') {
    try {
      let body; try { body = await readBody(req); } catch (_) { body = {}; }
      if (!body.session_id) return send(res, 400, { error: 'session_id_required' });
      const session = _intakeSessions[body.session_id];
      if (!session) return send(res, 404, { error: 'session_not_found' });
      const { processTurn } = require('./lib/agentOrchestrator.cjs');
      const updated = processTurn(session, body.response || { text: body.text });
      _intakeSessions[updated.session_id] = updated;
      return send(res, 200, updated);
    } catch (e) { return send(res, 500, { error: 'orchestrator_failed', detail: e.message + '\n' + e.stack.split('\n').slice(0, 3).join(' ') }); }
  }
  if (u.pathname === '/v1/intake/sessions' && req.method === 'GET') {
    const sessions = Object.values(_intakeSessions).map(s => ({
      session_id: s.session_id, started_at: s.started_at, caller_phone: s.caller_phone,
      patient_status: s.patient_status, state: s.state, completed: s.completed, escalation: s.escalation,
      turn_count: s.transcript.length
    })).sort((a, b) => b.started_at.localeCompare(a.started_at));
    return send(res, 200, { sessions });
  }

  // ──────────────────────────────────────────────────────────────────
  // CLINIC SCHEDULER endpoints (1000-patient mock + SPC + outreach)
  // ──────────────────────────────────────────────────────────────────
  if (u.pathname === '/v1/clinic/patients' && req.method === 'GET') {
    try {
      const { rankAllPatients } = require('./lib/spcEngine.cjs');
      const params = u.query || {};
      const band = params.band || null;
      const limit = params.limit ? parseInt(params.limit, 10) : null;
      const ranked = rankAllPatients({ band, limit });
      return send(res, 200, { count: ranked.length, patients: ranked });
    } catch (e) { return send(res, 500, { error: 'spc_engine_failed', detail: e.message }); }
  }

  const cpMatch = u.pathname.match(/^\/v1\/clinic\/patients\/([^/]+)$/);
  if (cpMatch && req.method === 'GET') {
    try {
      const { analyzePatient } = require('./lib/spcEngine.cjs');
      const r = analyzePatient(cpMatch[1]);
      if (!r) return send(res, 404, { error: 'patient_not_found' });
      return send(res, 200, r);
    } catch (e) { return send(res, 500, { error: 'spc_engine_failed', detail: e.message }); }
  }

  const cpSchedMatch = u.pathname.match(/^\/v1\/clinic\/patients\/([^/]+)\/campaign$/);
  if (cpSchedMatch && req.method === 'GET') {
    try {
      const Database = require('better-sqlite3');
      const cdb = new Database(path.join(__dirname, 'clinic.db'), { readonly: true });
      const p = cdb.prepare('SELECT * FROM clinic_patients WHERE patient_id = ?').get(cpSchedMatch[1]);
      cdb.close();
      if (!p) return send(res, 404, { error: 'patient_not_found' });
      const { analyzePatient } = require('./lib/spcEngine.cjs');
      const { buildCampaign } = require('./lib/schedulerEngine.cjs');
      const spc = analyzePatient(cpSchedMatch[1]);
      const camp = buildCampaign(p, spc);
      return send(res, 200, camp);
    } catch (e) { return send(res, 500, { error: 'scheduler_failed', detail: e.message }); }
  }

  if (u.pathname === '/v1/clinic/schedule/batch' && req.method === 'POST') {
    try {
      let body; try { body = await readBody(req); } catch (_) { body = {}; }
      const { buildBatchCampaign } = require('./lib/schedulerEngine.cjs');
      const campaigns = buildBatchCampaign({ max: body.max || 50, min_risk: body.min_risk || 0 });
      return send(res, 200, { count: campaigns.length, campaigns });
    } catch (e) { return send(res, 500, { error: 'scheduler_failed', detail: e.message }); }
  }

  if (u.pathname === '/v1/clinic/stats' && req.method === 'GET') {
    try {
      const Database = require('better-sqlite3');
      const cdb = new Database(path.join(__dirname, 'clinic.db'), { readonly: true });
      const stats = {
        patients: cdb.prepare('SELECT COUNT(*) as n FROM clinic_patients').get().n,
        appts_total: cdb.prepare('SELECT COUNT(*) as n FROM appointments').get().n,
        appts_no_show: cdb.prepare("SELECT COUNT(*) as n FROM appointments WHERE outcome='no_show'").get().n,
        appts_cancelled_same_day: cdb.prepare("SELECT COUNT(*) as n FROM appointments WHERE outcome='cancelled_same_day'").get().n,
        appts_kept: cdb.prepare("SELECT COUNT(*) as n FROM appointments WHERE outcome='kept' OR outcome='kept_late'").get().n,
        outstanding_payments: cdb.prepare("SELECT COUNT(*) as n, COALESCE(SUM(amount),0) as t FROM payments WHERE status='outstanding'").get(),
        pending_treatment_total: cdb.prepare("SELECT COALESCE(SUM(pending_treatment_value),0) as t FROM clinic_patients WHERE pending_treatment_value > 0").get().t,
        archetypes: cdb.prepare("SELECT risk_archetype, COUNT(*) as n FROM clinic_patients GROUP BY risk_archetype").all(),
      };
      cdb.close();
      return send(res, 200, stats);
    } catch (e) { return send(res, 500, { error: 'stats_failed', detail: e.message }); }
  }

  // ── LLM-powered plain-English explanation of a verify result
  if (u.pathname === '/v1/explain' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'invalid_json' }); }
    if (!body.verify_result) return send(res, 400, { error: 'verify_result required' });
    try {
      const { execSync } = require('child_process');
      const fsx = require('fs');
      const pathx = require('path');
      const SYNC_CALL = pathx.join(__dirname, '..', 'lib', 'sync_llm_call.cjs');
      if (!fsx.existsSync(SYNC_CALL)) return send(res, 500, { error: 'sync_llm_call_unavailable' });
      const tmpDir = pathx.join(__dirname, '_tmp');
      fsx.mkdirSync(tmpDir, { recursive: true });
      const promptFile = pathx.join(tmpDir, 'explain_' + Date.now() + '.txt');
      const systemFile = pathx.join(tmpDir, 'system_' + Date.now() + '.txt');
      const vr = body.verify_result;
      const userPrompt = [
        'A dental patient asked you to explain their coverage breakdown in plain English.',
        '',
        'Patient: ' + (vr.patient?.first_name || '') + ' ' + (vr.patient?.last_name || ''),
        'Payer: ' + (vr.payer?.name || '?') + ' (' + (vr.payer?.plan_type || '?') + ')',
        'Coverage status: ' + vr.coverage_status,
        '',
        'Treatment plan + verdicts:',
        ...vr.lines.map(l => '  • ' + l.ada_code + ' ' + (l.description || '') +
          ' — fee $' + l.usual_fee + ', carrier $' + l.carrier_pays.toFixed(2) +
          ', patient $' + l.patient_pays.toFixed(2) +
          (l.not_covered_reason ? ' — NOT COVERED: ' + l.not_covered_reason : '') +
          (l.reasons && l.reasons.length ? ' — notes: ' + l.reasons.join('; ') : '')
        ),
        '',
        'Totals: usual $' + vr.totals.usual_fees.toFixed(2) +
          ', insurance pays $' + vr.totals.carrier_pays.toFixed(2) +
          ', patient pays $' + vr.totals.patient_pays.toFixed(2),
        vr.cob ? 'COB: secondary may estimate $' + (vr.cob.secondary_estimated_contribution || 0).toFixed(2) + ' contribution; final OOP $' + (vr.cob.final_estimated_patient_oop || 0).toFixed(2) : '',
        '',
        'Annotations: ' + (vr.annotations || []).join(' | '),
        '',
        'Write the patient a 2-paragraph explanation in plain English. Be warm, specific, and direct. Cite the dollar amounts. If there are surprises (frequency limit, waiting period, alt-benefit downgrade, missing-tooth clause, OON), explain WHY in 1 sentence each. End with the bottom-line dollar amount they pay. Do NOT use insurance jargon without defining it.'
      ].filter(Boolean).join('\n');
      const system = 'You are a friendly dental front-desk coordinator explaining insurance benefits to a patient. Translate insurance technical language into plain English. Be honest about uncertainty (estimates, pending data). Keep it to 2 short paragraphs.';
      fsx.writeFileSync(promptFile, userPrompt);
      fsx.writeFileSync(systemFile, system);
      const explanation = execSync(
        'node "' + SYNC_CALL + '" "' + promptFile + '" --system-file="' + systemFile + '" 1500 --task=review_layer',
        { encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
      );
      try { fsx.unlinkSync(promptFile); fsx.unlinkSync(systemFile); } catch (_) {}
      return send(res, 200, { explanation: explanation.trim(), model: 'claude-opus-4-8' });
    } catch (e) {
      return send(res, 500, { error: 'llm_call_failed', detail: (e.message || '').slice(0, 300) });
    }
  }

  send(res, 404, { error: 'not_found', method: req.method, path: u.pathname });
});

server.listen(PORT, () => {
  console.log('Dental verification server running at http://localhost:' + PORT);
  console.log('  GET  /                              — single-page demo UI');
  console.log('  GET  /health                         — liveness + patient count');
  console.log('  GET  /v1/patients                    — list all (dev)');
  console.log('  GET  /v1/patients/:patient_id        — full record');
  console.log('  POST /v1/eligibility                  — vendor-shaped lookup');
  console.log('  POST /v1/verify                       — run engine on a treatment plan');
});
