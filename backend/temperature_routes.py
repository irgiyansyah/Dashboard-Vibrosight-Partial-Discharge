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
    prefix="/api/imports/temperature",
    tags=["Import Temperature"],
)

logger = logging.getLogger(__name__)

START = "2026-01-01 10:00:00"
END = "2026-02-01 00:00:00"
ROWS = 44040

CHANNELS = {
    "U-BGS1_I_TE_TB_TMP_1-AI": ["BLB-01", "bearing"],
    "U-BGS1_I_TE_TB_TMP_2-AI": ["BLB-01", "bearing"],
    "U-BGS2_I_TE_TB_TMP_1-AI": ["BLB-02", "bearing"],
    "U-BGS2_I_TE_TB_TMP_2-AI": ["BLB-02", "bearing"],
    "U-BGS1_I_TE_GEN_GB_T_1-AI": ["BLB-01", "bearing"],
    "U-BGS1_I_TE_GEN_GB_T_2-AI": ["BLB-01", "bearing"],
    "U-BGS2_I_TE_GEN_GB_T_1-AI": ["BLB-02", "bearing"],
    "U-BGS2_I_TE_GEN_GB_T_2-AI": ["BLB-02", "bearing"],
    "U-BGS1_I_TE_T_GB_TMP_1-AI": ["BLB-01", "bearing"],
    "U-BGS1_I_TE_T_GB_TMP_2-AI": ["BLB-01", "bearing"],
    "U-BGS2_I_TE_T_GB_TMP_1-AI": ["BLB-02", "bearing"],
    "U-BGS2_I_TE_T_GB_TMP_2-AI": ["BLB-02", "bearing"],
    "U-KGS1-TGB-Pad1-AI": ["KRB-01", "bearing"],
    "U-KGS2-TGB-Pad1-AI": ["KRB-02", "bearing"],
    "U-KGS1-TGB-Pad2-AI": ["KRB-01", "bearing"],
    "U-KGS2-TGB-Pad2-AI": ["KRB-02", "bearing"],
    "U-BGS1_COMBINED_BEARG_OIL_TEMP_1-AI": ["BLB-01", "oil"],
    "U-BGS2_COMBINED_BEARG_OIL_TEMP_1-AI": ["BLB-02", "oil"],
    "U-BGS1-CB-OILTMP-AI": ["BLB-01", "oil"],
    "U-BGS2-CB-OILTMP-AI": ["BLB-02", "oil"],
    "U-KGS1-TGB-oil-temp-AI": ["KRB-01", "oil"],
    "U-KGS1-Turb_Guide_Bear_Oil_Temp-AI": ["KRB-01", "oil"],
    "U-KGS2-TGB-oil-temp-AI": ["KRB-02", "oil"],
    "U-KGS2-Turb_Guide_Bear_Oil_Temp-AI": ["KRB-02", "oil"],
    "U-LGS1-TI-81104H-AI": ["LRN-01", "oil"],
    "U-LGS1-TI-81104I-AI": ["LRN-01", "oil"],
    "U-LGS1-TI-81104J-AI": ["LRN-01", "oil"],
    "U-LGS1-TI-81104K-AI": ["LRN-01", "oil"],
    "U-LGS2-TI-81204H-AI": ["LRN-02", "oil"],
    "U-LGS2-TI-81204I-AI": ["LRN-02", "oil"],
    "U-LGS2-TI-81204J-AI": ["LRN-02", "oil"],
    "U-LGS2-TI-81204K-AI": ["LRN-02", "oil"],
    "U-LGS3_TI_81304H-AI": ["LRN-03", "oil"],
    "U-LGS3_TI_81304I-AI": ["LRN-03", "oil"],
    "U-LGS3_TI_81304J-AI": ["LRN-03", "oil"],
}

FILES = {
    "06d90fb948215a35faafb2f39603ed4c9525cabc4869d3ed9c6564a7d8198349":
        ["balambano bearing temp.xls", "BLB", "bearing", 28],

    "d57ced7f60556297c9522effda33d38f3b250a0d371d1219c00559884d5ee15c":
        ["bearing_temp_karebbe.xls", "KRB", "bearing", 8],

    "da89744b61eb294a8939bdfae90d0998f6c0fea1185c35c748e21a5e40f03a23":
        ["oil_bearing_temp_balambano.xls", "BLB", "oil", 8],

    "98d42aefe74ae77b50c9f16a51ea6f9af65c7aebbacacc766ef97e67521bb7e6":
        ["oil_bearing_temp_karebbe.xls", "KRB", "oil", 8],

    "145e7465af05e77cb152a23020cefba7f32260785570ebde7a26a26ea242d699":
        ["oil_bearing_temp_larona.xls", "LRN", "oil", 22],
}

# Titik sumber yang perlu ditinjau.
# Daftar ini bukan batas alarm temperatur.
REVIEW_POINTS = {
    "U-BGS1_I_TE_GEN_GB_T_1-AI": [
        "2026-01-09 16:07:00",
        "2026-01-09 16:08:00",
        "2026-01-09 16:09:00",
        "2026-01-09 16:10:00",
        "2026-01-09 16:12:00",
        "2026-01-09 16:13:00",
    ],
    "U-BGS1_I_TE_TB_TMP_1-AI": [
        "2026-01-09 16:13:00",
        "2026-01-09 16:16:00",
        "2026-01-09 16:17:00",
        "2026-01-09 16:19:00",
        "2026-01-09 16:20:00",
    ],
    "U-BGS1_COMBINED_BEARG_OIL_TEMP_1-AI": [
        "2026-01-09 16:21:00",
        "2026-01-09 16:23:00",
        "2026-01-09 16:24:00",
    ],
    "U-LGS2-TI-81204H-AI": [
        "2026-01-17 22:57:00",
        "2026-01-17 22:58:00",
        "2026-01-17 22:59:00",
        "2026-01-17 23:00:00",
        "2026-01-17 23:01:00",
        "2026-01-17 23:02:00",
        "2026-01-17 23:03:00",
        "2026-01-17 23:04:00",
        "2026-01-17 23:05:00",
    ],
}


def inspect_temperature(file):
    filename = validate_file(file)
    info = preview_file(file.file)
    sha = info["source_sha256"]
    spec = FILES.get(sha)

    if not spec:
        raise ValueError(
            "File belum termasuk lima ekspor temperatur yang diperiksa."
        )

    tags = [item["tag_name"] for item in info["channels"]]

    expected = {
        tag
        for tag, (unit, group) in CHANNELS.items()
        if unit.startswith(spec[1]) and group == spec[2]
    }

    if (
        len(tags) != len(expected)
        or set(tags) != expected
        or info["row_count"] != ROWS
        or info["duplicate_timestamps"]
        or info["non_60_second_intervals"]
        or info["missing_values"] != spec[3]
        or info["invalid_values"]
        or info["start_time"] != START
        or info["end_time"] != "2026-01-31 23:59:00"
    ):
        raise ValueError(
            "Struktur atau periode file tidak sesuai hasil pemeriksaan."
        )

    for item in info["channels"]:
        unit_id, group = CHANNELS[item["tag_name"]]

        item.update(
            suggested_unit_id=unit_id,
            suggested_measurement_type="temperature",
            parameter_group=group,
            engineering_unit=None,
        )

    info.update(
        source_filename=filename,
        source_measurement_count=ROWS * len(tags),
        review_points={
            tag: REVIEW_POINTS[tag]
            for tag in tags
            if tag in REVIEW_POINTS
        },
        source_suspect_count=sum(
            len(REVIEW_POINTS.get(tag, []))
            for tag in tags
        ),
        unit_note=(
            "Satuan belum tercantum di ekspor. "
            "Isi °C hanya setelah dikonfirmasi."
        ),
        duplicate_policy=(
            "Lewati nilai dan teks asli identik; "
            "pertahankan kualitas serta batch lama."
        ),
    )

    return info


class TemperatureWriter(MeasurementWriter):
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

        marked = []

        for row in self.pending:
            tag = self.tags_by_id[row[0]]

            if (
                str(row[1]) in REVIEW_POINTS.get(tag, ())
                and row[4] == "unverified"
            ):
                row = (
                    *row[:4],
                    "suspect",
                    *row[5:],
                )

                self.flagged += 1

            marked.append(row)

        self.pending = marked

        ids = sorted({
            row[0]
            for row in self.pending
        })

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
            channel_id, measured_at, value, raw, quality, _, _ = row
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


def save_temperature(file, info, unit):
    sha = info["source_sha256"]
    total = info["source_measurement_count"]

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT ENGINE AS engine
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
                    "Tabel impor harus menggunakan InnoDB."
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

            cursor.execute(
                """
                SELECT id
                FROM import_batches
                WHERE source_sha256 = %s
                """,
                (sha,),
            )

            if cursor.fetchone():
                raise ImportConflict(
                    "File ini sudah diimpor. "
                    "Periksa import_batches."
                )

            channel_ids = {}
            inherited_metadata = []

            for item in info["channels"]:
                tag = item["tag_name"]
                unit_id, group = CHANNELS[tag]

                if units.get(unit_id) != unit_id[:3]:
                    raise ValueError(
                        "Pemetaan PLTA/unit tidak sesuai: "
                        + unit_id
                    )

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

                matches = cursor.fetchall()

                if len(matches) > 1:
                    raise ImportConflict(
                        "Tag ditemukan pada beberapa kanal: "
                        + tag
                    )

                if matches:
                    old = matches[0]

                    old_unit = str(
                        old["engineering_unit"] or ""
                    ).strip()

                    if (
                        old["unit_id"] != unit_id
                        or old["measurement_type"] not in (
                            "unknown",
                            "temperature",
                            None,
                        )
                        or (
                            unit
                            and old_unit
                            and old_unit != unit
                        )
                    ):
                        raise ImportConflict(
                            "Metadata kanal berbeda. Periksa: "
                            + tag
                        )

                    channel_ids[tag] = old["id"]

                    if (
                        old["measurement_type"] != "temperature"
                        or not old_unit
                    ):
                        inherited_metadata.append(tag)

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
                            tag,
                            "temperature",
                            unit or None,
                            (
                                "Oil temperature"
                                if group == "oil"
                                else "Bearing temperature"
                            ),
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
                (*channel_ids.values(), START, END),
            )

            planned_skips = int(
                cursor.fetchone()["total"]
            )

            audit = {
                "mapping_confirmed": True,
                "mapping_version": "temperature-2026-01-v1",
                "mapping_by_tag": {
                    tag: CHANNELS[tag]
                    for tag in channel_ids
                },
                "source_measurement_count": total,
                "skipped_count": planned_skips,
                "engineering_unit_for_new_channels": unit or None,
                "inherited_metadata": inherited_metadata,
                "review_points": info["review_points"],
                "source_missing_count": info["missing_values"],
                "source_suspect_count": info["source_suspect_count"],
                "duplicate_policy": info["duplicate_policy"],
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
                    sha,
                    None,
                    info["source_datetime_format"],
                    ROWS,
                    json.dumps(
                        audit,
                        ensure_ascii=False,
                    ),
                ),
            )

            batch_id = cursor.lastrowid

            writer = TemperatureWriter(
                cursor,
                batch_id,
                channel_ids,
            )

            actual_hash = write_stream(
                file.file,
                writer,
            )

            if (
                actual_hash != sha
                or writer.row_count != ROWS
                or writer.inserted + writer.skipped != total
                or writer.skipped != planned_skips
                or writer.flagged
                != info["missing_values"] + info["source_suspect_count"]
            ):
                raise ValueError(
                    "Pemeriksaan akhir gagal. "
                    "Transaksi dibatalkan."
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
                    writer.inserted_flagged,
                    batch_id,
                ),
            )

        connection.commit()

        return {
            "import_batch_id": batch_id,
            "source_filename": info["source_filename"],
            "source_sha256": sha,
            "source_measurement_count": total,
            "inserted_count": writer.inserted,
            "skipped_count": writer.skipped,
            "flagged_count": writer.inserted_flagged,
            "retained_quality_differences": (
                writer.retained_quality_differences
            ),
            "inherited_metadata": inherited_metadata,
            "engineering_unit_for_new_channels": unit or None,
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
            "Integritas impor Temperature gagal; kode=%s",
            error.args[0] if error.args else "unknown",
        )

        raise HTTPException(
            500,
            "Integritas database gagal. Periksa log backend.",
        ) from None

    except pymysql.MySQLError as error:
        logger.error(
            "Impor Temperature gagal; kode=%s",
            error.args[0] if error.args else "unknown",
        )

        raise HTTPException(
            503,
            (
                "Database gagal diakses. "
                "Periksa catatan impor sebelum mencoba kembali."
            ),
        ) from None

    finally:
        file.file.close()


@router.post("/preview")
def preview_temperature(
    file: UploadFile = File(...),
):
    with upload_errors(file):
        return {
            "status": "ok",
            "database_written": False,
            "data": inspect_temperature(file),
        }


@router.post("/commit")
def commit_temperature(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
    engineering_unit: str = Form(""),
):
    with upload_errors(file):
        if not mapping_confirmed:
            raise ValueError(
                "Periksa preview lalu set mapping_confirmed=true."
            )

        unit = engineering_unit.strip()

        if unit not in ("", "°C"):
            raise ValueError(
                "Kosongkan satuan atau isi °C "
                "jika sudah dikonfirmasi."
            )

        info = inspect_temperature(file)

        if (
            source_sha256.strip().lower()
            != info["source_sha256"]
        ):
            raise ValueError(
                "source_sha256 tidak sama dengan file preview."
            )

        return {
            "status": "ok",
            "database_written": True,
            "data": save_temperature(
                file,
                info,
                unit,
            ),
        }