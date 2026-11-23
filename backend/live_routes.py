import json
import math
import os
from datetime import datetime, timezone
from typing import Literal
from urllib.error import URLError
from urllib.parse import parse_qsl, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from fastapi import APIRouter, Path, Response
from pydantic import AwareDatetime, BaseModel, Field, FiniteFloat, ValidationError


router = APIRouter(prefix="/api/live", tags=["Live"])
MAX_RESPONSE_BYTES = 256 * 1024

# (unit_id, plant, name, phase, base_mw, setpoint_mw, eff_mw_per_m3s)
SIMULATED_UNITS = (
    ("LRN-01", "Larona", "Unit 1", 0.0, 50.5, 57.0, 1.21),
    ("LRN-02", "Larona", "Unit 2", 1.1, 52.0, 58.0, 1.23),
    ("LRN-03", "Larona", "Unit 3", 2.2, 51.2, 58.0, 1.22),
    ("BLB-01", "Balambano", "Unit 1", 5.5, 52.8, 57.0, 1.23),
    ("BLB-02", "Balambano", "Unit 2", 6.6, 56.4, 65.0, 1.21),
    ("KRB-01", "Karebbe", "Unit 1", 3.3, 37.5, 45.0, 0.61),
    ("KRB-02", "Karebbe", "Unit 2", 4.4, 50.8, 49.0, 0.65),
)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class LiveReading(BaseModel):
    channel: str = Field(min_length=1, max_length=128)
    value: FiniteFloat | None
    unit: str = Field(max_length=30)
    measured_at: AwareDatetime
    quality: Literal["good", "uncertain", "bad", "unknown"]


class LiveSnapshot(BaseModel):
    unit_id: str
    readings: list[LiveReading] = Field(max_length=128)


def _simulation_enabled() -> bool:
    return os.getenv("HYDRO_LIVE_ALERT_DEMO", "").strip() == "1"


def _wave(t: float, base: float, amp1: float, amp2: float, p1: float, p2: float, phase: float) -> float:
    val = base + amp1 * math.sin(t / p1 + phase) + amp2 * math.cos(t / p2 + phase * 1.3)
    return round(max(5.0, val), 2)


def _simulated_vibration_channels(unit_id: str, t: float, phase: float) -> list[tuple[str, float, str]]:
    if unit_id.startswith("LRN-"):
        return [
            ("LGB X", _wave(t, 122.0, 18.0, 8.0, 5.0, 2.1, phase), "µm p-p"),
            ("LGB Y", _wave(t, 115.0, 16.0, 7.0, 5.4, 2.4, phase + 0.5), "µm p-p"),
            ("TGB X", _wave(t, 92.0, 15.0, 9.0, 4.3, 1.8, phase + 1.0), "µm p-p"),
            ("TGB Y", _wave(t, 118.0, 17.0, 8.0, 4.7, 2.0, phase + 1.5), "µm p-p"),
            ("UGB X", _wave(t, 188.0, 14.0, 6.0, 6.1, 2.6, phase + 2.0), "µm p-p"),
            ("UGB Y", _wave(t, 184.0, 13.0, 6.0, 6.4, 2.9, phase + 2.5), "µm p-p"),
        ]
    if unit_id.startswith("KRB-"):
        return [
            ("G X", _wave(t, 78.0, 24.0, 11.0, 4.6, 1.9, phase), "µm p-p"),
            ("G Y", _wave(t, 64.0, 18.0, 9.0, 5.1, 2.2, phase + 0.6), "µm p-p"),
            ("T X", _wave(t, 56.0, 12.0, 6.0, 4.2, 1.7, phase + 1.2), "µm p-p"),
            ("T Y", _wave(t, 58.0, 11.0, 5.0, 4.8, 2.1, phase + 1.8), "µm p-p"),
        ]
    return [
        ("G X", _wave(t, 148.0, 14.0, 7.0, 5.2, 2.2, phase), "µm p-p"),
        ("G Y", _wave(t, 154.0, 15.0, 6.0, 5.6, 2.5, phase + 0.7), "µm p-p"),
    ]


def _unit_meta(unit_id: str) -> tuple[float, float, float, float]:
    for uid, _plant, _name, unit_phase, mw, setpoint, eff in SIMULATED_UNITS:
        if uid == unit_id:
            return unit_phase, mw, setpoint, eff
    return (sum(ord(ch) for ch in unit_id) % 11 * 0.6), 52.0, 58.0, 1.2


def _simulated_readings(unit_id: str, now: datetime) -> list[dict]:
    phase, base_mw, _setpoint, _eff = _unit_meta(unit_id)
    t = now.timestamp()
    vibration_items = _simulated_vibration_channels(unit_id, t, phase)

    bearing_temp = round(56.5 + 2.4 * math.sin(t / 18.0 + phase), 2)
    oil_temp = round(45.2 + 1.8 * math.cos(t / 21.0 + phase), 2)
    active_power = round(base_mw + 2.4 * math.sin(t / 14.0 + phase), 2)
    reactive_power = round(17.5 + 2.8 * math.cos(t / 16.0 + phase), 2)
    voltage = round(13.8 + 0.14 * math.sin(t / 12.0 + phase), 2)
    current = round(2420.0 + 85.0 * math.sin(t / 14.0 + phase), 1)
    speed = round(333.3 + 0.6 * math.sin(t / 9.0 + phase), 2)
    wicket_gate = round(71.5 + 3.2 * math.sin(t / 14.0 + phase), 2)

    other_items = [
        ("Temperatur Bearing", bearing_temp, "°C"),
        ("Temperatur Oli Bearing", oil_temp, "°C"),
        ("Daya Aktif", active_power, "MW"),
        ("Daya Reaktif", reactive_power, "MVAr"),
        ("Tegangan", voltage, "kV"),
        ("Arus", current, "A"),
        ("Kecepatan Putaran", speed, "rpm"),
        ("Bukaan Wicket Gate", wicket_gate, "%"),
    ]

    return [
        {
            "channel": channel,
            "value": value,
            "unit": unit,
            "measured_at": now,
            "quality": "good",
            "fresh": True,
        }
        for channel, value, unit in [*vibration_items, *other_items]
    ]


def _simulated_hydrology(now: datetime, blb_outflow: float, krb_outflow: float) -> dict:
    t = now.timestamp()
    return {
        "matano_level": round(391.41 + 0.03 * math.sin(t / 40.0), 2),
        "mahalona_level": round(323.72 + 0.03 * math.cos(t / 42.0), 2),
        "towuti_level": round(316.83 + 0.02 * math.sin(t / 38.0), 2),
        "batubesi_dam_level": round(316.48 + 0.02 * math.sin(t / 35.0), 2),
        "upper_canal_level": round(316.37 + 0.02 * math.cos(t / 30.0), 2),
        "canal_flow_rate": round(103.77 + 1.8 * math.sin(t / 18.0), 2),
        "lower_canal_level": round(314.19 + 0.03 * math.sin(t / 28.0), 2),
        "larona_tailrace_level": round(165.90 + 0.05 * math.cos(t / 24.0), 2),
        "balambano_dam_level": round(164.90 + 0.04 * math.sin(t / 26.0), 2),
        "balambano_tailrace_level": round(97.22 + 0.06 * math.cos(t / 22.0), 2),
        "balambano_outflow": round(blb_outflow, 2),
        "karebbe_dam_level": round(77.53 + 0.04 * math.sin(t / 25.0), 2),
        "karebbe_tailrace_level": round(10.50 + 0.03 * math.cos(t / 20.0), 2),
        "karebbe_outflow": round(krb_outflow, 2),
        "petea_gates": [
            {"gate": 1, "open": False},
            {"gate": 2, "open": True},
            {"gate": 3, "open": False},
            {"gate": 4, "open": True},
            {"gate": 5, "open": True},
            {"gate": 6, "open": True},
        ],
        "spillway_gates": [
            {"name": "SPG #1", "open_pct": 0.0, "flow_cumecs": 0.0},
            {"name": "SPG #2", "open_pct": 0.0, "flow_cumecs": 0.0},
            {"name": "SPG #3", "open_pct": 50.0, "flow_cumecs": round(81.95 + 0.9 * math.sin(t / 20.0), 2)},
        ],
    }


def read_snapshot(source_url, unit_id):
    url = urlsplit(source_url)
    loopback = url.hostname in {"127.0.0.1", "localhost", "::1"}
    if not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("Invalid live feed URL")
    if url.scheme != "https" and not (url.scheme == "http" and loopback):
        raise ValueError("The live feed requires HTTPS")

    query = [(name, value) for name, value in parse_qsl(url.query) if name != "unit_id"]
    query.append(("unit_id", unit_id))
    request = Request(url._replace(query=urlencode(query)).geturl(), headers={"Accept": "application/json"})
    token = os.getenv("HYDRO_LIVE_FEED_TOKEN", "").strip()
    if token:
        request.add_header("Authorization", f"Bearer {token}")

    with build_opener(NoRedirect()).open(request, timeout=4) as upstream:
        data = upstream.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise ValueError("Live feed response exceeds size limit")

    payload = LiveSnapshot.model_validate(json.loads(data))
    if payload.unit_id != unit_id:
        raise ValueError("The live feed returned another unit")
    if len({reading.channel for reading in payload.readings}) != len(payload.readings):
        raise ValueError("The live feed returned duplicate channels")
    return payload.readings


@router.get("/overview")
def latest_live_overview(response: Response):
    response.headers["Cache-Control"] = "no-store"
    source_url = os.getenv("HYDRO_LIVE_FEED_URL", "").strip()
    if source_url or not _simulation_enabled():
        return {"status": "not_configured", "simulated": False, "units": [], "hydrology": None}

    now = datetime.now(timezone.utc)
    units_data = []
    blb_outflow = 0.0
    krb_outflow = 0.0

    for unit_id, plant, name, _phase, _mw, setpoint, eff_ratio in SIMULATED_UNITS:
        readings = _simulated_readings(unit_id, now)
        pa_mw = next((r["value"] for r in readings if r["channel"] == "Daya Aktif"), 0.0) or 0.0
        pr_mvar = next((r["value"] for r in readings if r["channel"] == "Daya Reaktif"), 0.0) or 0.0
        penstock_flow = round(pa_mw / eff_ratio, 2) if eff_ratio > 0 else 0.0
        efficiency = round(pa_mw / penstock_flow, 2) if penstock_flow > 0 else 0.0

        if plant == "Balambano":
            blb_outflow += penstock_flow
        elif plant == "Karebbe":
            krb_outflow += penstock_flow

        units_data.append(
            {
                "unit_id": unit_id,
                "plant": plant,
                "name": name,
                "status": "live",
                "ops": {
                    "pa_mw": round(pa_mw, 2),
                    "pa_setpoint_mw": round(setpoint, 2),
                    "pr_mvar": round(pr_mvar, 2),
                    "penstock_flow": penstock_flow,
                    "efficiency": efficiency,
                },
                "readings": readings,
            }
        )

    hydrology = _simulated_hydrology(now, blb_outflow, krb_outflow)
    return {
        "status": "live",
        "simulated": True,
        "units": units_data,
        "hydrology": hydrology,
    }


@router.get("/units/{unit_id}")
def latest_live_unit(
    response: Response,
    unit_id: str = Path(pattern=r"^[A-Z0-9][A-Z0-9-]{0,31}$"),
):
    response.headers["Cache-Control"] = "no-store"
    source_url = os.getenv("HYDRO_LIVE_FEED_URL", "").strip()
    if not source_url:
        if _simulation_enabled():
            now = datetime.now(timezone.utc)
            return {
                "status": "live",
                "simulated": True,
                "readings": _simulated_readings(unit_id, now),
            }
        return {"status": "not_configured", "simulated": False, "readings": []}

    try:
        max_age = int(os.getenv("HYDRO_LIVE_MAX_AGE_SECONDS", "90"))
        if max_age < 1:
            raise ValueError("Invalid live freshness interval")
        readings = read_snapshot(source_url, unit_id)
    except (OSError, URLError, ValueError, ValidationError, RecursionError):
        return {"status": "unavailable", "simulated": False, "readings": []}

    if not readings:
        return {"status": "no_data", "simulated": False, "readings": []}

    now = datetime.now(timezone.utc)
    rows = []
    for reading in readings:
        age_seconds = (now - reading.measured_at).total_seconds()
        fresh = -5 <= age_seconds <= max_age
        rows.append({**reading.model_dump(), "fresh": fresh})

    if any(row["fresh"] and row["quality"] == "good" and row["value"] is not None for row in rows):
        status = "live"
    elif any(row["fresh"] for row in rows):
        status = "quality_issue"
    else:
        status = "stale"

    return {"status": status, "simulated": False, "readings": rows}