# HIPAA + 21 CFR Part 11 Compliance Matrix
**Bright Smile Dental Front-Desk App** · Hackathon MVP · 2026-05-30

This document maps the implemented controls against:
- **HIPAA Privacy Rule** (45 CFR Part 160 + Subparts A, E of Part 164)
- **HIPAA Security Rule** (45 CFR Part 164 Subpart C — §164.302-318)
- **HIPAA Breach Notification Rule** (45 CFR Part 164 Subpart D)
- **21 CFR Part 11** — Electronic Records / Electronic Signatures

Each control identifies what is implemented in code vs what requires organizational, contractual, or infrastructure work for production deployment.

---

## 1. HIPAA Security Rule — Technical Safeguards (45 CFR §164.312)

| Control | Requirement | App-layer implementation | Production also requires |
|---|---|---|---|
| §164.312(a)(1) Access control | Allow access to authorized persons | `lib/hipaaControls.cjs` — 5 roles (front_desk / hygienist / dentist / office_mgr / patient / demo), per-resource read/write/export matrix | SSO integration (Entra/Okta), MFA, account provisioning workflow |
| §164.312(a)(2)(i) Unique user identification | Each user has unique ID | `user_id` is primary key in user store; never reassigned (Part 11 §11.100 alignment) | HR onboarding/offboarding tied to identity system |
| §164.312(a)(2)(ii) Emergency access | Reach ePHI in emergency | Documented break-glass procedure in `runbooks/emergency_access.md` (to author) | On-call rota, paper backup workflow |
| §164.312(a)(2)(iii) Automatic logoff | Inactivity → terminate session | `lib/hipaaControls.cjs::SESSION_TIMEOUT_MS = 15 min`; session auto-expires + cleared from memory | Workstation OS lock policy |
| §164.312(a)(2)(iv) Encryption + decryption | Encrypt ePHI | TLS required at deployment (reverse proxy: nginx + Let's Encrypt) | SQLCipher swap for at-rest (see §3 Production Hardening); key mgmt in vault |
| §164.312(b) Audit controls | Record + examine activity | `lib/phiAuditLog.cjs` — every PHI access logged: who, what, when, why, result, IP, UA. Persisted to `clinic.db::phi_audit_log` (append-only) | SIEM forwarding (Splunk/Sentinel), 6-year retention per §164.530(j) |
| §164.312(c)(1) Integrity | Protect ePHI from improper alteration | E-signature chain-hashing (`lib/eSignature.cjs`) provides tamper-evidence for signed records | DB-level row-version + change-data-capture; cryptographic backups |
| §164.312(d) Person/entity authentication | Verify identity claim | Password-based for demo; Part 11 §11.200 two-component re-auth on signing | MFA / SmartCard / biometric for production |
| §164.312(e)(1) Transmission security | Guard against unauthorized access during transit | TLS required at deployment; `Strict-Transport-Security` header | mTLS for intra-cluster |

## 2. HIPAA Privacy Rule — Implementation Touch Points

| Control | Requirement | Implementation |
|---|---|---|
| §164.502(a) Uses + disclosures | Treatment / payment / operations only (or with authorization) | `purpose_of_use` field on every audit log row; default `treatment` |
| §164.502(b) Minimum necessary | Limit access to the minimum needed | Per-role `can_read[]` matrix in `lib/hipaaControls.cjs::ROLES`; `redactPatient()` strips fields outside role |
| §164.508 Authorization for uses + disclosures | Patient signs auth for non-TPO uses | `consentCheck()` blocks SMS/email/voicemail without recorded opt-in (`sms_opt_in`, `email_opt_in`, `phone_ok` columns) |
| §164.514(b) Safe Harbor de-identification | Strip 18 identifiers | `redactPatient()` masks: name initials, DOB year-only, address [REDACTED], 3-digit ZIP, phone last-4, email masked, member ID last-4, medical fields [REDACTED]; age 90+ collapsed |
| §164.520 Notice of Privacy Practices | Patients informed of practices | Cover screen on patient self-service portal (TBD — `ui/patient_portal.html` future) |
| §164.524 Right of access | Patient gets copy of designated record set | `GET /v1/patient/:id/export` returns full record + appointments + treatments + payments + communications + audit-trail subset within 30-day clock |
| §164.526 Right to amend | Patient can request amendment | Endpoint `POST /v1/patient/:id/amend` (TBD — would file amendment + flag in record) |
| §164.528 Accounting of disclosures | List disclosures of PHI | Filterable audit log endpoint `/v1/audit/log?target_id=<patient>` |

## 3. 21 CFR Part 11 — Electronic Records + Signatures

| Control | Requirement | Implementation |
|---|---|---|
| §11.10(a) Validation | Ensure accuracy, reliability, consistent intended performance | `VALIDATION_PLAN.md` (next deliverable) — IQ/OQ/PQ; engine smoke tests in this session prove functional behavior |
| §11.10(b) Records readable form | Generate accurate + complete copies | `GET /v1/patient/:id/export` produces human + machine-readable JSON |
| §11.10(c) Protection of records | Accurate + ready retrieval | SQLite WAL mode, daily backups (production), 6-year retention per HIPAA + applicable state laws |
| §11.10(d) Limiting system access | To authorized individuals | RBAC; session token required on every PHI endpoint |
| §11.10(e) Audit trails | Secure, computer-generated, time-stamped; do not obscure previous | `phi_audit_log` table — chronologically appended, immutable in production via DB grants. E-signature chain-hashing (§11.70) extends tamper-evidence to record content |
| §11.10(f) Operational system checks | Enforce sequencing of events / steps | Multi-agent orchestrator (`agentOrchestrator.cjs`) enforces state-machine progression — operator cannot skip steps |
| §11.10(g) Authority checks | Only authorized individuals may use system, sign records, alter records | `canRead/canWrite/canExport` checks before every protected operation |
| §11.10(h) Device checks | Validate source of data input/instruction | IP + user-agent logged on every audit row + signature |
| §11.10(i) Education + training | Persons developing/maintaining the system are qualified | (organizational — annual training records) |
| §11.10(j) Written policies + procedures | Hold individuals accountable | (organizational SOPs) |
| §11.10(k) Documentation control | Control of system documentation | Git history of source files (`_hackathon_dental/`) provides revision history |
| §11.50(a) Signature manifestations | Printed name + date/time + meaning | Every signature row carries `signer_printed_name`, `signed_at`, `meaning` (constrained vocabulary: authorship/review/approval/responsibility/consent/verification/release/attestation) |
| §11.50(b) Subject to controls of §11.10 | Same controls apply | Signatures persisted via same audit-grade path |
| §11.70 Signature/record linking | Signatures bound to records; cannot be excised | `signature_hash = sha256(previous_signature_hash + payload + record_hash)` — chain breaks detectable via `eSignature.verifyChain()` |
| §11.100(a) Unique to one individual | Never reassigned | `signer_user_id` references user store with hard reassignment prevention (documented policy) |
| §11.100(b) Verify identity before establishment | Org SOP | (organizational onboarding step — identity-proofing before user creation) |
| §11.100(c) Certify to FDA | Cert letter on file | (organizational submission) |
| §11.200(a)(1)(i) First signing of session | Both ID + password required | `signWithReauth()` requires both every signing (more conservative than minimum) |
| §11.200(a)(1)(ii) Subsequent signings | At least one component on each | Implemented as full two-component every time |
| §11.200(a)(2) Two distinct components | E.g. ID + password | `user_id` + `password` (passwords hashed SHA256 in demo; bcrypt + per-user salt in production) |
| §11.300(a) ID/code uniqueness | No two have same combination | Unique `user_id` enforced at user-store level |
| §11.300(b) Periodic checks/revisions | Periodic password change | Documented 90-day policy (production); auto-prompted on login |
| §11.300(c) Loss management | Disable lost tokens | `logout()` immediately invalidates token; documented loss procedure |
| §11.300(d) Transaction safeguards | Detect attempted unauthorized use | `phiAuditLog.detectSuspicious()` — high-volume, after-hours, export, failed-access patterns |
| §11.300(e) Initial + periodic testing | Tokens tested for proper function | Smoke tests this session; periodic re-test in QA SOP |

## 4. Implemented Endpoints (HIPAA + Part 11)

```
POST /v1/auth/login                  — get session token (90-day password rotation per Part 11 §11.300(b))
POST /v1/auth/logout                  — invalidate token
GET  /v1/auth/me                      — session introspection
GET  /v1/auth/users                   — list demo users
GET  /v1/patient/:id/export           — HIPAA §164.524 right-of-access full export
GET  /v1/audit/log                    — Part 11 §11.10(e) audit-trail review (office_mgr / dentist only)
GET  /v1/audit/suspicious             — Part 11 §11.300(d) anomaly detection (office_mgr / dentist only)
POST /v1/esig/sign                    — Part 11 §11.50 + §11.70 e-signature with two-component re-auth
GET  /v1/esig/chain                   — Part 11 §11.10(e) chain integrity verification
GET  /v1/esig/record/:resource/:id    — list signatures for a record
```

## 5. Production Hardening Checklist

Before any production deployment carrying real PHI:

- [ ] **TLS everywhere** — terminate TLS 1.2+ at nginx/HAProxy with HSTS, OCSP stapling, modern cipher suites
- [ ] **At-rest encryption** — swap `better-sqlite3` for `@journeyapps/sqlcipher` or migrate to PostgreSQL+pgcrypto; KMS-managed keys
- [ ] **Backup encryption** — encrypted backups (age / SOPS) stored in geographically-redundant vault
- [ ] **6-year retention** of audit logs per §164.530(j)
- [ ] **Business Associate Agreement (BAA)** with the dental practice (covered entity) — required before any PHI flows
- [ ] **Annual workforce HIPAA training** — documented per §164.530(b)
- [ ] **Periodic security risk analysis** per §164.308(a)(1)(ii)(A)
- [ ] **Contingency plan** — backup, disaster recovery, emergency mode operations (§164.308(a)(7))
- [ ] **Bcrypt or Argon2** for password hashing (replace SHA256 in `hipaaControls.cjs`)
- [ ] **MFA enforced** on all roles (TOTP minimum, SmartCard/PIV for clinical staff)
- [ ] **Session storage** — move from in-memory Map to Redis or encrypted database with explicit expiry
- [ ] **API rate-limiting + WAF**
- [ ] **Penetration test** before go-live
- [ ] **Validation Plan execution** — IQ/OQ/PQ documented and dated per Part 11 §11.10(a)
- [ ] **Patient-facing Notice of Privacy Practices** per §164.520 — posted + offered at first contact
- [ ] **OCR Breach Notification readiness** — sub-60-day notification process for >500-record breaches
- [ ] **State law overlay** — CA CMIA, NY SHIELD, MA 201 CMR 17, TX MRPA, etc. as applicable
- [ ] **Twilio / vendor BAAs** for SMS + voice channels
- [ ] **Anthropic BAA** if Opus 4.8 processes PHI (verify current Anthropic Trust Center)
- [ ] **CFR Part 11 §11.100(c)** certification letter to FDA if records are FDA-submitted

## 6. Breach Notification Readiness

Per §164.408 (covered entities) + §164.410 (business associates):
- Identify the breach via `phiAuditLog.detectSuspicious()` daily report
- Within 60 days: notify each individual + media (if >500) + HHS Secretary
- Audit trail's chain-hash + IP + UA fields enable forensic scope determination
- Maintain documented breach response in `runbooks/breach_response.md`

## 7. References

- 45 CFR Parts 160 + 164 — full HIPAA regulation
- HHS Office for Civil Rights (OCR) — [hhs.gov/hipaa](https://www.hhs.gov/hipaa)
- 21 CFR Part 11 — Electronic Records / Electronic Signatures
- FDA Guidance: "Part 11, Electronic Records; Electronic Signatures — Scope and Application" (Aug 2003)
- ONC Health IT Certification Program — overlap with HIPAA Security Rule
- NIST SP 800-66 Rev. 2 — HIPAA Security Rule implementation guidance
- NIST SP 800-63B — Authentication assurance levels referenced for §164.312(d)

---

*This document is a hackathon-grade compliance map. Production deployment requires sign-off from a HIPAA Privacy Officer + Security Officer + legal counsel familiar with applicable state laws + the FDA cybersecurity guidance current at deployment date.*

MT+™ is a trademark of Meridian Technologies IP Holdings.
