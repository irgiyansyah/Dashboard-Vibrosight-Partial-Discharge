import logging
from contextlib import contextmanager, suppress
from datetime import datetime, timedelta

import pymysql
from fastapi import APIRouter, HTTPException, Path, Query

from database import get_connection


router = APIRouter(
    prefix="/api",
    tags=["Monitoring"],
)

logger = logging.getLogger("uvicorn.error")


@contextmanager
def read_cursor():
    connection = None

    try:
        connection = get_connection()

        with connection.cursor() as cursor:
            # Semua query dalam satu permintaan membaca snapshot yang sama.
            cursor.execute(
                "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"
            )
            connection.begin()

            yield cursor

    except pymysql.MySQLError as error:
        code = error.args[0] if error.args else "unknown"

        logger.error(
            "Pembacaan monitoring gagal. Kode: %s",
            code,
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Data belum dapat dibaca. "
                "Periksa MySQL dan log backend."
            ),
        ) from None

    finally:
        if connection is not None:
            # Transaksi ini hanya membaca data.
            with suppress(Exception):
                connection.rollback()

            connection.close()


def validate_range(start, end, after):
    for value in (start, end, after):
        if value is not None:
            if value.tzinfo is not None or value.year < 1000:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Gunakan waktu sumber tanpa Z/offset, "
                        "dengan tahun minimal 1000."
                    ),
                )

    if end <= start:
        raise HTTPException(
            status_code=422,
            detail="end harus lebih besar daripada start.",
        )

    if end - start > timedelta(days=31):
        raise HTTPException(
            status_code=422,
            detail="Maksimal rentang 31 hari per permintaan.",
        )

    if after is not None and not start <= after < end:
        raise HTTPException(
            status_code=422,
            detail=(
                "after harus berada dalam rentang start "
                "sampai sebelum end."
            ),
        )


@router.get("/units/{unit_id}/parameters")
def unit_parameters(
    unit_id: str = Path(..., min_length=1, max_length=20),
):
    with read_cursor() as cursor:
        cursor.execute(
            """
            SELECT
                u.id,
                u.name,
                p.id AS plant_id,
                p.name AS plant
            FROM units AS u
            JOIN plants AS p ON p.id = u.plant_id
            WHERE u.id = %s
            """,
            (unit_id,),
        )

        unit = cursor.fetchone()

        if unit is None:
            raise HTTPException(
                status_code=404,
                detail="Unit tidak ditemukan.",
            )

        # Ambil pengukuran terakhir untuk setiap parameter.
        # Menggunakan indeks (channel_id, measured_at).
        cursor.execute(
            """
            SELECT
                c.id AS channel_id,
                c.unit_id,
                c.tag_name,
                COALESCE(c.display_name, c.tag_name) AS display_name,
                c.measurement_type,
                c.engineering_unit,
                c.measurement_definition,
                m.measured_at AS latest_time,
                m.measured_value AS latest_value,
                m.raw_value AS latest_raw_value,
                m.quality AS latest_quality,
                b.source_timezone,
                b.source_filename
            FROM channels AS c
            LEFT JOIN measurements AS m
                ON m.channel_id = c.id
                AND m.measured_at = (
                    SELECT last_m.measured_at
                    FROM measurements AS last_m
                    WHERE last_m.channel_id = c.id
                    ORDER BY last_m.measured_at DESC
                    LIMIT 1
                )
            LEFT JOIN import_batches AS b
                ON b.id = m.import_batch_id
            WHERE c.unit_id = %s
            ORDER BY c.tag_name
            """,
            (unit_id,),
        )

        rows = cursor.fetchall()

    for row in rows:
        row["latest_plot_value"] = (
            row["latest_value"]
            if row["latest_quality"] == "unverified"
            else None
        )

    return {
        "status": "ok",
        "unit": unit,
        "total": len(rows),
        "has_data": any(
            row["latest_time"] is not None
            for row in rows
        ),
        "data": rows,
    }


@router.get("/parameters/{channel_id}/history")
def parameter_history(
    channel_id: int = Path(..., ge=1),
    start: datetime = Query(...),
    end: datetime = Query(...),
    limit: int = Query(2000, ge=1, le=5000),
    after: datetime | None = Query(None),
    include_suspect: bool = Query(False),
):
    validate_range(start, end, after)

    qualities = (
        ["unverified", "suspect"]
        if include_suspect
        else ["unverified"]
    )

    # Fragmen SQL hanya berasal dari pilihan tetap di kode.
    quality_sql = (
        "'unverified', 'suspect'"
        if include_suspect
        else "'unverified'"
    )

    accepted = (
        f"quality IN ({quality_sql}) "
        "AND measured_value IS NOT NULL"
    )

    bounds = (channel_id, start, end)

    with read_cursor() as cursor:
        cursor.execute(
            """
            SELECT
                id AS channel_id,
                unit_id,
                tag_name,
                COALESCE(display_name, tag_name) AS display_name,
                measurement_type,
                engineering_unit,
                measurement_definition
            FROM channels
            WHERE id = %s
            """,
            (channel_id,),
        )

        parameter = cursor.fetchone()

        if parameter is None:
            raise HTTPException(
                status_code=404,
                detail="Parameter tidak ditemukan.",
            )

        # Ringkasan seluruh periode, bukan hanya titik pada halaman grafik.
        cursor.execute(
            f"""
            SELECT
                COUNT(*) AS total_count,

                COUNT(
                    CASE WHEN {accepted}
                    THEN 1 END
                ) AS analyzed_count,

                COUNT(
                    CASE WHEN quality = 'missing'
                    THEN 1 END
                ) AS missing_count,

                COUNT(
                    CASE WHEN quality = 'invalid'
                    THEN 1 END
                ) AS invalid_count,

                COUNT(
                    CASE WHEN quality = 'suspect'
                    THEN 1 END
                ) AS suspect_count,

                COUNT(
                    CASE WHEN quality = 'unverified'
                    THEN 1 END
                ) AS unverified_count,

                MIN(
                    CASE WHEN {accepted}
                    THEN measured_value END
                ) AS minimum,

                MAX(
                    CASE WHEN {accepted}
                    THEN measured_value END
                ) AS maximum,

                AVG(
                    CASE WHEN {accepted}
                    THEN measured_value END
                ) AS average,

                MIN(measured_at) AS first_time,
                MAX(measured_at) AS last_time

            FROM measurements
            WHERE channel_id = %s
              AND measured_at >= %s
              AND measured_at < %s
            """,
            bounds,
        )

        summary = cursor.fetchone()

        summary["excluded_count"] = (
            summary["total_count"] - summary["analyzed_count"]
        )

        summary["minimum_time"] = None
        summary["maximum_time"] = None

        if summary["analyzed_count"]:
            for name, direction in (
                ("minimum_time", "ASC"),
                ("maximum_time", "DESC"),
            ):
                cursor.execute(
                    f"""
                    SELECT measured_at
                    FROM measurements
                    WHERE channel_id = %s
                      AND measured_at >= %s
                      AND measured_at < %s
                      AND {accepted}
                    ORDER BY
                        measured_value {direction},
                        measured_at ASC
                    LIMIT 1
                    """,
                    bounds,
                )

                summary[name] = cursor.fetchone()["measured_at"]

        after_sql = (
            " AND measured_at > %s"
            if after is not None
            else ""
        )

        values = (
            bounds
            + ((after,) if after is not None else ())
            + (limit + 1,)
        )

        cursor.execute(
            f"""
            SELECT
                measured_at,
                measured_value,
                raw_value,
                quality,
                import_batch_id
            FROM measurements
            WHERE channel_id = %s
              AND measured_at >= %s
              AND measured_at < %s
              {after_sql}
            ORDER BY measured_at ASC
            LIMIT %s
            """,
            values,
        )

        rows = cursor.fetchall()

    has_more = len(rows) > limit
    rows = rows[:limit]

    for row in rows:
        row["plot_value"] = (
            row["measured_value"]
            if row["quality"] in qualities
            else None
        )

    return {
        "status": "ok",
        "parameter": parameter,
        "time_basis": "source_time_without_timezone_conversion",
        "range": {
            "start": start,
            "end_exclusive": end,
        },
        "analysis": {
            "included_qualities": qualities,
            "scope": "entire_requested_range",
            "threshold_status": "not_configured",
            "summary": summary,
        },
        "pagination": {
            "returned": len(rows),
            "limit": limit,
            "has_more": has_more,
            "next_after": (
                rows[-1]["measured_at"]
                if has_more
                else None
            ),
        },
        "data": rows,
    }