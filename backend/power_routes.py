import json
import logging
from contextlib import contextmanager, suppress

import pymysql
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from database import get_connection
from import_preview import preview_file
from import_routes import validate_file
from import_service import ImportConflict, MeasurementWriter, write_stream


router = APIRouter(
    prefix="/api/imports/power",
    tags=["Import Power Generator"],
)

logger = logging.getLogger(__name__)

SOURCE_SHA256 = (
    "20e3ec729a9706138cb4a323f424342f8"
    "f0ec7b6a294885b5c8ab8dc12ef6814"
)

DEFINITIONS = {
    "activePower": (
        "Daya aktif",
        "MW",
        "Active power, megawatts",
    ),
    "reactivePower": (
        "Daya reaktif",
        "MVAr",
        "Reactive power, megavars",
    ),
}

CHANNELS = {
    "U-KGS1-Active_Power_AI": ("KRB-01", "activePower"),
    "U-KGS1-Reactive_Power_AI": ("KRB-01", "reactivePower"),
    "U-KGS2-Active_Power_AI": ("KRB-02", "activePower"),
    "U-KGS2-Reactive_Power_AI": ("KRB-02", "reactivePower"),

    "U-LGS1-Active-Power-AI": ("LRN-01", "activePower"),
    "U-LGS1-Reactive-Power-AI": ("LRN-01", "reactivePower"),
    "U-LGS2-Active-Power-AI": ("LRN-02", "activePower"),
    "U-LGS2-Reactive-Power-AI": ("LRN-02", "reactivePower"),
    "U-LGS3_Active-Power-AI": ("LRN-03", "activePower"),
    "U-LGS3_Reactive-Power-AI": ("LRN-03", "reactivePower"),

    "U-BGS1-Power-AI": ("BLB-01", "activePower"),
    "U-BGS2-Power-AI": ("BLB-02", "activePower"),
    "U-BGS1-PowerReactive-Mvar-AI": ("BLB-01", "reactivePower"),
    "U-BGS2-PowerReactive-Mvar-AI": ("BLB-02", "reactivePower"),
}


def inspect_power(file):
    filename = validate_file(file)
    info = preview_file(file.file)

    tags = [item["tag_name"] for item in info["channels"]]

    if info["source_sha256"] != SOURCE_SHA256:
        raise ValueError(
            "Gunakan file mw-mvar generator.xls "
            "Januari 2026 yang diperiksa."
        )

    if len(tags) != 14 or set(tags) != set(CHANNELS):
        raise ValueError(
            "Daftar tag Power tidak sesuai pemetaan "
            "14 kanal pada tujuh unit."
        )

    if (
        info["row_count"] != 44640
        or info["duplicate_timestamps"]
        or info["non_60_second_intervals"]
        or info["missing_values"] != 32
        or info["invalid_values"]
        or info["start_time"] != "2026-01-01 00:00:00"
        or info["end_time"] != "2026-01-31 23:59:00"
    ):
        raise ValueError(
            "Isi file berbeda dari hasil pemeriksaan Power."
        )

    for item in info["channels"]:
        unit_id, kind = CHANNELS[item["tag_name"]]
        title, unit, definition = DEFINITIONS[kind]

        item.update({
            "suggested_unit_id": unit_id,
            "suggested_measurement_type": "other",
            "parameter_kind": kind,
            "engineering_unit": unit,
            "measurement_definition": definition,
        })

    info.update({
        "source_filename": filename,
        "parameter_kind": "power",
        "engineering_units": ["MW", "MVAr"],
        "source_measurement_count": 624960,
        "source_flagged_count": 32,
        "duplicate_policy": (
            "Skip only matching values and raw text; "
            "preserve existing quality and batch."
        ),
    })

    return info


class PowerWriter(MeasurementWriter):
    def __init__(self, cursor, batch_id, channel_ids):
        super().__init__(
            cursor,
            batch_id,
            channel_ids,
            set(),
        )

        self.skipped = 0
        self.inserted_flagged = 0
        self.retained_quality_differences = 0

        self.tags_by_id = {
            value: key
            for key, value in channel_ids.items()
        }

    def flush(self):
        if not self.pending:
            return

        ids = sorted({row[0] for row in self.pending})
        placeholders = ",".join(["%s"] * len(ids))
        times = [row[1] for row in self.pending]

        self.cursor.execute(
            f"""
            SELECT
                channel_id,
                measured_at,
                measured_value,
                raw_value,
                quality
            FROM measurements
            WHERE channel_id IN ({placeholders})
              AND measured_at >= %s
              AND measured_at <= %s
            """,
            (*ids, min(times), max(times)),
        )

        existing = {
            (row["channel_id"], row["measured_at"]): row
            for row in self.cursor.fetchall()
        }

        fresh = []

        for row in self.pending:
            (
                channel_id,
                measured_at,
                value,
                raw,
                quality,
                _,
                _,
            ) = row

            old = existing.get((channel_id, measured_at))

            if old is None:
                fresh.append(row)
                continue

            old_value = old["measured_value"]

            same_value = (
                old_value is None and value is None
            ) or (
                old_value is not None
                and value is not None
                and float(old_value) == value
            )

            if not same_value or old["raw_value"] != raw:
                raise ImportConflict(
                    f"Data lama berbeda: "
                    f"{self.tags_by_id[channel_id]} "
                    f"pada {measured_at}. "
                    "Impor dibatalkan; periksa sumber."
                )

            self.skipped += 1

            self.retained_quality_differences += int(
                old["quality"] != quality
            )

        self.pending = fresh

        self.inserted_flagged += sum(
            row[4] != "unverified"
            for row in fresh
        )

        super().flush()


def save_power(file, info):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT TABLE_NAME AS name, ENGINE AS engine
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME IN (
                      'channels',
                      'measurements',
                      'import_batches'
                  )
                """
            )

            tables = cursor.fetchall()

            if len(tables) != 3 or any(
                str(row["engine"]).lower() != "innodb"
                for row in tables
            ):
                raise ValueError(
                    "Tiga tabel impor harus menggunakan InnoDB."
                )

            cursor.execute(
                "SELECT @@SESSION.sql_mode AS mode"
            )

            mode = cursor.fetchone()["mode"] or ""

            if "STRICT_ALL_TABLES" not in mode.split(","):
                cursor.execute(
                    "SET SESSION sql_mode = %s",
                    (
                        ",".join(
                            filter(
                                None,
                                [mode, "STRICT_ALL_TABLES"],
                            )
                        ),
                    ),
                )

        connection.begin()

        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT id, plant_id FROM units"
            )

            units = {
                row["id"]: row["plant_id"]
                for row in cursor.fetchall()
            }

            if any(
                units.get(unit_id) != unit_id[:3]
                for unit_id, _ in CHANNELS.values()
            ):
                raise ValueError(
                    "Pemetaan PLTA dan unit di database "
                    "belum sesuai."
                )

            cursor.execute(
                """
                SELECT id
                FROM import_batches
                WHERE source_sha256 = %s
                """,
                (SOURCE_SHA256,),
            )

            if cursor.fetchone():
                raise ImportConflict(
                    "File Power ini sudah pernah diimpor."
                )

            channel_ids = {}

            for item in info["channels"]:
                tag = item["tag_name"]
                unit_id, kind = CHANNELS[tag]
                title, unit, definition = DEFINITIONS[kind]

                cursor.execute(
                    """
                    SELECT
                        id,
                        unit_id,
                        measurement_type,
                        engineering_unit,
                        measurement_definition
                    FROM channels
                    WHERE tag_name = %s
                    """,
                    (tag,),
                )

                existing = cursor.fetchall()

                if len(existing) > 1 or any(
                    row["unit_id"] != unit_id
                    or row["measurement_type"] != "other"
                    or row["engineering_unit"] != unit
                    or row["measurement_definition"] != definition
                    for row in existing
                ):
                    raise ImportConflict(
                        "Metadata kanal lama berbeda. "
                        "Periksa: " + tag
                    )

                if existing:
                    channel_ids[tag] = existing[0]["id"]
                else:
                    cursor.execute(
                        """
                        INSERT INTO channels (
                            unit_id,
                            tag_name,
                            display_name,
                            measurement_type,
                            engineering_unit,
                            measurement_definition
                        )
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            unit_id,
                            tag,
                            title,
                            "other",
                            unit,
                            definition,
                        ),
                    )

                    channel_ids[tag] = cursor.lastrowid

            placeholders = ",".join(
                ["%s"] * len(channel_ids)
            )

            cursor.execute(
                f"""
                SELECT COUNT(*) AS total
                FROM measurements
                WHERE channel_id IN ({placeholders})
                  AND measured_at >= %s
                  AND measured_at < %s
                  AND SECOND(measured_at) = 0
                  AND MICROSECOND(measured_at) = 0
                """,
                (
                    *channel_ids.values(),
                    "2026-01-01 00:00:00",
                    "2026-02-01 00:00:00",
                ),
            )

            planned_skips = int(
                cursor.fetchone()["total"]
            )

            audit = {
                "mapping_confirmed": True,
                "mapping_version": "generator-power-2026-01-v1",
                "parameter_kind": "power",
                "mapping_by_tag": CHANNELS,
                "engineering_units": ["MW", "MVAr"],
                "definitions": DEFINITIONS,
                "source_sha256": SOURCE_SHA256,
                "source_measurement_count": 624960,
                "source_flagged_count": 32,
                "skipped_count": planned_skips,
                "duplicate_policy": (
                    "Compare numeric and raw values; "
                    "preserve existing quality and import_batch_id."
                ),
                "value_policy": (
                    "Preserve signed numeric values and zero; "
                    "no operating-state inference."
                ),
                "alarm_thresholds_applied": False,
            }

            cursor.execute(
                """
                INSERT INTO import_batches (
                    source_filename,
                    source_sha256,
                    source_timezone,
                    source_datetime_format,
                    source_row_count,
                    import_config
                )
                VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (
                    info["source_filename"],
                    SOURCE_SHA256,
                    None,
                    info["source_datetime_format"],
                    info["row_count"],
                    json.dumps(audit, ensure_ascii=False),
                ),
            )

            batch_id = cursor.lastrowid
            writer = PowerWriter(
                cursor,
                batch_id,
                channel_ids,
            )

            actual_hash = write_stream(
                file.file,
                writer,
            )

            if (
                actual_hash != SOURCE_SHA256
                or writer.row_count != 44640
                or writer.inserted + writer.skipped != 624960
                or writer.skipped != planned_skips
                or writer.flagged != 32
            ):
                raise ValueError(
                    "Validasi akhir gagal. Impor Power dibatalkan."
                )

            cursor.execute(
                """
                UPDATE import_batches
                SET inserted_count = %s,
                    flagged_count = %s
                WHERE id = %s
                """,
                (
                    writer.inserted,
                    writer.inserted_flagged,
                    batch_id,
                ),
            )

        connection.commit()

        return {
            "import_batch_id": batch_id,
            "source_filename": info["source_filename"],
            "source_sha256": SOURCE_SHA256,
            "channel_count": 14,
            "source_row_count": 44640,
            "inserted_count": writer.inserted,
            "flagged_count": writer.inserted_flagged,
            "source_measurement_count": 624960,
            "source_missing_count": 32,
            "invalid_count": 0,
            "skipped_count": writer.skipped,
            "retained_quality_differences": (
                writer.retained_quality_differences
            ),
            "engineering_units": ["MW", "MVAr"],
            "source_timezone": None,
        }

    except Exception:
        with suppress(Exception):
            connection.rollback()
        raise

    finally:
        connection.close()


@contextmanager
def upload_errors(file):
    try:
        yield

    except UnicodeDecodeError:
        raise HTTPException(
            400,
            "Encoding tidak didukung. Gunakan UTF-8.",
        ) from None

    except ImportConflict as error:
        raise HTTPException(
            409,
            str(error),
        ) from None

    except ValueError as error:
        raise HTTPException(
            400,
            str(error),
        ) from None

    except pymysql.IntegrityError as error:
        if error.args and error.args[0] == 1062:
            raise HTTPException(
                409,
                (
                    "File atau pengukuran sudah ada. "
                    "Transaksi impor dibatalkan."
                ),
            ) from None

        logger.error(
            "Integritas impor Power gagal; kode=%s",
            error.args[0] if error.args else "unknown",
        )

        raise HTTPException(
            500,
            "Integritas database gagal. Periksa log backend.",
        ) from None

    except pymysql.MySQLError as error:
        logger.error(
            "Impor Power gagal; kode=%s",
            error.args[0] if error.args else "unknown",
        )

        raise HTTPException(
            503,
            (
                "Database gagal diakses. Periksa catatan impor "
                "sebelum mencoba kembali."
            ),
        ) from None

    finally:
        file.file.close()


@router.post("/preview")
def preview_power(file: UploadFile = File(...)):
    with upload_errors(file):
        return {
            "status": "ok",
            "database_written": False,
            "data": inspect_power(file),
        }


@router.post("/commit")
def commit_power(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
):
    with upload_errors(file):
        if not mapping_confirmed:
            raise ValueError(
                "Set mapping_confirmed ke true "
                "setelah memeriksa preview."
            )

        if source_sha256.strip().lower() != SOURCE_SHA256:
            raise ValueError(
                "source_sha256 harus sama dengan hasil preview Power."
            )

        info = inspect_power(file)

        return {
            "status": "ok",
            "database_written": True,
            "data": save_power(file, info),
        }