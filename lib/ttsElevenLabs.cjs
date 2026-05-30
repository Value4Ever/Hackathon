// lib/ttsElevenLabs.cjs — ElevenLabs TTS wrapper for live demo voice.
//
// Each agent persona gets a distinct voice so the demo sounds like a real call:
//   - Intake Agent / Scheduling Agent (Maria)  → Bella  (warm female)
//   - Insurance Agent                          → Adam   (professional male)
//   - Cost Estimate Agent                      → Rachel (clear female)
//   - Doctor (Dr. Chen briefings)              → Antoni (calm male)
//   - Escalation / Human-in-the-loop           → Domi   (firm female)
//   - Patient (when demo plays patient lines)  → Charlotte (light female)
//
// Production: gate with a per-request consent flag (HIPAA §164.508 — TTS-generated
// voice calls to patients require the same consent as agent-spoken human calls).
// ElevenLabs offers a HIPAA-eligible BAA — verify current status before live use.

'use strict';

const https = require('https');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const VOICE_PERSONAS = {
  intake_agent:        { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',     style: 'warm' },
  scheduling_agent:    { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',     style: 'warm' },
  insurance_agent:     { voice_id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',      style: 'professional' },
  cost_estimate_agent: { voice_id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel',    style: 'clear' },
  doctor:              { voice_id: 'ErXwobaYiN019PkySvjV', name: 'Antoni',    style: 'calm' },
  escalation:          { voice_id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi',      style: 'firm' },
  patient:             { voice_id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlotte', style: 'natural' },
  default:             { voice_id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',     style: 'warm' }
};

function getApiKey() {
  // 1) Env var override
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  // 2) SQLite meta config (matches Rule 30 API-keys-in-SQLite pattern from main Meridian)
  // Check the hackathon's own clinic.db first, then fall back to meridian.db
  const candidates = [
    path.join(__dirname, '..', 'clinic.db'),
    path.join(__dirname, '..', '..', 'data', 'meridian.db'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const db = new Database(p, { readonly: true });
      // Try meta table (Rule 30 schema)
      try {
        const row = db.prepare("SELECT value FROM meta WHERE key='config'").get();
        if (row) {
          const cfg = JSON.parse(row.value);
          const key = cfg.elevenlabs_key || cfg.keys?.elevenlabs;
          db.close();
          if (key) return key;
        }
      } catch (_) {}
      db.close();
    } catch (_) {}
  }
  return null;
}

function setApiKey(key) {
  // Store to the clinic.db meta table (creates table if absent)
  const dbPath = path.join(__dirname, '..', 'clinic.db');
  const db = new Database(dbPath);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    const existing = db.prepare("SELECT value FROM meta WHERE key='config'").get();
    const cfg = existing ? JSON.parse(existing.value) : {};
    cfg.elevenlabs_key = key;
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('config', ?)").run(JSON.stringify(cfg));
  } finally { db.close(); }
  return true;
}

function listPersonas() {
  return Object.entries(VOICE_PERSONAS).map(([role, p]) => ({ role, ...p }));
}

// Synthesize MP3 from text + persona role. Returns Buffer (MP3) on success.
function synthesize(text, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const key = getApiKey();
    if (!key) return reject(new Error('elevenlabs_key_missing'));
    const persona = VOICE_PERSONAS[opts.role] || VOICE_PERSONAS.default;
    const voiceId = opts.voice_id || persona.voice_id;
    const body = JSON.stringify({
      text: (text || '').slice(0, 5000),  // ElevenLabs limit ~5K chars
      model_id: opts.model_id || 'eleven_turbo_v2_5',
      voice_settings: {
        stability: opts.stability != null ? opts.stability : 0.4,
        similarity_boost: opts.similarity_boost != null ? opts.similarity_boost : 0.75,
        style: opts.style_pct != null ? opts.style_pct : 0.0,
        use_speaker_boost: true
      }
    });
    const req = https.request({
      hostname: 'api.elevenlabs.io',
      path: '/v1/text-to-speech/' + voiceId,
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 30000
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, mp3: Buffer.concat(chunks), persona: persona.name, voice_id: voiceId, content_type: 'audio/mpeg' });
        } else {
          const errBody = Buffer.concat(chunks).toString('utf8').slice(0, 500);
          reject(new Error('elevenlabs_http_' + res.statusCode + ': ' + errBody));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('elevenlabs_timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { synthesize, listPersonas, getApiKey, setApiKey, VOICE_PERSONAS };
