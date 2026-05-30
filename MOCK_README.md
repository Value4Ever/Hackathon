# Mock Dental Eligibility & Benefits API

Development-only mock that mirrors a **full-breakdown** dental eligibility API
(Zuub / Onederful style). Lets you build your verification + cost-estimation app
against real HTTP endpoints today, then swap to a live vendor by changing the
base URL, auth, and field mapping. **All patient and member data is fabricated.**

## Files
- `mock_eligibility_db.json` — the "database": 10 patient records, full benefit breakdowns
- `mock_server.py` — FastAPI server exposing eligibility endpoints
- `build_db.py` — regenerates the JSON (edit scenarios or add patients here)
- `requirements.txt`

## Run
```bash
pip install -r requirements.txt
uvicorn mock_server:app --reload --port 8000
# open http://localhost:8000/docs  for interactive Swagger UI
```

## Endpoints
| Method | Path | Purpose |
|---|---|---|
| GET  | `/health` | liveness + record count |
| GET  | `/v1/patients` | list all mock patients (dev convenience) |
| GET  | `/v1/patients/{patient_id}` | full record by patient_id |
| POST | `/v1/eligibility` | **production-shaped call** — submit `member_id`, or `first_name`+`last_name`+`date_of_birth`(+`payer_id`) |

`POST /v1/eligibility` with an unmatched identifier returns a structured
`MEMBER_NOT_FOUND` envelope (not a bare 404) so your error path gets exercised.

## Scenarios (deliberately varied for edge-case testing)
| Patient | Scenario |
|---|---|
| PT-0001 | Active PPO, deductible unmet, full annual max |
| PT-0002 | Active PPO, deductible met, annual max nearly exhausted (late-year) |
| PT-0003 | Active PPO, **in waiting period** for basic & major |
| PT-0004 | **Dependent child**, ortho with age + lifetime max |
| PT-0005 | **Terminated** coverage — treat as self-pay |
| PT-0006 | **Coordination of benefits** (primary + secondary) |
| PT-0007 | **DHMO** copay-schedule plan (copays, no %, no annual max) |
| PT-0008 | **Missing tooth clause** excluding bridge/implant |
| PT-0009 | **Out-of-network** indemnity, UCR reimbursement |
| PT-0010 | **Frequency-limited** — recent cleaning, future eligibility date |

## Record shape (per patient)
`verification` (source/status/completeness) · `patient` · `subscriber` ·
`payer` · `coverage` (status/effective/term/in_network) ·
`plan_maximums` (annual + used + remaining, ortho lifetime) ·
`deductibles` (individual/family, met/remaining, applies-to) ·
`coverage_by_category` (diagnostic/preventive/basic/major/ortho, in & out network %) ·
`procedure_benefits[]` (ADA code, %, frequency, last-paid, next-eligible, age limit,
waiting period, alternate-benefit/downgrade, preauth) ·
`limitations` (missing tooth clause, waiting periods, age limits, downgrades) ·
`coordination_of_benefits` · `claim_history[]` · `disclaimers[]`

## When you swap to a real vendor
Keep your own internal coverage model and write a thin adapter per vendor that
maps their JSON onto this shape. Things real responses add that you should plan
for now: per-payer schema drift, **async retrieval** for full breakdowns (submit →
poll/webhook, not always one synchronous call), and auth headers + provider NPI.

## One design note worth keeping
This data should **price and annotate** a treatment plan (what's covered, patient
out-of-pocket, what triggers a downgrade or missing-tooth exclusion) — it should
not **select** the clinical plan. Keep coverage logic and clinical decision logic
in separate layers so benefits never silently drive treatment.
