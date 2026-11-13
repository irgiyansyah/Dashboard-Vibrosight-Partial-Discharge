import json
import logging
from contextlib import contextmanager, suppress

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
    prefix="/api/imports/wicket-gate",
    tags=["Import Wicket Gate"],
)

logger = logging.getLogger(__name__)

SOURCE_HASH = (
    "ed06a28c913c2ef2e35ced700f9f3ba4dfe859292644c6aecd17d60069afc8c9"
)

DEFINITION = "Wicket gate opening position, percent"

CHANNELS = {
    "U-LGS1-ZT-81101-AI": ("LRN-01", "ZT-81101"),
    "U-LGS2-ZT-81201-AI": ("LRN-02", "ZT-81201"),
    "U-LGS3_ZT_81301-AI": ("LRN-03", "ZT-81301"),
    "U-BGS1_WICKET_GATE_POS-AI": ("BLB-01", "Wicket Gate"),
    "U-BGS2_WICKET_GATE_POS-AI": ("BLB-02", "Wicket Gate"),
    "U-KGS1-Turb_Gov_Turb_Wicket_Gate_Pos-AI": (
        "KRB-01", "Wicket Gate"
    ),
    "U-KGS2-Turb_Gov_Turb_Wicket_Gate_Pos-AI": (
        "KRB-02", "Wicket Gate"
    ),
    "U-LAR3-Program:Gov_App.WG_PV-AI": ("LRN-03", "WG_PV"),
}


def inspect_file(file):
    filename = validate_file(file)
    info = preview_file(file.file)

    if info["source_sha256"] != SOURCE_HASH:
        raise ValueError(
            "File berbeda dari wicket_gate_generator.xls "
            "yang sudah diperiksa."
        )

    tags = [item["tag_name"] for item in info["channels"]]

    if (
        tags != list(CHANNELS)
        or info["row_count"] != 44040
        or info["start_time"] != "2026-01-01 10:00:00"
        or info["end_time"] != "2026-01-31 23:59:00"
        or info["duplicate_timestamps"] != 0
        or info["non_60_second_intervals"] != 0
        or info["missing_values"] != 16
        or info["invalid_values"] != 0
    ):
        raise ValueError(
            "Struktur, waktu, atau kualitas file tidak sesuai."
        )

    for item in info["channels"]:
        unit_id, label = CHANNELS[item["tag_name"]]
        item.update(
            suggested_unit_id=unit_id,
            suggested_measurement_type="other",
            engineering_unit="%",
            measurement_definition=DEFINITION,
            source_label=label,
        )

    info.update(
        source_filename=filename,
        parameter_kind="wicket_gate",
        source_timezone=None,
        mapping_confirmed=False,
        expected_inserted_count=352320,
        expected_flagged_count=14657,
        expected_suspect_count=14641,
        quality_policy=(
            "Simpan nilai asli. Nilai di luar 0–100 persen "
            "ditandai suspect untuk ditinjau; tidak dipotong "
            "atau diubah menjadi nol."
        ),
    )

    return info


class GateWriter(MeasurementWriter):
    def __init__(self, cursor, batch_id, channel_ids):
        super().__init__(cursor, batch_id, channel_ids, set())
        self.suspect_count = 0

    def consume_row(self, cells):
        is_header = self.headers is None
        PreviewParser.consume_row(self, cells)

        if is_header:
            if cells[1:] != list(self.channel_ids):
                raise ValueError("Header file berubah.")
            return

        for tag, raw in zip(self.headers[1:], cells[1:]):
            value, quality = parse_value(raw, False)

            if (
                quality == "unverified"
                and value is not None
                and not 0 <= value <= 100
            ):
                quality = "suspect"
                self.suspect_count += 1

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

            self.flagged += int(quality != "unverified")

            if len(self.pending) >= 1000:
                self.flush()


def save_file(file, info):
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT @@SESSION.sql_mode AS mode")
            mode = cursor.fetchone()["mode"] or ""

            if "STRICT_ALL_TABLES" not in mode.split(","):
                cursor.execute(
                    "SET SESSION sql_mode = %s",
                    (
                        ",".join(
                            filter(None, (mode, "STRICT_ALL_TABLES"))
                        ),
                    ),
                )

            cursor.execute(
                """
                SELECT TABLE_NAME AS name, ENGINE AS engine
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME IN (
                      'channels', 'measurements', 'import_batches'
                  )
                """
            )

            engines = {
                row["name"]: row["engine"]
                for row in cursor.fetchall()
            }

            if engines != dict.fromkeys(
                ("channels", "measurements", "import_batches"),
                "InnoDB",
            ):
                raise ValueError(
                    "Tabel impor harus menggunakan InnoDB."
                )

        connection.begin()

        with connection.cursor() as cursor:
            cursor.execute("SELECT id, plant_id FROM units")
            units = {
                row["id"]: row["plant_id"]
                for row in cursor.fetchall()
            }

            if any(
                units.get(unit_id) != unit_id.split("-")[0]
                for unit_id, _ in CHANNELS.values()
            ):
                raise ValueError(
                    "Pemetaan unit dalam database tidak sesuai."
                )

            cursor.execute(
                """
                SELECT id FROM import_batches
                WHERE source_sha256 = %s
                """,
                (SOURCE_HASH,),
            )

            if cursor.fetchone():
                raise ImportConflict(
                    "File Wicket Gate sudah pernah diimpor."
                )

            config = {
                "parameter_kind": "wicket_gate",
                "mapping_confirmed": True,
                "engineering_unit": "%",
                "unit_map_by_tag": {
                    tag: value[0]
                    for tag, value in CHANNELS.items()
                },
                "quality_policy": info["quality_policy"],
                "larona_unit_3": (
                    "Dua kanal disimpan terpisah; "
                    "belum ditentukan kanal utama."
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
                    SOURCE_HASH,
                    None,
                    info["source_datetime_format"],
                    info["row_count"],
                    json.dumps(config, ensure_ascii=False),
                ),
            )

            batch_id = cursor.lastrowid
            channel_ids = {}

            for tag, (unit_id, label) in CHANNELS.items():
                cursor.execute(
                    """
                    SELECT
                        id, unit_id, measurement_type,
                        engineering_unit, measurement_definition
                    FROM channels
                    WHERE tag_name = %s
                    """,
                    (tag,),
                )

                existing = cursor.fetchall()

                if any(
                    row["unit_id"] != unit_id
                    or row["measurement_type"] != "other"
                    or row["engineering_unit"] != "%"
                    or row["measurement_definition"] != DEFINITION
                    for row in existing
                ):
                    raise ImportConflict(
                        "Metadata kanal lama berbeda: " + tag
                    )

                if existing:
                    channel_ids[tag] = existing[0]["id"]
                else:
                    cursor.execute(
                        """
                        INSERT INTO channels (
                            unit_id, tag_name, display_name,
                            measurement_type, engineering_unit,
                            measurement_definition
                        )
                        VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            unit_id,
                            tag,
                            "Wicket Gate · " + label,
                            "other",
                            "%",
                            DEFINITION,
                        ),
                    )
                    channel_ids[tag] = cursor.lastrowid

            writer = GateWriter(cursor, batch_id, channel_ids)
            actual_hash = write_stream(file.file, writer)

            if (
                actual_hash != SOURCE_HASH
                or writer.inserted != 352320
                or writer.flagged != 14657
                or writer.suspect_count != 14641
            ):
                raise ValueError(
                    "Jumlah atau kualitas data tidak cocok. "
                    "Impor dibatalkan."
                )

            cursor.execute(
                """
                UPDATE import_batches
                SET inserted_count = %s, flagged_count = %s
                WHERE id = %s
                """,
                (writer.inserted, writer.flagged, batch_id),
            )

        connection.commit()

        return {
            "import_batch_id": batch_id,
            "source_filename": info["source_filename"],
            "source_sha256": SOURCE_HASH,
            "channel_count": 8,
            "unit_count": 7,
            "inserted_count": writer.inserted,
            "flagged_count": writer.flagged,
            "suspect_count": writer.suspect_count,
            "missing_count": 16,
            "engineering_unit": "%",
        }

    except Exception:
        with suppress(Exception):
            connection.rollback()
        raise

    finally:
        connection.close()


@contextmanager
def handle_upload(file):
    try:
        yield

    except UnicodeDecodeError:
        raise HTTPException(
            400, "Encoding file tidak didukung."
        ) from None

    except ImportConflict as error:
        raise HTTPException(409, str(error)) from None

    except ValueError as error:
        raise HTTPException(400, str(error)) from None

    except pymysql.IntegrityError as error:
        code = error.args[0] if error.args else "unknown"

        if code == 1062:
            raise HTTPException(
                409,
                "File atau pengukuran sudah tersimpan. "
                "Data lama dipertahankan.",
            ) from None

        logger.error("Integritas impor Wicket Gate: %s", code)
        raise HTTPException(
            500, "Integritas database gagal. Periksa log backend."
        ) from None

    except pymysql.MySQLError as error:
        logger.error(
            "Impor Wicket Gate gagal: %s",
            error.args[0] if error.args else "unknown",
        )
        raise HTTPException(
            503,
            "Database tidak dapat menyelesaikan operasi. "
            "Periksa log dan catatan impor sebelum mencoba lagi.",
        ) from None

    finally:
        file.file.close()


@router.post("/preview")
def preview_gate(file: UploadFile = File(...)):
    with handle_upload(file):
        return {
            "status": "ok",
            "database_written": False,
            "data": inspect_file(file),
        }


@router.post("/commit")
def commit_gate(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
):
    with handle_upload(file):
        if not mapping_confirmed:
            raise ValueError(
                "Periksa pemetaan preview, lalu konfirmasi."
            )

        if source_sha256 != SOURCE_HASH:
            raise ValueError("Hash preview tidak sesuai.")

        info = inspect_file(file)

        return {
            "status": "ok",
            "database_written": True,
            "data": save_file(file, info),
        }