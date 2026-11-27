"""In-app alert notifications driven by a synthetic Live reading with MariaDB history."""

import asyncio
import logging
import os
import random
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from math import isfinite
from typing import Literal
from uuid import UUID, uuid4

import pymysql
from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, Response

from database import get_connection


router = APIRouter(prefix="/api/live/alerts/demo", tags=["Live alert demo"])
logger = logging.getLogger("uvicorn.error")

SOURCE = "simulation"
DEFAULT_UNIT_ID = "LRN-02"
DEFAULT_CHANNEL = "UGB X"
ENGINEERING_UNIT = "µm p-p"
DEMO_VALUES = (240, 260, 280, 355, 365)
DEMO_INTERVAL_SECONDS = 2.5
NORMAL_MINIMUM = 50
ALERT_THRESHOLD = 250
TRIP_THRESHOLD = 350
MAX_AGE_SECONDS = 90
PAGE_SIZE = 20

ALL_UNIT_CHANNELS: dict[str, tuple[str, ...]] = {
    "LRN-01": ("LGB X", "LGB Y", "TGB X", "TGB Y", "UGB X", "UGB Y"),
    "LRN-02": ("LGB X", "LGB Y", "TGB X", "TGB Y", "UGB X", "UGB Y"),
    "LRN-03": ("LGB X", "LGB Y", "TGB X", "TGB Y", "UGB X", "UGB Y"),
    "BLB-01": ("G X", "G Y"),
    "BLB-02": ("G X", "G Y"),
    "KRB-01": ("G X", "G Y", "T X", "T Y"),
    "KRB-02": ("G X", "G Y", "T X", "T Y"),
}
UNIT_ROTATION = tuple(ALL_UNIT_CHANNELS.keys())

Level = Literal["alert", "trip"]
DB_ERRORS = (pymysql.MySQLError, KeyError, ValueError, OSError)


@dataclass(frozen=True)
class DemoReading:
    value: float
    measured_at: datetime
    unit_id: str = DEFAULT_UNIT_ID
    channel: str = DEFAULT_CHANNEL
    unit: str = ENGINEERING_UNIT
    quality: str = "good"


@dataclass
class ActiveAlert:
    id: str
    unit_id: str
    channel: str
    level: Level
    threshold: int
    first_value: float
    peak_value: float
    last_value: float
    measured_at: datetime
    last_measured_at: datetime


def _to_utc_naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None)


def _from_utc_naive(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_before(before: str | None) -> int | None:
    if before is None or before.strip() == "":
        return None
    raw = before.strip()
    if not raw.isdigit() or int(raw) <= 0:
        raise HTTPException(422, "Parameter cursor 'before' tidak valid.")
    return int(raw)


def _normalize_unit_filter(unit_id: str | None) -> str | None:
    if unit_id is None:
        return None
    cleaned = unit_id.strip().upper()
    if cleaned == "" or cleaned == "ALL":
        return None
    if cleaned not in ALL_UNIT_CHANNELS:
        raise HTTPException(422, f"Unit '{unit_id}' tidak dikenali.")
    return cleaned


class AlertHistory:
    def check_available(self) -> None:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT sequence_id FROM live_alert_notifications LIMIT 1"
                )
                cursor.fetchone()
        finally:
            if connection is not None:
                connection.close()

    def list_events(
        self,
        before: int | None = None,
        unit_id: str | None = None,
        limit: int = PAGE_SIZE,
    ) -> tuple[list[dict], str | None]:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                where_parts = ["source = %s"]
                params: list[object] = [SOURCE]

                if unit_id is not None:
                    where_parts.append("unit_id = %s")
                    params.append(unit_id)
                if before is not None:
                    where_parts.append("sequence_id < %s")
                    params.append(before)

                params.append(limit + 1)
                where_sql = " AND ".join(where_parts)

                cursor.execute(
                    f"""
                    SELECT
                        sequence_id,
                        event_id,
                        unit_id,
                        channel,
                        engineering_unit,
                        level,
                        threshold,
                        first_value,
                        peak_value,
                        last_value,
                        measured_at,
                        last_measured_at,
                        acknowledged_at
                    FROM live_alert_notifications
                    WHERE {where_sql}
                    ORDER BY sequence_id DESC
                    LIMIT %s
                    """,
                    tuple(params),
                )
                rows = cursor.fetchall()
        finally:
            if connection is not None:
                connection.close()

        has_more = len(rows) > limit
        page_rows = rows[:limit]
        next_before = (
            str(page_rows[-1]["sequence_id"]) if has_more and page_rows else None
        )

        events = [
            {
                "id": row["event_id"],
                "unit_id": row["unit_id"],
                "channel": row["channel"],
                "level": row["level"],
                "threshold": int(row["threshold"]),
                "first_value": float(row["first_value"]),
                "peak_value": float(row["peak_value"]),
                "last_value": float(row["last_value"]),
                "measured_at": _from_utc_naive(row["measured_at"]),
                "last_measured_at": _from_utc_naive(row["last_measured_at"]),
                "acknowledged_at": _from_utc_naive(row["acknowledged_at"]),
            }
            for row in page_rows
        ]
        return events, next_before

    def insert_event(self, event: ActiveAlert) -> None:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO live_alert_notifications (
                        event_id,
                        source,
                        unit_id,
                        channel,
                        engineering_unit,
                        level,
                        threshold,
                        first_value,
                        peak_value,
                        last_value,
                        measured_at,
                        last_measured_at,
                        acknowledged_at
                    ) VALUES (
                        %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NULL
                    )
                    """,
                    (
                        event.id,
                        SOURCE,
                        event.unit_id,
                        event.channel,
                        ENGINEERING_UNIT,
                        event.level,
                        event.threshold,
                        event.first_value,
                        event.peak_value,
                        event.last_value,
                        _to_utc_naive(event.measured_at),
                        _to_utc_naive(event.last_measured_at),
                    ),
                )
        finally:
            if connection is not None:
                connection.close()

    def update_event(self, event: ActiveAlert) -> None:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE live_alert_notifications
                    SET peak_value = %s,
                        last_value = %s,
                        last_measured_at = %s
                    WHERE event_id = %s
                      AND source = %s
                    """,
                    (
                        event.peak_value,
                        event.last_value,
                        _to_utc_naive(event.last_measured_at),
                        event.id,
                        SOURCE,
                    ),
                )
        finally:
            if connection is not None:
                connection.close()

    def acknowledge(self, event_id: str, acknowledged_at: datetime) -> bool:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                cursor.execute(
                    """
                    SELECT event_id, acknowledged_at
                    FROM live_alert_notifications
                    WHERE event_id = %s
                      AND source = %s
                    LIMIT 1
                    """,
                    (event_id, SOURCE),
                )
                row = cursor.fetchone()
                if row is None:
                    return False

                if row["acknowledged_at"] is None:
                    cursor.execute(
                        """
                        UPDATE live_alert_notifications
                        SET acknowledged_at = %s
                        WHERE event_id = %s
                          AND source = %s
                          AND acknowledged_at IS NULL
                        """,
                        (_to_utc_naive(acknowledged_at), event_id, SOURCE),
                    )
                return True
        finally:
            if connection is not None:
                connection.close()


class AlertDemo:
    def __init__(self, history: AlertHistory | None = None) -> None:
        self.instance_id = str(uuid4())
        self.history = history or AlertHistory()
        self.task: asyncio.Task[None] | None = None
        self.reading: DemoReading | None = None
        self.highest: ActiveAlert | None = None
        self.current_unit_id: str = DEFAULT_UNIT_ID
        self.current_channel: str = DEFAULT_CHANNEL
        self.rotation_idx: int = 0
        self.revision = 0
        self.run_failed = False

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    def _pick_run_targets(
        self, requested_unit_id: str | None
    ) -> tuple[tuple[str, str], tuple[str, str]]:
        if requested_unit_id is not None:
            channels = ALL_UNIT_CHANNELS[requested_unit_id]
            ch1 = random.choice(channels)
            ch2 = random.choice(channels)
            return (requested_unit_id, ch1), (requested_unit_id, ch2)

        # Mode Semua Unit: otomatis bergilir lintas 3 PLTA (7 unit)
        u1 = UNIT_ROTATION[self.rotation_idx % len(UNIT_ROTATION)]
        u2 = UNIT_ROTATION[(self.rotation_idx + 2) % len(UNIT_ROTATION)]
        self.rotation_idx = (self.rotation_idx + 1) % len(UNIT_ROTATION)
        return (
            (u1, random.choice(ALL_UNIT_CHANNELS[u1])),
            (u2, random.choice(ALL_UNIT_CHANNELS[u2])),
        )

    async def snapshot(
        self,
        before: int | None = None,
        unit_id: str | None = None,
    ) -> dict:
        history_unavailable = False
        events: list[dict] = []
        next_before: str | None = None

        try:
            events, next_before = await asyncio.to_thread(
                self.history.list_events,
                before,
                unit_id,
                PAGE_SIZE,
            )
        except DB_ERRORS as error:
            logger.error("Gagal membaca riwayat notifikasi simulasi: %s", error)
            history_unavailable = True

        return {
            "enabled": True,
            "instance_id": self.instance_id,
            "revision": self.revision,
            "running": self.running,
            "history_unavailable": history_unavailable,
            "run_failed": self.run_failed,
            "unit_id": self.current_unit_id,
            "channel": self.current_channel,
            "unit": ENGINEERING_UNIT,
            "reading": asdict(self.reading) if self.reading else None,
            "events": events,
            "next_before": next_before,
        }

    async def evaluate(self, reading: DemoReading) -> None:
        age = (datetime.now(timezone.utc) - reading.measured_at).total_seconds()
        if (
            reading.quality != "good"
            or reading.unit != ENGINEERING_UNIT
            or not isfinite(reading.value)
            or reading.value < 0
            or not -5 <= age <= MAX_AGE_SECONDS
            or (
                self.reading is not None
                and reading.measured_at <= self.reading.measured_at
            )
        ):
            return

        self.reading = reading
        self.current_unit_id = reading.unit_id
        self.current_channel = reading.channel
        self.revision += 1
        value = reading.value
        if value < ALERT_THRESHOLD:
            if value >= NORMAL_MINIMUM:
                self.highest = None
            return

        level: Level = "trip" if value >= TRIP_THRESHOLD else "alert"
        if (
            self.highest is not None
            and self.highest.unit_id == reading.unit_id
            and self.highest.channel == reading.channel
        ):
            if self.highest.level == level or self.highest.level == "trip":
                self.highest.last_value = value
                self.highest.peak_value = max(self.highest.peak_value, value)
                self.highest.last_measured_at = reading.measured_at
                await asyncio.to_thread(self.history.update_event, self.highest)
                return

        event = ActiveAlert(
            id=str(uuid4()),
            unit_id=reading.unit_id,
            channel=reading.channel,
            level=level,
            threshold=TRIP_THRESHOLD if level == "trip" else ALERT_THRESHOLD,
            first_value=value,
            peak_value=value,
            last_value=value,
            measured_at=reading.measured_at,
            last_measured_at=reading.measured_at,
        )
        await asyncio.to_thread(self.history.insert_event, event)
        self.highest = event

    async def start(self, requested_unit_id: str | None = None) -> None:
        if self.running:
            raise HTTPException(409, "Simulasi masih berjalan.")

        try:
            await asyncio.to_thread(self.history.check_available)
        except DB_ERRORS as error:
            logger.error("Riwayat notifikasi tidak tersedia saat start: %s", error)
            raise HTTPException(
                503,
                "Riwayat notifikasi tidak tersedia. Periksa MariaDB dan tabel live_alert_notifications.",
            ) from None

        (alert_unit, alert_ch), (trip_unit, trip_ch) = self._pick_run_targets(
            requested_unit_id
        )
        steps: list[tuple[float, str, str]] = [
            (DEMO_VALUES[0], alert_unit, alert_ch),
            (DEMO_VALUES[1], alert_unit, alert_ch),
            (DEMO_VALUES[2], alert_unit, alert_ch),
            (DEMO_VALUES[3], trip_unit, trip_ch),
            (DEMO_VALUES[4], trip_unit, trip_ch),
        ]

        self.reading = None
        self.highest = None
        self.current_unit_id = alert_unit
        self.current_channel = alert_ch
        self.run_failed = False
        self.revision += 1

        try:
            first_val, first_unit, first_ch = steps[0]
            await self.evaluate(
                DemoReading(
                    value=first_val,
                    measured_at=datetime.now(timezone.utc),
                    unit_id=first_unit,
                    channel=first_ch,
                )
            )
        except DB_ERRORS as error:
            self.run_failed = True
            self.revision += 1
            logger.error("Penulisan awal simulasi gagal: %s", error)
            raise HTTPException(
                503,
                "Gagal menulis simulasi ke database.",
            ) from None

        self.task = asyncio.create_task(self.run(steps[1:]))

    async def run(self, remaining_steps: list[tuple[float, str, str]]) -> None:
        try:
            for value, u_id, ch in remaining_steps:
                await asyncio.sleep(DEMO_INTERVAL_SECONDS)
                await self.evaluate(
                    DemoReading(
                        value=value,
                        measured_at=datetime.now(timezone.utc),
                        unit_id=u_id,
                        channel=ch,
                    )
                )
        except DB_ERRORS as error:
            self.run_failed = True
            logger.error("Simulasi berhenti karena penulisan DB gagal: %s", error)
        finally:
            self.revision += 1

    async def acknowledge(self, event_id: UUID) -> None:
        try:
            found = await asyncio.to_thread(
                self.history.acknowledge,
                str(event_id),
                datetime.now(timezone.utc),
            )
        except DB_ERRORS as error:
            logger.error("Gagal menyimpan ACK notifikasi: %s", error)
            raise HTTPException(
                503,
                "Status sudah dilihat belum dapat disimpan. Periksa koneksi database.",
            ) from None

        if not found:
            raise HTTPException(404, "Notifikasi simulasi tidak ditemukan.")
        self.revision += 1


@asynccontextmanager
async def live_alert_lifespan(app: FastAPI):
    demo = (
        AlertDemo()
        if os.getenv("HYDRO_LIVE_ALERT_DEMO", "").strip() == "1"
        else None
    )
    app.state.live_alert_demo = demo
    try:
        yield
    finally:
        if demo and demo.running:
            assert demo.task is not None
            demo.task.cancel()
            with suppress(asyncio.CancelledError):
                await demo.task


def require_demo(request: Request) -> AlertDemo:
    demo = getattr(request.app.state, "live_alert_demo", None)
    if demo is None:
        raise HTTPException(404, "Simulasi notifikasi belum diaktifkan.")
    return demo


@router.get("")
async def get_demo(
    request: Request,
    response: Response,
    before: str | None = Query(default=None),
    unit_id: str | None = Query(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    before_seq = _parse_before(before)
    unit_filter = _normalize_unit_filter(unit_id)
    demo = getattr(request.app.state, "live_alert_demo", None)
    return (
        await demo.snapshot(before=before_seq, unit_id=unit_filter)
        if demo
        else {"enabled": False}
    )


@router.post("/start")
async def start_demo(
    request: Request,
    response: Response,
    unit_id: str | None = Query(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    unit_filter = _normalize_unit_filter(unit_id)
    demo = require_demo(request)
    await demo.start(requested_unit_id=unit_filter)
    return await demo.snapshot(unit_id=unit_filter)


@router.post("/{event_id}/ack")
async def acknowledge_demo_alert(
    event_id: UUID,
    request: Request,
    response: Response,
    before: str | None = Query(default=None),
    unit_id: str | None = Query(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    before_seq = _parse_before(before)
    unit_filter = _normalize_unit_filter(unit_id)
    demo = require_demo(request)
    await demo.acknowledge(event_id)
    return await demo.snapshot(before=before_seq, unit_id=unit_filter)