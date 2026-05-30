"""
Mock dental eligibility & benefits API server.

Serves the fabricated records in mock_eligibility_db.json over HTTP so your
app can develop against real endpoints. The request/response shape mirrors a
portal-backed eligibility API (submit subscriber identifiers -> get a full
benefit breakdown), so when you switch to a live vendor (Zuub, Onederful,
etc.) you mostly change the base URL + auth and re-map their field names.

Run:
    pip install fastapi uvicorn
    uvicorn mock_server:app --reload --port 8000

Then:
    http://localhost:8000/docs        # interactive Swagger UI
    GET  /v1/patients                 # list all mock patients (dev convenience)
    GET  /v1/patients/PT-0001         # fetch one full record by patient_id
    POST /v1/eligibility              # the realistic call (see EligibilityRequest)
"""

import json
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

DB_PATH = Path(__file__).parent / "mock_eligibility_db.json"

app = FastAPI(
    title="Mock Dental Eligibility API",
    version="1.0.0",
    description="Development-only mock. All patient data is fabricated.",
)


def load_db() -> dict:
    with open(DB_PATH) as f:
        return json.load(f)


# Loaded once at import; restart server to pick up edits to the JSON.
DB = load_db()
PATIENTS = DB["patients"]
BY_PATIENT_ID = {p["patient"]["patient_id"]: p for p in PATIENTS}
BY_MEMBER_ID = {p["patient"]["member_id"]: p for p in PATIENTS}


# ----- Request / response models ----------------------------------------
class EligibilityRequest(BaseModel):
    """Submit either member_id alone, or name + dob + payer to match a patient.

    Mirrors how a real eligibility inquiry is keyed. member_id is the most
    reliable; the name/dob/payer combo is the fallback most vendors support.
    """
    member_id: Optional[str] = Field(None, example="DDX448120731")
    first_name: Optional[str] = Field(None, example="Marcus")
    last_name: Optional[str] = Field(None, example="Halloway")
    date_of_birth: Optional[str] = Field(None, example="1989-03-12")
    payer_id: Optional[str] = Field(None, example="DDCA")
    # provider NPI would be required by a real payer; accepted + ignored here
    provider_npi: Optional[str] = Field(None, example="1356789012")


class PatientSummary(BaseModel):
    patient_id: str
    first_name: str
    last_name: str
    payer: str
    plan_type: str
    status: str


# ----- Endpoints --------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok", "record_count": len(PATIENTS), "as_of": DB["_meta"]["as_of_date"]}


@app.get("/v1/patients", response_model=list[PatientSummary],
         summary="List all mock patients (dev convenience, not a real endpoint)")
def list_patients():
    return [
        {
            "patient_id": p["patient"]["patient_id"],
            "first_name": p["patient"]["first_name"],
            "last_name": p["patient"]["last_name"],
            "payer": p["payer"]["name"],
            "plan_type": p["payer"]["plan_type"],
            "status": p["coverage"]["status"],
        }
        for p in PATIENTS
    ]


@app.get("/v1/patients/{patient_id}",
         summary="Fetch one full eligibility record by patient_id")
def get_patient(patient_id: str):
    rec = BY_PATIENT_ID.get(patient_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"No patient with id {patient_id}")
    return rec


@app.post("/v1/eligibility",
          summary="Submit an eligibility inquiry (the realistic production-shaped call)")
def check_eligibility(req: EligibilityRequest):
    rec = None

    if req.member_id:
        rec = BY_MEMBER_ID.get(req.member_id)

    if rec is None and req.first_name and req.last_name and req.date_of_birth:
        for p in PATIENTS:
            pt = p["patient"]
            if (pt["first_name"].lower() == req.first_name.lower()
                    and pt["last_name"].lower() == req.last_name.lower()
                    and pt["date_of_birth"] == req.date_of_birth):
                if req.payer_id and p["payer"]["payer_id"] != req.payer_id:
                    continue
                rec = p
                break

    if rec is None:
        # Shape a "not found" the way a real API would, rather than a bare 404,
        # so your error-handling path gets exercised too.
        return {
            "verification": {"status": "not_found", "source": "mock"},
            "error": {
                "code": "MEMBER_NOT_FOUND",
                "message": "No active or inactive coverage matched the submitted "
                           "identifiers. Verify member ID, name, DOB, and payer.",
            },
            "echo": req.model_dump(exclude_none=True),
        }

    return rec
