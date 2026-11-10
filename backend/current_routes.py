"""Impor tiga file arus generator Januari 2026."""

import json
import logging
from contextlib import contextmanager, suppress
from datetime import datetime

import pymysql
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from database import get_connection
from import_preview import PreviewParser, preview_file
from import_routes import validate_file
from import_service import (
    ImportConflict,
    MeasurementWriter,
    parse_value,
    write_stream,
)


router = APIRouter(
    prefix="/api/imports/current",
    tags=["Import Current Generator"],
)

logger = logging.getLogger(__name__)

ROW_COUNT = 44640
START = "2026-01-01 00:00:00"
END = "2026-01-31 23:59:00"


CHANNELS = {
    "U-BGS1_I_G_CURR_PH_1-AI": ("BLB-01", "Fasa 1"),
    "U-BGS2_I_G_CURR_PH_1-AI": ("BLB-02", "Fasa 1"),
    "U-BGS1_I_G_CURR_PH_2-AI": ("BLB-01", "Fasa 2"),
    "U-BGS2_I_G_CURR_PH_2-AI": ("BLB-02", "Fasa 2"),
    "U-BGS1_I_G_CURR_PH_3-AI": ("BLB-01", "Fasa 3"),
    "U-BGS2_I_G_CURR_PH_3-AI": ("BLB-02", "Fasa 3"),

    "U-KGS1-Gen_Ampere_phase_A_AI": ("KRB-01", "Fasa A"),
    "U-KGS1-Gen_Ampere_phase_B_AI": ("KRB-01", "Fasa B"),
    "U-KGS1-Gen_Ampere_phase_C_AI": ("KRB-01", "Fasa C"),
    "U-KGS2-Gen_Ampere_phase_A_AI": ("KRB-02", "Fasa A"),
    "U-KGS2-Gen_Ampere_phase_B_AI": ("KRB-02", "Fasa B"),
    "U-KGS2-Gen_Ampere_phase_C_AI": ("KRB-02", "Fasa C"),

    "U-LGS1-II-81104D-AI": ("LRN-01", "II-81104D"),
    "U-LGS1-II_81152B_MV-AI": ("LRN-01", "II_81152B_MV"),
    "U-LGS1-II_81152C_MV-AI": ("LRN-01", "II_81152C_MV"),
    "U-LGS2-II-81204D-AI": ("LRN-02", "II-81204D"),
    "U-LGS2-II_81252B_MV-AI": ("LRN-02", "II_81252B_MV"),
    "U-LGS2-II_81252C_MV-AI": ("LRN-02", "II_81252C_MV"),
    "U-LGS3-II-81104D-AI": ("LRN-03", "II-81104D"),
    "U-LGS3_II_81304A_I_Eng-AI": (
        "LRN-03",
        "II_81304A_I_Eng",
    ),
    "U-LGS3_II_81304B_I_Eng-AI": (
        "LRN-03",
        "II_81304B_I_Eng",
    ),
}


SOURCES = {
    "758b8dff934f01b81514def469ef28b445f0e3d2868e749c780bfbf1e7914854": (
        "BLB",
        (
            "U-BGS1_I_G_CURR_PH_1-AI",
            "U-BGS2_I_G_CURR_PH_1-AI",
            "U-BGS1_I_G_CURR_PH_2-AI",
            "U-BGS2_I_G_CURR_PH_2-AI",
            "U-BGS1_I_G_CURR_PH_3-AI",
            "U-BGS2_I_G_CURR_PH_3-AI",
        ),
        18,
    ),
    "d09dda43c7f193f10c44ae1d768905c01629c6337f12c3b8b9b07d1e38dcad74": (
        "KRB",
        (
            "U-KGS1-Gen_Ampere_phase_A_AI",
            "U-KGS1-Gen_Ampere_phase_B_AI",
            "U-KGS1-Gen_Ampere_phase_C_AI",
            "U-KGS2-Gen_Ampere_phase_A_AI",
            "U-KGS2-Gen_Ampere_phase_B_AI",
            "U-KGS2-Gen_Ampere_phase_C_AI",
        ),
        12,
    ),
    "f52391f940b56d303188ed1ad7c1203858117ddffa284f7c37ada1571fac8fe5": (
        "LRN",
        (
            "U-LGS1-II-81104D-AI",
            "U-LGS1-II_81152B_MV-AI",
            "U-LGS1-II_81152C_MV-AI",
            "U-LGS2-II-81204D-AI",
            "U-LGS2-II_81252B_MV-AI",
            "U-LGS2-II_81252C_MV-AI",
            "U-LGS3-II-81104D-AI",
            "U-LGS3_II_81304A_I_Eng-AI",
            "U-LGS3_II_81304B_I_Eng-AI",
        ),
        18,
    ),
}


# Nilai asli tetap disimpan.
# Dua titik ini ditandai suspect untuk pemeriksaan sumber.
REVIEW = {
    (
        "U-LGS1-II-81104D-AI",
        datetime(2026, 1, 17, 21, 31),
    ): "10370790.00",
    (
        "U-LGS2-II-81204D-AI",
        datetime(2026, 1, 17, 21, 2),
    ): "407294600000.00",
}


def definition(tag):
    unit_id, label = CHANNELS[tag]

    phase_note = (
        " Pemetaan fasa belum dikonfirmasi."
        if unit_id.startswith("LRN-")
        else ""
    )

    return (
        f"Arus generator; {label}. "
        f"Satuan sumber belum dikonfirmasi.{phase_note}"
    )


def inspect_current(file):
    filename = validate_file(file)
    info = preview_file(file.file)

    source = SOURCES.get(info["source_sha256"])

    if source is None:
        raise ValueError(
            "Gunakan salah satu dari tiga file arus "
            "Januari 2026 asli yang diperiksa."
        )

    plant, tags, missing = source

    if (
        tuple(
            item["tag_name"]
            for item in info["channels"]
        ) != tags
        or info["row_count"] != ROW_COUNT
        or info["duplicate_timestamps"]
        or info["non_60_second_intervals"]
        or info["missing_values"] != missing
        or info["invalid_values"] != 0
        or info["start_time"] != START
        or info["end_time"] != END
    ):
        raise ValueError(
            "Tag, periode, atau jumlah pembacaan "
            "tidak sesuai dengan file yang diperiksa."
        )

    for item in info["channels"]:
        tag = item["tag_name"]
        unit, label = CHANNELS[tag]

        item.update(
            suggested_unit_id=unit,
            source_label=label,
            suggested_measurement_type="other",
            engineering_unit=None,
            measurement_definition=definition(tag),
        )

    review_points = [
        {
            "tag_name": tag,
            "measured_at": stamp.isoformat(),
            "raw_value": raw,
            "quality": "suspect",
            "reason": (
                "Lonjakan terisolasi; "
                "perlu pemeriksaan sumber."
            ),
        }
        for (tag, stamp), raw in REVIEW.items()
        if tag in tags
    ]

    info.update(
        source_filename=filename,
        plant_id=plant,
        parameter_kind="current",
        mapping_confirmed=False,
        source_timezone=None,
        expected_inserted_count=ROW_COUNT * len(tags),
        expected_flagged_count=missing + len(review_points),
        review_points=review_points,
    )

    return info


class CurrentWriter(MeasurementWriter):
    def __init__(self, cursor, batch_id, channel_ids):
        super().__init__(
            cursor,
            batch_id,
            channel_ids,
            set(),
        )

        self.reviewed = 0

    def consume_row(self, cells):
        is_header = self.headers is None

        PreviewParser.consume_row(self, cells)

        if is_header:
            if cells[1:] != list(self.channel_ids):
                raise ValueError(
                    "Header berubah antara preview "
                    "dan penyimpanan."
                )

            return

        for tag, raw in zip(self.headers[1:], cells[1:]):
            value, quality = parse_value(raw, False)

            expected_raw = REVIEW.get(
                (tag, self.previous)
            )

            if expected_raw is not None:
                if (
                    raw != expected_raw
                    or quality != "unverified"
                ):
                    raise ValueError(
                        "Titik yang perlu ditinjau tidak "
                        "cocok dengan file terperiksa."
                    )

                quality = "suspect"
                self.reviewed += 1

            self.pending.append(
                (
                    self.channel_ids[tag],
                    self.previous,
                    value,
                    raw,
                    quality,
                    self.batch_id,
                    self.row_count,
                )
            )

            self.flagged += int(
                quality != "unverified"
            )

            if len(self.pending) >= 1000:
                self.flush()


def save_current(file, info):
    digest = info["source_sha256"]
    plant, tags, missing = SOURCES[digest]

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
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
                                (mode, "STRICT_ALL_TABLES"),
                            )
                        ),
                    ),
                )

            cursor.execute(
                """
                SELECT
                    TABLE_NAME AS name,
                    ENGINE AS engine
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME IN (
                      'import_batches',
                      'channels',
                      'measurements'
                  )
                """
            )

            engines = {
                row["name"]: row["engine"]
                for row in cursor.fetchall()
            }

            expected_engines = dict.fromkeys(
                (
                    "import_batches",
                    "channels",
                    "measurements",
                ),
                "InnoDB",
            )

            if engines != expected_engines:
                raise ValueError(
                    "Tabel impor harus memakai InnoDB "
                    "agar transaksi bisa dibatalkan."
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
                units.get(CHANNELS[tag][0]) != plant
                for tag in tags
            ):
                raise ValueError(
                    "Pemetaan unit PLTA di database "
                    "tidak sesuai."
                )

            cursor.execute(
                """
                SELECT id
                FROM import_batches
                WHERE source_sha256 = %s
                """,
                (digest,),
            )

            if cursor.fetchone():
                raise ImportConflict(
                    "File arus ini sudah pernah disimpan."
                )

            audit = {
                "mapping_confirmed": True,
                "parameter_kind": "current",
                "mapping_version": (
                    "generator-current-2026-01-v1"
                ),
                "plant_id": plant,
                "unit_map_by_tag": {
                    tag: CHANNELS[tag][0]
                    for tag in tags
                },
                "source_sha256": digest,
                "engineering_unit": None,
                "review_points": info["review_points"],
                "numeric_policy": (
                    "Preserve signed readings and zero "
                    "without inferring machine state."
                ),
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
                    digest,
                    None,
                    info["source_datetime_format"],
                    ROW_COUNT,
                    json.dumps(
                        audit,
                        ensure_ascii=False,
                    ),
                ),
            )

            batch_id = cursor.lastrowid
            channel_ids = {}

            for tag in tags:
                unit, label = CHANNELS[tag]

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

                if any(
                    row["unit_id"] != unit
                    or row["measurement_type"] != "other"
                    or row["engineering_unit"] is not None
                    or row["measurement_definition"]
                    != definition(tag)
                    for row in existing
                ):
                    raise ImportConflict(
                        "Metadata tag lama berbeda. "
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
                            unit,
                            tag,
                            f"Arus generator · {label}",
                            "other",
                            None,
                            definition(tag),
                        ),
                    )

                    channel_ids[tag] = cursor.lastrowid

            writer = CurrentWriter(
                cursor,
                batch_id,
                channel_ids,
            )

            actual_hash = write_stream(
                file.file,
                writer,
            )

            if (
                actual_hash != digest
                or writer.inserted
                != info["expected_inserted_count"]
                or writer.flagged
                != info["expected_flagged_count"]
                or writer.reviewed
                != len(info["review_points"])
            ):
                raise ValueError(
                    "Hash, jumlah, atau kualitas tidak "
                    "sesuai; impor dibatalkan."
                )

            cursor.execute(
                """
                UPDATE import_batches
                SET
                    inserted_count = %s,
                    flagged_count = %s
                WHERE id = %s
                """,
                (
                    writer.inserted,
                    writer.flagged,
                    batch_id,
                ),
            )

        connection.commit()

        return {
            "import_batch_id": batch_id,
            "plant_id": plant,
            "source_filename": info["source_filename"],
            "source_sha256": digest,
            "source_row_count": ROW_COUNT,
            "channel_count": len(tags),
            "inserted_count": writer.inserted,
            "flagged_count": writer.flagged,
            "suspect_count": writer.reviewed,
            "missing_count": missing,
            "invalid_count": 0,
            "skipped_count": 0,
            "source_timezone": None,
            "engineering_unit": None,
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
            status_code=400,
            detail=(
                "Encoding tidak didukung. "
                "Gunakan ekspor UTF-8 asli."
            ),
        ) from None

    except ImportConflict as error:
        raise HTTPException(
            status_code=409,
            detail=str(error),
        ) from None

    except ValueError as error:
        raise HTTPException(
            status_code=400,
            detail=str(error),
        ) from None

    except pymysql.IntegrityError as error:
        error_code = (
            error.args[0]
            if error.args
            else "unknown"
        )

        if error_code == 1062:
            raise HTTPException(
                status_code=409,
                detail=(
                    "File atau pengukuran sudah ada. "
                    "Data lama dipertahankan."
                ),
            ) from None

        logger.error(
            "Integritas impor current gagal; kode=%s",
            error_code,
        )

        raise HTTPException(
            status_code=500,
            detail=(
                "Integritas database gagal. "
                "Periksa log backend."
            ),
        ) from None

    except pymysql.MySQLError as error:
        logger.error(
            "Impor current gagal; kode=%s",
            error.args[0] if error.args else "unknown",
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Operasi database gagal. "
                "Periksa MySQL dan catatan impor."
            ),
        ) from None

    finally:
        file.file.close()


@router.post("/preview")
def preview_current(file: UploadFile = File(...)):
    with upload_errors(file):
        return {
            "status": "ok",
            "database_written": False,
            "data": inspect_current(file),
        }


@router.post("/commit")
def commit_current(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
):
    with upload_errors(file):
        if not mapping_confirmed:
            raise ValueError(
                "Periksa pemetaan unit pada hasil "
                "preview sebelum menyimpan."
            )

        info = inspect_current(file)

        if source_sha256 != info["source_sha256"]:
            raise ValueError(
                "Hash preview tidak cocok "
                "dengan file yang dipilih."
            )

        return {
            "status": "ok",
            "database_written": True,
            "data": save_current(file, info),
        }