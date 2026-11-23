import csv
import re
from datetime import date, datetime, time, timedelta
from heapq import merge
from io import StringIO
from itertools import groupby
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse

from monitoring_routes import read_cursor


router = APIRouter(prefix="/api/exports", tags=["Export"])
PAGE_SIZE = 2000

OPERATING_PARAMETERS = {
    "mw": (1, "Daya aktif"),
    "mvar": (2, "Daya reaktif"),
    "kv": (3, "Tegangan"),
    "a": (4, "Arus"),
    "rpm": (5, "Kecepatan"),
}


def csv_text(value):
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value


def column_label(channel):
    tag = channel["tag_name"]
    unit = (channel["engineering_unit"] or "").strip()
    definition = (channel["measurement_definition"] or "").lower()
    kind = channel["measurement_type"]
    if kind == "vibration":
        order, label = 0, "Getaran"
        if unit.lower() in ("µm", "μm", "um") and re.search(r"peak[\s_-]*to[\s_-]*peak", definition):
            unit = "µm p-p"
    elif kind == "temperature":
        order, label = 7, "Temperatur oli" if "oil" in definition else "Temperatur"
    elif kind == "partial_discharge":
        order, label = 8, "Partial discharge"
    elif "wicket gate" in definition:
        order, label = 6, "Bukaan wicket gate"
    else:
        order, label = OPERATING_PARAMETERS.get(unit.lower(), (9, "Parameter"))

    title = f"{label} ({unit})" if unit else label
    return order, f"{title} · {tag}"


def channel_rows(cursor, channel_id, start, end, page_size):
    after = None
    while True:
        after_clause = "" if after is None else "AND measured_at > %s"
        params = (channel_id, start, end) if after is None else (channel_id, start, end, after)
        cursor.execute(
            f"""
            SELECT measured_at, measured_value, quality, import_batch_id
            FROM measurements
            WHERE channel_id = %s AND measured_at >= %s AND measured_at < %s
            {after_clause}
            ORDER BY measured_at
            LIMIT %s
            """,
            (*params, page_size),
        )
        rows = cursor.fetchall()
        yield from rows
        if len(rows) < page_size:
            break
        after = rows[-1]["measured_at"]


def detail_rows(cursor, unit_id, channels, start, end):
    yield [
        "unit_id", "channel_id", "tag_name", "measurement_type",
        "engineering_unit", "measurement_definition",
        "measured_at", "measured_value", "quality", "import_batch_id",
    ]
    for channel in channels:
        metadata = [
            csv_text(unit_id), channel["id"], csv_text(channel["tag_name"]),
            channel["measurement_type"], csv_text(channel["engineering_unit"]),
            csv_text(channel["measurement_definition"]),
        ]
        for row in channel_rows(cursor, channel["id"], start, end, PAGE_SIZE):
            yield [
                *metadata, row["measured_at"].isoformat(sep=" "),
                row["measured_value"], row["quality"], row["import_batch_id"],
            ]


def wide_rows(plant, unit_id, channels, streams):
    yield [
        "PLTA", "Unit", "Waktu pengukuran",
        *(column_label(channel)[1] for channel in channels),
        "Catatan kualitas per kanal",
    ]
    # Gabungkan kanal berdasarkan timestamp asli.
    def tagged(index, rows):
        for row in rows:
            yield index, row


    indexed = [tagged(index, rows) for index, rows in enumerate(streams)]
    ordered = merge(*indexed, key=lambda entry: entry[1]["measured_at"])
    for measured_at, readings in groupby(ordered, key=lambda entry: entry[1]["measured_at"]):
        values = [None] * len(channels)
        notes = []
        for index, row in readings:
            values[index] = row["measured_value"]
            if row["quality"] != "unverified":
                notes.append(f'{channels[index]["tag_name"]}: {row["quality"]}')
        yield [
            csv_text(plant), csv_text(unit_id), measured_at.isoformat(sep=" "),
            *values, csv_text(" / ".join(notes)),
        ]


def measurement_chunks(unit, start, end, layout):
    unit_id = unit["id"]
    buffer = StringIO(newline="")
    writer = csv.writer(buffer)
    with read_cursor() as cursor:
        cursor.execute(
            """
            SELECT c.id, c.tag_name, c.measurement_type, c.engineering_unit,
                   c.measurement_definition
            FROM channels AS c
            WHERE c.unit_id = %s AND EXISTS (
                SELECT 1 FROM measurements AS m
                WHERE m.channel_id = c.id AND m.measured_at >= %s AND m.measured_at < %s
            )
            ORDER BY c.id
            """,
            (unit_id, start, end),
        )
        channels = cursor.fetchall()

        if layout == "wide":
            channels = sorted(channels, key=column_label)
            # Ukuran halaman dibagi agar pemakaian memori tidak berlipat pada unit dengan banyak kanal.
            channel_page = max(1, PAGE_SIZE // max(1, len(channels)))
            streams = [channel_rows(cursor, channel["id"], start, end, channel_page) for channel in channels]
            rows = wide_rows(unit["plant"], unit_id, channels, streams)
        else:
            rows = detail_rows(cursor, unit_id, channels, start, end)

        writer.writerow(next(rows))
        yield ("\ufeff" + buffer.getvalue()).encode("utf-8")
        buffer.seek(0)
        buffer.truncate(0)

        for count, row in enumerate(rows, start=1):
            writer.writerow(row)
            if count % 500 == 0:
                yield buffer.getvalue().encode("utf-8")
                buffer.seek(0)
                buffer.truncate(0)
        if buffer.tell():
            yield buffer.getvalue().encode("utf-8")


@router.get("/measurements")
def export_measurements(
    start_date: date,
    end_date: date,
    unit_id: str = Query(min_length=1, max_length=20),
    check_only: bool = False,
    layout: Literal["wide", "detail"] = "detail",
):
    if start_date.year < 1000 or end_date < start_date or end_date == date.max:
        raise HTTPException(status_code=422, detail="Periksa rentang tanggal ekspor.")

    start = datetime.combine(start_date, time.min)
    end = datetime.combine(end_date + timedelta(days=1), time.min)
    with read_cursor() as cursor:
        cursor.execute(
            "SELECT u.id, p.name AS plant FROM units AS u JOIN plants AS p ON p.id = u.plant_id WHERE u.id = %s",
            (unit_id,),
        )
        unit = cursor.fetchone()
        if unit is None:
            raise HTTPException(status_code=404, detail="Unit ekspor tidak ditemukan.")

        cursor.execute(
            """
            SELECT 1
            FROM channels AS c
            WHERE c.unit_id = %s AND EXISTS (
                SELECT 1 FROM measurements AS m
                WHERE m.channel_id = c.id AND m.measured_at >= %s AND m.measured_at < %s
            )
            LIMIT 1
            """,
            (unit["id"], start, end),
        )
        if cursor.fetchone() is None:
            raise HTTPException(
                status_code=404,
                detail="Tidak ada pengukuran pada unit dan rentang tanggal yang dipilih.",
            )

    if check_only:
        return {"status": "ok", "layout": layout}

    safe_code = re.sub(r"[^A-Za-z0-9_-]", "_", unit["id"])
    suffix = "-per-parameter" if layout == "wide" else ""
    filename = f"hydro-{safe_code}-{start_date}-{end_date}{suffix}.csv"

    return StreamingResponse(
        measurement_chunks(unit, start, end, layout),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )
