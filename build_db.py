"""
Builds a realistic mock dental eligibility & benefits database.

The record shape mirrors a "full breakdown" response from a portal-backed
dental eligibility API (Zuub / Onederful style): coverage % by category,
deductibles (annual / met / remaining), annual max (used / remaining),
procedure-level frequency limits with last-paid / next-eligible dates,
waiting periods, age limits, missing-tooth clause, downgrades / alternate
benefit, coordination of benefits, and claim history.

All patients, member IDs, groups, and dates are fabricated. Carrier names
are real companies used only as plausible labels; coverage figures are
invented and reflect no real plan.

Run:  python3 build_db.py   ->  writes mock_eligibility_db.json
"""

import json
from datetime import date

PLAN_YEAR = 2026
TODAY = "2026-05-30"

# ---- Procedure catalog: ADA code -> (description, category) -------------
# Categories: diagnostic, preventive, basic, major, ortho
PROC = {
    "D0120": ("Periodic oral evaluation", "diagnostic"),
    "D0150": ("Comprehensive oral evaluation", "diagnostic"),
    "D0210": ("Intraoral complete series (FMX)", "diagnostic"),
    "D0274": ("Bitewings - four films", "diagnostic"),
    "D1110": ("Prophylaxis - adult", "preventive"),
    "D1120": ("Prophylaxis - child", "preventive"),
    "D1206": ("Topical fluoride varnish", "preventive"),
    "D1351": ("Sealant - per tooth", "preventive"),
    "D2391": ("Resin composite - one surface, posterior", "basic"),
    "D2392": ("Resin composite - two surfaces, posterior", "basic"),
    "D2750": ("Crown - porcelain fused to high noble metal", "major"),
    "D2740": ("Crown - porcelain/ceramic", "major"),
    "D2950": ("Core buildup, including any pins", "major"),
    "D3310": ("Endodontic therapy, anterior tooth", "basic"),
    "D4341": ("Perio scaling & root planing - per quadrant", "basic"),
    "D6010": ("Surgical placement of implant body", "major"),
    "D6240": ("Pontic - porcelain fused to high noble metal", "major"),
    "D7140": ("Extraction, erupted tooth", "basic"),
    "D8080": ("Comprehensive ortho treatment - adolescent", "ortho"),
}


def proc_rows(spec):
    """spec: list of dicts -> fully-formed procedure_benefits rows."""
    rows = []
    for s in spec:
        code = s["code"]
        desc, cat = PROC[code]
        rows.append({
            "ada_code": code,
            "description": desc,
            "category": cat,
            "coverage_percent": s["pct"],
            "frequency": s.get("frequency"),               # human-readable
            "frequency_remaining": s.get("freq_remaining"), # int or None
            "last_paid_date": s.get("last_paid"),
            "next_eligible_date": s.get("next_eligible"),
            "age_limit": s.get("age_limit"),
            "waiting_period_months": s.get("waiting", 0),
            "waiting_period_met": s.get("waiting_met", True),
            "alternate_benefit": s.get("alt_benefit"),      # downgrade note
            "requires_preauth": s.get("preauth", False),
            "notes": s.get("notes"),
        })
    return rows


def category_block(diagnostic, preventive, basic, major, ortho=None):
    b = {
        "diagnostic": {"in_network_percent": diagnostic[0], "out_network_percent": diagnostic[1]},
        "preventive": {"in_network_percent": preventive[0], "out_network_percent": preventive[1]},
        "basic":      {"in_network_percent": basic[0],      "out_network_percent": basic[1]},
        "major":      {"in_network_percent": major[0],      "out_network_percent": major[1]},
    }
    if ortho is not None:
        b["orthodontics"] = {"in_network_percent": ortho[0], "out_network_percent": ortho[1]}
    return b


def record(**kw):
    """Assemble a verification record with sensible defaults."""
    base = {
        "verification": {
            "reference_number": kw["ref"],
            "verified_at": TODAY + "T09:14:00Z",
            "source": kw.get("source", "payer_portal"),   # payer_portal | edi_271
            "status": kw.get("vstatus", "completed"),
            "data_completeness": kw.get("completeness", "full_breakdown"),
        },
        "patient": kw["patient"],
        "subscriber": kw["subscriber"],
        "payer": kw["payer"],
        "coverage": kw["coverage"],
        "plan_maximums": kw["maxes"],
        "deductibles": kw["deductibles"],
        "coverage_by_category": kw["categories"],
        "procedure_benefits": kw["procedures"],
        "limitations": kw["limitations"],
        "coordination_of_benefits": kw.get("cob", {"has_other_coverage": False}),
        "claim_history": kw.get("history", []),
        "disclaimers": kw.get("disclaimers", [
            "Benefit quote is not a guarantee of payment. Final benefits are "
            "determined at claim adjudication.",
        ]),
    }
    return base


records = []

# 1) Standard active PPO, new patient, deductible UNMET, full annual max ----
records.append(record(
    ref="VR-2026-100001",
    patient={"patient_id": "PT-0001", "first_name": "Marcus", "last_name": "Halloway",
             "date_of_birth": "1989-03-12", "member_id": "DDX448120731",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Marcus", "last_name": "Halloway",
                "member_id": "DDX448120731", "date_of_birth": "1989-03-12"},
    payer={"name": "Delta Dental", "payer_id": "DDCA", "plan_name": "Delta Dental PPO",
           "plan_type": "PPO", "group_number": "GRP-77120", "group_name": "Brightwave Labs Inc."},
    coverage={"status": "active", "effective_date": "2024-01-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 2000.00, "annual_used": 0.00, "annual_remaining": 2000.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 50.00, "individual_met": 0.00, "individual_remaining": 50.00,
                 "family_annual": 150.00, "family_met": 0.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 100), (100, 100), (80, 60), (50, 40)),
    procedures=proc_rows([
        {"code": "D0120", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 2},
        {"code": "D1110", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 2},
        {"code": "D0274", "pct": 100, "frequency": "1 per benefit year", "freq_remaining": 1},
        {"code": "D2391", "pct": 80, "frequency": "Once per tooth surface per 24 mo"},
        {"code": "D2750", "pct": 50, "frequency": "1 per tooth per 5 years", "preauth": True,
         "alt_benefit": "Downgraded to D2751 (PFM base metal) for posterior teeth"},
        {"code": "D7140", "pct": 80},
    ]),
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [], "downgrades": ["Posterior crowns downgraded to base metal"]},
))

# 2) Active PPO, deductible MET, annual max nearly EXHAUSTED (late in year) -
records.append(record(
    ref="VR-2026-100002",
    patient={"patient_id": "PT-0002", "first_name": "Sofia", "last_name": "Renteria",
             "date_of_birth": "1976-11-02", "member_id": "CIG90233117",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Sofia", "last_name": "Renteria",
                "member_id": "CIG90233117", "date_of_birth": "1976-11-02"},
    payer={"name": "Cigna", "payer_id": "CIGNA", "plan_name": "Cigna Dental Care PPO",
           "plan_type": "PPO", "group_number": "GRP-30418", "group_name": "Northpoint Logistics"},
    coverage={"status": "active", "effective_date": "2019-07-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 1500.00, "annual_used": 1340.00, "annual_remaining": 160.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 50.00, "individual_met": 50.00, "individual_remaining": 0.00,
                 "family_annual": 150.00, "family_met": 110.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 80), (100, 80), (80, 50), (50, 30)),
    procedures=proc_rows([
        {"code": "D0120", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 0,
         "last_paid": "2026-04-18", "next_eligible": "2026-10-18",
         "notes": "Frequency exhausted for the year"},
        {"code": "D1110", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 0,
         "last_paid": "2026-04-18", "next_eligible": "2026-10-18"},
        {"code": "D4341", "pct": 80, "frequency": "1 per quadrant per 24 mo", "freq_remaining": 4},
        {"code": "D2750", "pct": 50, "frequency": "1 per tooth per 5 years", "preauth": True,
         "notes": "Only $160 of annual max remains; balance is patient responsibility"},
    ]),
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [], "downgrades": []},
    history=[
        {"date": "2026-04-18", "ada_code": "D1110", "description": "Adult prophy", "tooth": None, "paid_amount": 95.00},
        {"date": "2026-04-18", "ada_code": "D0120", "description": "Periodic exam", "tooth": None, "paid_amount": 38.00},
        {"date": "2026-02-09", "ada_code": "D2750", "description": "Crown", "tooth": "19", "paid_amount": 620.00},
        {"date": "2026-01-22", "ada_code": "D3310", "description": "RCT anterior", "tooth": "8", "paid_amount": 587.00},
    ],
))

# 3) Active, but in WAITING PERIOD for major services --------------------
records.append(record(
    ref="VR-2026-100003",
    patient={"patient_id": "PT-0003", "first_name": "Priya", "last_name": "Nandakumar",
             "date_of_birth": "1995-06-28", "member_id": "MET55810042",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Priya", "last_name": "Nandakumar",
                "member_id": "MET55810042", "date_of_birth": "1995-06-28"},
    payer={"name": "MetLife", "payer_id": "METLIFE", "plan_name": "MetLife Dental PPO",
           "plan_type": "PPO", "group_number": "GRP-11902", "group_name": "Cedar & Co."},
    coverage={"status": "active", "effective_date": "2026-02-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 1500.00, "annual_used": 47.00, "annual_remaining": 1453.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 75.00, "individual_met": 0.00, "individual_remaining": 75.00,
                 "family_annual": 225.00, "family_met": 0.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 90), (100, 90), (80, 60), (50, 50)),
    procedures=proc_rows([
        {"code": "D0150", "pct": 100, "frequency": "1 per 36 mo", "freq_remaining": 1},
        {"code": "D1110", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 2},
        {"code": "D2391", "pct": 80, "waiting": 6, "waiting_met": False,
         "notes": "Basic services subject to 6-month waiting period; eligible 2026-08-01"},
        {"code": "D2750", "pct": 50, "waiting": 12, "waiting_met": False, "preauth": True,
         "notes": "Major services subject to 12-month waiting period; eligible 2027-02-01"},
    ]),
    limitations={"missing_tooth_clause": True,
                 "waiting_periods": [
                     {"category": "basic", "months": 6, "eligible_date": "2026-08-01"},
                     {"category": "major", "months": 12, "eligible_date": "2027-02-01"}],
                 "age_limits": [], "downgrades": []},
))

# 4) DEPENDENT CHILD on parent's plan, ORTHO with age + lifetime max ------
records.append(record(
    ref="VR-2026-100004",
    patient={"patient_id": "PT-0004", "first_name": "Liam", "last_name": "Okafor",
             "date_of_birth": "2012-09-15", "member_id": "AET22094510-02",
             "relationship_to_subscriber": "child"},
    subscriber={"first_name": "Adaeze", "last_name": "Okafor",
                "member_id": "AET22094510-01", "date_of_birth": "1984-01-30"},
    payer={"name": "Aetna", "payer_id": "AETNA", "plan_name": "Aetna Dental PPO + Ortho",
           "plan_type": "PPO", "group_number": "GRP-66201", "group_name": "Halcyon Schools District"},
    coverage={"status": "active", "effective_date": "2022-09-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 1500.00, "annual_used": 210.00, "annual_remaining": 1290.00,
           "lifetime_orthodontic_maximum": 1500.00, "orthodontic_used": 0.00},
    deductibles={"individual_annual": 50.00, "individual_met": 50.00, "individual_remaining": 0.00,
                 "family_annual": 150.00, "family_met": 150.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive", "orthodontics"]},
    categories=category_block((100, 100), (100, 100), (80, 60), (50, 50), ortho=(50, 50)),
    procedures=proc_rows([
        {"code": "D1120", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 1,
         "last_paid": "2026-02-14", "next_eligible": "2026-08-14"},
        {"code": "D1206", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 1,
         "age_limit": "Through age 18"},
        {"code": "D1351", "pct": 100, "frequency": "1 per tooth per 36 mo",
         "age_limit": "Through age 15; permanent molars only"},
        {"code": "D8080", "pct": 50, "age_limit": "Dependents to age 19", "preauth": True,
         "notes": "Ortho paid as initial banding + quarterly installments to lifetime max"},
    ]),
    limitations={"missing_tooth_clause": False,
                 "waiting_periods": [],
                 "age_limits": [
                     {"ada_code": "D8080", "limit": "Dependent children to age 19"},
                     {"ada_code": "D1206", "limit": "Through age 18"}],
                 "downgrades": []},
    history=[
        {"date": "2026-02-14", "ada_code": "D1120", "description": "Child prophy", "tooth": None, "paid_amount": 72.00},
        {"date": "2026-02-14", "ada_code": "D0120", "description": "Periodic exam", "tooth": None, "paid_amount": 38.00},
    ],
))

# 5) INACTIVE / TERMINATED coverage --------------------------------------
records.append(record(
    ref="VR-2026-100005",
    completeness="eligibility_only",
    patient={"patient_id": "PT-0005", "first_name": "Gregory", "last_name": "Vasquez",
             "date_of_birth": "1968-12-04", "member_id": "GRD71006338",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Gregory", "last_name": "Vasquez",
                "member_id": "GRD71006338", "date_of_birth": "1968-12-04"},
    payer={"name": "Guardian", "payer_id": "GUARDIAN", "plan_name": "Guardian Dental PPO",
           "plan_type": "PPO", "group_number": "GRP-50914", "group_name": "Former: Atlas Freight"},
    coverage={"status": "terminated", "effective_date": "2018-03-01",
              "termination_date": "2025-12-31", "in_network": None,
              "plan_year_start": None, "plan_year_end": None},
    maxes={"annual_maximum": None, "annual_used": None, "annual_remaining": None,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": None, "individual_met": None, "individual_remaining": None,
                 "family_annual": None, "family_met": None,
                 "applies_to_categories": [], "waived_for_categories": []},
    categories={},
    procedures=[],
    limitations={"missing_tooth_clause": None, "waiting_periods": [],
                 "age_limits": [], "downgrades": []},
    disclaimers=[
        "Coverage terminated 2025-12-31. No active benefits on file. "
        "Patient should be treated as self-pay unless new coverage is provided."],
))

# 6) Active with COORDINATION OF BENEFITS (primary + secondary) ----------
records.append(record(
    ref="VR-2026-100006",
    patient={"patient_id": "PT-0006", "first_name": "Hannah", "last_name": "Brinstol",
             "date_of_birth": "1991-05-19", "member_id": "DDX559201144",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Hannah", "last_name": "Bristol",
                "member_id": "DDX559201144", "date_of_birth": "1991-05-19"},
    payer={"name": "Delta Dental", "payer_id": "DDCA", "plan_name": "Delta Dental PPO (Primary)",
           "plan_type": "PPO", "group_number": "GRP-88402", "group_name": "Vela Health Systems"},
    coverage={"status": "active", "effective_date": "2023-01-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 2000.00, "annual_used": 300.00, "annual_remaining": 1700.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 50.00, "individual_met": 50.00, "individual_remaining": 0.00,
                 "family_annual": 150.00, "family_met": 50.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 100), (100, 100), (80, 70), (50, 50)),
    procedures=proc_rows([
        {"code": "D0120", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 1},
        {"code": "D2392", "pct": 80, "frequency": "Once per surface per 24 mo"},
        {"code": "D2740", "pct": 50, "frequency": "1 per tooth per 5 years", "preauth": True},
    ]),
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [], "downgrades": []},
    cob={
        "has_other_coverage": True,
        "this_plan_order": "primary",
        "secondary": {
            "name": "MetLife", "payer_id": "METLIFE", "plan_name": "MetLife Dental PPO",
            "member_id": "MET33019887", "subscriber_relationship": "spouse",
            "coordination_method": "standard_cob",
            "note": "Secondary may cover patient responsibility up to its own allowable; "
                    "submit primary EOB with secondary claim."},
    },
))

# 7) Active DHMO/capitation - COPAY schedule, not percentages ------------
records.append(record(
    ref="VR-2026-100007",
    patient={"patient_id": "PT-0007", "first_name": "Tomas", "last_name": "Eklund",
             "date_of_birth": "1983-08-23", "member_id": "CIG44820190",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Tomas", "last_name": "Eklund",
                "member_id": "CIG44820190", "date_of_birth": "1983-08-23"},
    payer={"name": "Cigna", "payer_id": "CIGNA", "plan_name": "Cigna Dental Care DHMO",
           "plan_type": "DHMO", "group_number": "GRP-72100", "group_name": "Solano Manufacturing"},
    coverage={"status": "active", "effective_date": "2021-01-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31",
              "assigned_facility": "Required - patient must use assigned DHMO office"},
    maxes={"annual_maximum": None, "annual_used": None, "annual_remaining": None,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None,
           "note": "DHMO plans typically have no annual maximum; patient pays fixed copays"},
    deductibles={"individual_annual": None, "individual_met": None, "individual_remaining": None,
                 "family_annual": None, "family_met": None,
                 "applies_to_categories": [], "waived_for_categories": []},
    categories={},
    procedures=[
        {"ada_code": "D0120", "description": "Periodic oral evaluation", "category": "diagnostic",
         "patient_copay": 0.00, "coverage_percent": None, "frequency": "2 per year",
         "requires_preauth": False, "notes": "Copay schedule plan"},
        {"ada_code": "D1110", "description": "Prophylaxis - adult", "category": "preventive",
         "patient_copay": 0.00, "coverage_percent": None, "frequency": "2 per year",
         "requires_preauth": False, "notes": None},
        {"ada_code": "D2391", "description": "Resin composite - 1 surface", "category": "basic",
         "patient_copay": 38.00, "coverage_percent": None, "frequency": None,
         "requires_preauth": False, "notes": "Fixed copay per copay schedule"},
        {"ada_code": "D2750", "description": "Crown - PFM high noble", "category": "major",
         "patient_copay": 360.00, "coverage_percent": None, "frequency": "1 per tooth / 5 yr",
         "requires_preauth": True, "notes": "Fixed copay; lab fees may be additional"},
    ],
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [],
                 "downgrades": [],
                 "plan_note": "Benefits are copay-schedule based, not percentage-based. "
                              "Out-of-network services are not covered."},
))

# 8) Active with MISSING TOOTH CLAUSE excluding a bridge -----------------
records.append(record(
    ref="VR-2026-100008",
    patient={"patient_id": "PT-0008", "first_name": "Yusuf", "last_name": "Demir",
             "date_of_birth": "1972-02-17", "member_id": "MET77410025",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Yusuf", "last_name": "Demir",
                "member_id": "MET77410025", "date_of_birth": "1972-02-17"},
    payer={"name": "MetLife", "payer_id": "METLIFE", "plan_name": "MetLife Dental PPO",
           "plan_type": "PPO", "group_number": "GRP-19023", "group_name": "Pioneer Energy Partners"},
    coverage={"status": "active", "effective_date": "2017-01-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 1500.00, "annual_used": 0.00, "annual_remaining": 1500.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 50.00, "individual_met": 0.00, "individual_remaining": 50.00,
                 "family_annual": 150.00, "family_met": 0.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 100), (100, 100), (80, 60), (50, 50)),
    procedures=proc_rows([
        {"code": "D0150", "pct": 100, "frequency": "1 per 36 mo", "freq_remaining": 1},
        {"code": "D6240", "pct": 50, "preauth": True,
         "notes": "MISSING TOOTH CLAUSE: pontic for tooth missing prior to coverage "
                  "effective date is NOT covered. Verify extraction date."},
        {"code": "D6010", "pct": 50, "preauth": True,
         "notes": "Implant subject to missing tooth clause and major waiting period review"},
    ]),
    limitations={"missing_tooth_clause": True,
                 "missing_tooth_clause_detail":
                     "Prosthetic replacement of teeth lost before the member's effective "
                     "date (2017-01-01) is excluded.",
                 "waiting_periods": [],
                 "age_limits": [], "downgrades": []},
))

# 9) OUT-OF-NETWORK plan, lower reimbursement, UCR note ------------------
records.append(record(
    ref="VR-2026-100009",
    patient={"patient_id": "PT-0009", "first_name": "Eleanor", "last_name": "Whitcomb",
             "date_of_birth": "1958-07-09", "member_id": "AET19920047",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Eleanor", "last_name": "Whitcomb",
                "member_id": "AET19920047", "date_of_birth": "1958-07-09"},
    payer={"name": "Aetna", "payer_id": "AETNA", "plan_name": "Aetna Dental Indemnity",
           "plan_type": "Indemnity", "group_number": "GRP-40028", "group_name": "Retiree Trust 204"},
    coverage={"status": "active", "effective_date": "2010-01-01", "termination_date": None,
              "in_network": False, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31",
              "note": "Provider is out-of-network; benefits paid at UCR, patient responsible "
                      "for balance billing"},
    maxes={"annual_maximum": 1000.00, "annual_used": 0.00, "annual_remaining": 1000.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 100.00, "individual_met": 0.00, "individual_remaining": 100.00,
                 "family_annual": 300.00, "family_met": 0.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((80, 80), (80, 80), (60, 60), (40, 40)),
    procedures=proc_rows([
        {"code": "D0120", "pct": 80, "frequency": "2 per benefit year", "freq_remaining": 2,
         "notes": "Paid at 80% of UCR allowance; patient owes difference"},
        {"code": "D1110", "pct": 80, "frequency": "2 per benefit year", "freq_remaining": 2},
        {"code": "D2740", "pct": 40, "preauth": True,
         "notes": "40% of UCR; expect significant patient balance"},
    ]),
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [],
                 "downgrades": [],
                 "reimbursement_basis": "Usual, Customary & Reasonable (UCR) - 80th percentile"},
))

# 10) Active, FREQUENCY-LIMITED: recent cleaning, next eligible in future -
records.append(record(
    ref="VR-2026-100010",
    patient={"patient_id": "PT-0010", "first_name": "Devon", "last_name": "Marsh",
             "date_of_birth": "2000-04-25", "member_id": "GRD60155209",
             "relationship_to_subscriber": "self"},
    subscriber={"first_name": "Devon", "last_name": "Marsh",
                "member_id": "GRD60155209", "date_of_birth": "2000-04-25"},
    payer={"name": "Guardian", "payer_id": "GUARDIAN", "plan_name": "Guardian Dental PPO",
           "plan_type": "PPO", "group_number": "GRP-30551", "group_name": "Lumen Creative Group"},
    coverage={"status": "active", "effective_date": "2024-06-01", "termination_date": None,
              "in_network": True, "plan_year_start": f"{PLAN_YEAR}-01-01",
              "plan_year_end": f"{PLAN_YEAR}-12-31"},
    maxes={"annual_maximum": 1250.00, "annual_used": 133.00, "annual_remaining": 1117.00,
           "lifetime_orthodontic_maximum": None, "orthodontic_used": None},
    deductibles={"individual_annual": 50.00, "individual_met": 0.00, "individual_remaining": 50.00,
                 "family_annual": 150.00, "family_met": 0.00,
                 "applies_to_categories": ["basic", "major"],
                 "waived_for_categories": ["diagnostic", "preventive"]},
    categories=category_block((100, 80), (100, 80), (80, 50), (50, 50)),
    procedures=proc_rows([
        {"code": "D1110", "pct": 100, "frequency": "2 per benefit year (6-mo interval)",
         "freq_remaining": 1, "last_paid": "2026-05-05", "next_eligible": "2026-11-05",
         "notes": "Cleaned 25 days ago; next prophy not eligible until 2026-11-05"},
        {"code": "D0274", "pct": 100, "frequency": "1 per benefit year", "freq_remaining": 0,
         "last_paid": "2026-05-05", "next_eligible": "2027-01-01"},
        {"code": "D0120", "pct": 100, "frequency": "2 per benefit year", "freq_remaining": 1,
         "last_paid": "2026-05-05", "next_eligible": "2026-11-05"},
        {"code": "D2391", "pct": 80, "frequency": "Once per surface per 24 mo"},
    ]),
    limitations={"missing_tooth_clause": False, "waiting_periods": [],
                 "age_limits": [], "downgrades": []},
    history=[
        {"date": "2026-05-05", "ada_code": "D1110", "description": "Adult prophy", "tooth": None, "paid_amount": 88.00},
        {"date": "2026-05-05", "ada_code": "D0120", "description": "Periodic exam", "tooth": None, "paid_amount": 33.00},
        {"date": "2026-05-05", "ada_code": "D0274", "description": "Bitewings x4", "tooth": None, "paid_amount": 12.00},
    ],
))

db = {
    "_meta": {
        "description": "Mock dental eligibility & benefits database for development. "
                       "All patients and member data are fabricated.",
        "generated_for": "development_only",
        "as_of_date": TODAY,
        "plan_year": PLAN_YEAR,
        "record_count": len(records),
        "schema_version": "1.0",
        "scenarios": [
            "PT-0001 active PPO, deductible unmet, full annual max",
            "PT-0002 active PPO, deductible met, annual max nearly exhausted",
            "PT-0003 active PPO, in waiting period for basic & major",
            "PT-0004 dependent child, ortho with age + lifetime max",
            "PT-0005 terminated coverage / self-pay",
            "PT-0006 active with coordination of benefits (primary+secondary)",
            "PT-0007 DHMO copay-schedule plan (no percentages, no annual max)",
            "PT-0008 active with missing tooth clause excluding bridge/implant",
            "PT-0009 out-of-network indemnity, UCR reimbursement",
            "PT-0010 active, frequency-limited (recent cleaning, future eligibility)",
        ],
    },
    "patients": records,
}

with open("mock_eligibility_db.json", "w") as f:
    json.dump(db, f, indent=2)

print(f"Wrote mock_eligibility_db.json with {len(records)} patients.")
for r in records:
    p = r["patient"]
    c = r["coverage"]
    print(f"  {p['patient_id']}  {p['first_name']:8} {p['last_name']:12} "
          f"{r['payer']['name']:14} {r['payer']['plan_type']:10} {c['status']}")
