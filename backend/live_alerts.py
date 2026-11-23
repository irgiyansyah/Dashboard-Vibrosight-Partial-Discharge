"""In-app alert notifications driven by a synthetic Live reading with MariaDB history."""

import asyncio
import logging
import os
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
UNIT_ID = "LRN-02"
CHANNEL = "Getaran X"
ENGINEERING_UNIT = "µm p-p"
DEMO_VALUES = (240, 260, 280, 355, 365)
DEMO_INTERVAL_SECONDS = 2.5
NORMAL_MINIMUM = 50
ALERT_THRESHOLD = 250
TRIP_THRESHOLD = 350
MAX_AGE_SECONDS = 90
PAGE_SIZE = 20

Level = Literal["alert", "trip"]
DB_ERRORS = (pymysql.MySQLError, KeyError, ValueError, OSError)


@dataclass(frozen=True)
class DemoReading:
    value: float
    measured_at: datetime
    unit: str = ENGINEERING_UNIT
    quality: str = "good"


@dataclass
class ActiveAlert:
    id: str
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
        limit: int = PAGE_SIZE,
    ) -> tuple[list[dict], str | None]:
        connection = None
        try:
            connection = get_connection()
            with connection.cursor() as cursor:
                if before is not None:
                    cursor.execute(
                        """
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
                        WHERE source = %s
                          AND sequence_id < %s
                        ORDER BY sequence_id DESC
                        LIMIT %s
                        """,
                        (SOURCE, before, limit + 1),
                    )
                else:
                    cursor.execute(
                        """
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
                        WHERE source = %s
                        ORDER BY sequence_id DESC
                        LIMIT %s
                        """,
                        (SOURCE, limit + 1),
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
                        UNIT_ID,
                        CHANNEL,
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
        self.revision = 0
        self.run_failed = False

    @property
    def running(self) -> bool:
        return self.task is not None and not self.task.done()

    async def snapshot(self, before: int | None = None) -> dict:
        history_unavailable = False
        events: list[dict] = []
        next_before: str | None = None

        try:
            events, next_before = await asyncio.to_thread(
                self.history.list_events,
                before,
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
            "unit_id": UNIT_ID,
            "channel": CHANNEL,
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
        self.revision += 1
        value = reading.value
        if value < ALERT_THRESHOLD:
            if value >= NORMAL_MINIMUM:
                self.highest = None
            return

        level: Level = "trip" if value >= TRIP_THRESHOLD else "alert"
        if self.highest is not None:
            if self.highest.level == level or self.highest.level == "trip":
                self.highest.last_value = value
                self.highest.peak_value = max(self.highest.peak_value, value)
                self.highest.last_measured_at = reading.measured_at
                await asyncio.to_thread(self.history.update_event, self.highest)
                return

        event = ActiveAlert(
            id=str(uuid4()),
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

    async def start(self) -> None:
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

        self.reading = None
        self.highest = None
        self.run_failed = False
        self.revision += 1

        try:
            await self.evaluate(DemoReading(DEMO_VALUES[0], datetime.now(timezone.utc)))
        except DB_ERRORS as error:
            self.run_failed = True
            self.revision += 1
            logger.error("Penulisan awal simulasi gagal: %s", error)
            raise HTTPException(
                503,
                "Gagal menulis simulasi ke database.",
            ) from None

        self.task = asyncio.create_task(self.run())

    async def run(self) -> None:
        try:
            for value in DEMO_VALUES[1:]:
                await asyncio.sleep(DEMO_INTERVAL_SECONDS)
                await self.evaluate(DemoReading(value, datetime.now(timezone.utc)))
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
):
    response.headers["Cache-Control"] = "no-store"
    before_seq = _parse_before(before)
    demo = getattr(request.app.state, "live_alert_demo", None)
    return await demo.snapshot(before=before_seq) if demo else {"enabled": False}


@router.post("/start")
async def start_demo(request: Request, response: Response):
    response.headers["Cache-Control"] = "no-store"
    demo = require_demo(request)
    await demo.start()
    return await demo.snapshot()


@router.post("/{event_id}/ack")
async def acknowledge_demo_alert(
    event_id: UUID,
    request: Request,
    response: Response,
    before: str | None = Query(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    before_seq = _parse_before(before)
    demo = require_demo(request)
    await demo.acknowledge(event_id)
    return await demo.snapshot(before=before_seq)