# Bright Smile Dental — AI Front-Desk Hackathon MVP

Multi-agent dental front-desk system that handles inbound patient calls, verifies insurance,
prices treatment plans, schedules appointments with SPC-driven no-show prediction, sends
WhatsApp/SMS/voice outreach to patients/staff/doctors, and handles human-in-the-loop
exceptions — all with HIPAA + 21 CFR Part 11 technical safeguards.

> MT+™ is a trademark of Meridian Technologies IP Holdings (Massachusetts 501(c)(3)).
> All patient data is fabricated mock data for hackathon demonstration purposes.

## Quick start

```bash
npm install                          # better-sqlite3, docx, exceljs, archiver, adm-zip
node generateClinicData.cjs          # one-time: build 1000-patient clinic.db
node db.cjs                          # one-time: load vendor eligibility DB
node server.cjs                      # starts on port 8765
```

Open **http://localhost:8765** → Front-Desk Hub. Click **Demo Theater** for the end-to-end walkthrough.

## Demo paths

| URL | What |
|---|---|
| `/` | Front-Desk Hub — KPIs + decision flow + workflow + alerts |
| `/demo` | **Demo Theater — 18-step scripted end-to-end walkthrough (start here)** |
| `/inbound` | Multi-agent call simulator (talk to the AI front desk) |
| `/clinic` | SPC dashboard — 1000 patients ranked by no-show risk + WE rules |
| `/verifier` | Eligibility verifier — vendor-shape API, cost estimate, LLM plain-English explanation |

## What it does

Replaces 30-35 min of front-desk work per patient with a multi-agent flow:

1. **Triage** — PMS lookup → new vs existing
2. **Intake Agent** (voice) collects card details for new patients
3. **Insurance Agent** verifies via 270 request → web-scrape fallback → voice call to carrier
4. **Cost Estimate Agent** prices the treatment plan: deductible · max cap · COB ·
   alternate-benefit downgrade · missing-tooth · frequency limits
5. **Scheduling Agent** proposes slots with SPC risk-aware policy
   (deposit + morning slot for critical-risk patients)
6. **Confirmation** sends SMS + WhatsApp + cost-estimate to patient,
   WhatsApp brief to doctor, logs to ledger
7. **Exception Engine** routes failures (terminated coverage, COB unclear,
   missing-tooth, etc.) to staff WhatsApp with auto-generated call scripts

## Project structure

```
.
├── README.md                          ← this file
├── HIPAA_PART11_COMPLIANCE.md         ← full HIPAA + 21 CFR Part 11 control matrix
├── MOCK_README.md                     ← original mock-vendor README
│
├── server.cjs                         ← Node HTTP API (no framework)
├── generateClinicData.cjs             ← 1000-patient mock data synthesizer
├── verifyEngine.cjs                   ← coverage decisioning + COB calculator
├── exceptionRouter.cjs                ← 12-code exception → action-plan generator
├── db.cjs                             ← SQLite wrapper for eligibility DB
│
├── lib/
│   ├── spcEngine.cjs                  ← SPC p-chart + Western Electric Rules 1-8
│   ├── schedulerEngine.cjs            ← risk-aware outreach policy + templates
│   ├── agentOrchestrator.cjs          ← multi-agent state machine
│   ├── messagingChannels.cjs          ← SMS/WhatsApp/Voice/Email abstraction
│   ├── demoRunner.cjs                 ← scripted 18-step end-to-end demo
│   ├── hipaaControls.cjs              ← auth + RBAC + Safe Harbor de-id + consent gates
│   ├── phiAuditLog.cjs                ← §164.312(b) audit trail + anomaly detection
│   └── eSignature.cjs                 ← 21 CFR Part 11 §11.50/§11.70/§11.100/§11.200 e-signatures
│
├── ui/
│   ├── hub.html                       ← Front-Desk Hub (landing)
│   ├── index.html                     ← Eligibility Verifier
│   ├── clinic.html                    ← SPC Scheduler Dashboard
│   ├── inbound.html                   ← Inbound Call Simulator
│   └── demo.html                      ← Demo Theater
│
├── mock_eligibility_db.json           ← 10 mock vendor records (Zuub/Onederful-shaped)
├── mock_server.py / build_db.py       ← original FastAPI mock kept for reference
└── requirements.txt
```

## Key engines

### SPC + Western Electric Rules (`lib/spcEngine.cjs`)
Bernoulli p-chart per patient: `p̄` = no-show rate, `σ = √(p̄(1-p̄))`, UCL/LCL at ±3σ.
All 8 Western Electric Rules implemented. Risk score combines long-run p̄, recent-rate, and
WE-rule penalty → bands: low / moderate / high / critical → drives scheduling policy.

### Multi-Agent Orchestrator (`lib/agentOrchestrator.cjs`)
11-state machine: TRIAGE → INTAKE → INSURANCE_VERIFICATION → COST_ESTIMATE → SCHEDULING
→ CONFIRMATION (or HUMAN_ESCALATION branches). Rule-based for hackathon; production swaps
in LLM agents per state.

### Risk-Aware Scheduler (`lib/schedulerEngine.cjs`)
Per-band policy: cadence (1-5 touchpoints), deposit %, confirmation requirement,
morning-slot preference, short lead time. English + Spanish templates. Honors HIPAA
opt-in flags before sending.

### Coverage Calculator (`verifyEngine.cjs`)
Handles 12 mock scenarios: active PPO, deductible-met-max-exhausted, waiting period,
ortho with age limit, terminated coverage, COB primary+secondary, DHMO copay, missing tooth,
OON indemnity, frequency-limited, alternate-benefit downgrade. Plain-English explainer
optional via Anthropic Claude Opus 4.8.

### Exception Router (`exceptionRouter.cjs`)
12 codes with ranked action plans (SMS bodies + call scripts + payer phone directory).

## HIPAA + 21 CFR Part 11

See `HIPAA_PART11_COMPLIANCE.md` for the full control matrix.

**HIPAA Security Rule (45 CFR §164.312)**:
- §164.312(a) Access control — 6-role RBAC, 15-min auto-logoff, session tokens
- §164.312(b) Audit controls — every PHI access logged
- §164.312(c) Integrity — e-signature chain-hashing for tamper-evidence
- §164.312(d) Authentication — password + Part 11 two-component on signing
- §164.312(e) Transmission — TLS required at deployment (reverse proxy)

**HIPAA Privacy**:
- §164.502(b) Minimum necessary — per-role response shaping
- §164.508 Authorization — consent gate blocks SMS/email/call without opt-in
- §164.514(b) Safe Harbor — 18-identifier mask
- §164.524 Right of access — `GET /v1/patient/:id/export` within 30-day clock

**21 CFR Part 11**:
- §11.10(e) Audit trail — chain-hashed, append-only
- §11.50 / §11.70 Signature manifestations + record linking
- §11.100 Unique to individual
- §11.200 Two-component (ID + password) re-auth on every signing
- §11.300 ID/password controls

## Production deployment

See `HIPAA_PART11_COMPLIANCE.md` §5 Production Hardening Checklist. 16 items including
TLS everywhere, SQLCipher at rest, BAA execution with the covered entity, Anthropic BAA
verification, workforce training, MFA, validation IQ/OQ/PQ.

## Endpoints (38 total)

See `HIPAA_PART11_COMPLIANCE.md` §4 for the full list. Top-level groups:

- `/v1/auth/*` — login, logout, session, users (HIPAA §164.312(a)(2)(i))
- `/v1/audit/*` — §164.312(b) audit trail + anomaly detection
- `/v1/esig/*` — 21 CFR Part 11 e-signatures + chain integrity
- `/v1/patient/:id/export` — HIPAA §164.524 right-of-access
- `/v1/patients/*`, `/v1/eligibility`, `/v1/verify`, `/v1/explain` — eligibility verifier
- `/v1/clinic/*` — 1000-patient scheduler + SPC analysis + batch campaigns
- `/v1/intake/*` — inbound call orchestrator
- `/v1/exceptions/*` — exception classification + action execution
- `/v1/demo/*` — 18-step end-to-end demo runner

## License

Hackathon code released for demo purposes. Patient data is fabricated.

For production licensing of the MT+™ pipeline architecture, contact Meridian Technologies IP Holdings.

---

MT+™ is a trademark of Meridian Technologies IP Holdings · Massachusetts 501(c)(3) · ID #001973943
