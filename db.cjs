// _hackathon_dental/db.cjs — eligibility DB wrapper.
// Loads mock_eligibility_db.json into a SQLite database on first run; provides
// patient + benefit lookups for the verification engine + API server.

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'eligibility.db');
const MOCK_JSON = path.join(__dirname, 'mock_eligibility_db.json');

function _init() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS patients (
      patient_id TEXT PRIMARY KEY,
      member_id TEXT UNIQUE,
      first_name TEXT,
      last_name TEXT,
      date_of_birth TEXT,
      payer_id TEXT,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_patient_member ON patients(member_id);
    CREATE INDEX IF NOT EXISTS idx_patient_name_dob ON patients(first_name, last_name, date_of_birth);
  `);
  return db;
}

function loadMockIntoDb() {
  if (!fs.existsSync(MOCK_JSON)) throw new Error('Mock JSON not found at ' + MOCK_JSON);
  const data = JSON.parse(fs.readFileSync(MOCK_JSON, 'utf8'));
  const db = _init();
  const insert = db.prepare(`
    INSERT OR REPLACE INTO patients
      (patient_id, member_id, first_name, last_name, date_of_birth, payer_id, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((patients) => {
    for (const p of patients) {
      insert.run(
        p.patient.patient_id,
        p.patient.member_id,
        p.patient.first_name,
        p.patient.last_name,
        p.patient.date_of_birth,
        p.payer && p.payer.payer_id,
        JSON.stringify(p)
      );
    }
  });
  tx(data.patients);
  const count = db.prepare('SELECT COUNT(*) as n FROM patients').get().n;
  db.close();
  return { loaded: count, source: path.basename(MOCK_JSON) };
}

function listPatients() {
  const db = _init();
  const rows = db.prepare(`
    SELECT patient_id, member_id, first_name, last_name, date_of_birth, payer_id
    FROM patients
    ORDER BY patient_id
  `).all();
  db.close();
  return rows;
}

function getByPatientId(patientId) {
  const db = _init();
  const row = db.prepare('SELECT record_json FROM patients WHERE patient_id = ?').get(patientId);
  db.close();
  return row ? JSON.parse(row.record_json) : null;
}

function getByMemberId(memberId) {
  const db = _init();
  const row = db.prepare('SELECT record_json FROM patients WHERE member_id = ?').get(memberId);
  db.close();
  return row ? JSON.parse(row.record_json) : null;
}

function findByNameDob(firstName, lastName, dob, payerId) {
  const db = _init();
  let row;
  if (payerId) {
    row = db.prepare(`
      SELECT record_json FROM patients
      WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND date_of_birth = ? AND payer_id = ?
    `).get(firstName, lastName, dob, payerId);
  } else {
    row = db.prepare(`
      SELECT record_json FROM patients
      WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND date_of_birth = ?
    `).get(firstName, lastName, dob);
  }
  db.close();
  return row ? JSON.parse(row.record_json) : null;
}

module.exports = { loadMockIntoDb, listPatients, getByPatientId, getByMemberId, findByNameDob, DB_PATH };

// CLI: node db.cjs (initializes + loads mock data)
if (require.main === module) {
  const result = loadMockIntoDb();
  console.log('Loaded ' + result.loaded + ' patients from ' + result.source);
  console.log('Database: ' + DB_PATH);
}
