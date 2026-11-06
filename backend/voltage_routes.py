"""January 2026 generator voltage import; preserves raw readings and source time."""
import json
import logging
from contextlib import contextmanager, suppress
from datetime import datetime

import pymysql
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from database import get_connection
from import_preview import PreviewParser, preview_file
from import_routes import validate_file
from import_service import ImportConflict, MeasurementWriter, parse_value, write_stream

router = APIRouter(prefix="/api/imports/voltage", tags=["Import Voltage Generator"])
logger = logging.getLogger(__name__)
SOURCE_SHA256 = "cf1eb64ee535edba00dff8acac2b36bba1863bd0f59407c1127f310f7c3d18ee"
# Exact source tags. Do not normalize or rename identifiers in the database.
CHANNELS = {
    "U-LAR1-EI_81104_AVE-AI": ("LRN-01", "LRN", "AVE"),
    "U-LAR2-EI_81204_AVE-AI": ("LRN-02", "LRN", "AVE"),
    "U-LAR3-EI_81302m-AI": ("LRN-03", "LRN", "EI_81302m"),
    "U-BGS1-I-G-VOLT-PH-1-AI": ("BLB-01", "BLB", "PH-1"),
    "U-BGS2-I-G-VOLT-PH-1-AI": ("BLB-02", "BLB", "PH-1"),
    "U-KGS1-SCADA-Gen-U1-Voltage-L1-AI": ("KRB-01", "KRB", "L1"),
    "U-KGS2-SCADA-Gen-U2-Voltage-L1-AI": ("KRB-02", "KRB", "L1"),
}
REVIEW_TAG = "U-LAR1-EI_81104_AVE-AI"
REVIEW_TIME = datetime(2026, 1, 17, 21, 31)
REVIEW_RAW = "3107163.00"
REVIEW_REASON = (
    "Lonjakan satu titik dibanding nilai sebelum dan sesudahnya; "
    "menunggu pemeriksaan sumber. Bukan penetapan alarm atau trip."
)


def definition(tag):
    return (
        f"Voltage generator. Kode sumber: {CHANNELS[tag][2]}. "
        "Satuan dan definisi fase/averaging belum dikonfirmasi."
    )


def inspect_voltage(file):
    filename = validate_file(file)
    info = preview_file(file.file)
    if info["source_sha256"] != SOURCE_SHA256:
        raise ValueError("File berbeda dari voltage generator Januari 2026 yang diperiksa.")
    tags = [item["tag_name"] for item in info["channels"]]
    if len(tags) != 7 or set(tags) != set(CHANNELS):
        raise ValueError("Daftar tag voltage tidak sesuai pemetaan.")
    if (info["row_count"] != 44640 or info["duplicate_timestamps"]
            or info["non_60_second_intervals"]
            or info["missing_values"] != 16 or info["invalid_values"] != 0
            or info["start_time"] != "2026-01-01 00:00:00"
            or info["end_time"] != "2026-01-31 23:59:00"):
        raise ValueError("Periode, jumlah, atau kualitas file berbeda dari hasil pemeriksaan.")
    for item in info["channels"]:
        item["suggested_unit_id"] = CHANNELS[item["tag_name"]][0]
        # Existing ENUM supports 'other', not 'voltage'.
        item["suggested_measurement_type"] = "other"
        item["parameter_kind"] = "voltage"
        item["engineering_unit"] = None
        item["measurement_definition"] = definition(item["tag_name"])
    info.update({
        "source_filename": filename,
        "parameter_kind": "voltage",
        "expected_inserted_count": 312480,
        "expected_flagged_count": 17,
        "review_points": [{
            "tag_name": REVIEW_TAG, "measured_at": REVIEW_TIME.isoformat(),
            "raw_value": REVIEW_RAW, "quality": "suspect", "reason": REVIEW_REASON,
        }],
    })
    return info


class VoltageWriter(MeasurementWriter):
    def __init__(self, cursor, batch_id, channel_ids):
        super().__init__(cursor, batch_id, channel_ids, set())
        self.reviewed_points = 0

    def consume_row(self, cells):
        is_header = self.headers is None
        # Reuse parsing/validation, not the parent writer's insertion routine.
        PreviewParser.consume_row(self, cells)
        if is_header:
            if cells[1:] != list(self.channel_ids):
                raise ValueError("Header berubah antara preview dan penyimpanan.")
            return
        for tag, raw in zip(self.headers[1:], cells[1:]):
            value, quality = parse_value(raw, False)
            if tag == REVIEW_TAG and self.previous == REVIEW_TIME:
                if raw != REVIEW_RAW or quality != "unverified":
                    raise ValueError("Nilai titik yang ditinjau berbeda dari sumber terperiksa.")
                quality = "suspect"
                self.reviewed_points += 1
            self.pending.append((
                self.channel_ids[tag], self.previous, value, raw,
                quality, self.batch_id, self.row_count,
            ))
            self.flagged += int(quality != "unverified")
            if len(self.pending) >= 1000:
                self.flush()


def save_voltage(file, info):
    connection = get_connection()
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT @@SESSION.sql_mode AS mode")
            mode = cursor.fetchone()["mode"] or ""
            cursor.execute(
                "SET SESSION sql_mode = %s",
                (mode + ",STRICT_ALL_TABLES" if mode else "STRICT_ALL_TABLES",),
            )
        connection.begin()
        with connection.cursor() as cursor:
            cursor.execute("SELECT id, plant_id FROM units")
            units = {r["id"]: r["plant_id"] for r in cursor.fetchall()}
            if any(units.get(unit) != plant for unit, plant, _ in CHANNELS.values()):
                raise ValueError("Pemetaan tujuh unit pada database belum sesuai.")
            cursor.execute(
                "SELECT id FROM import_batches WHERE source_sha256 = %s",
                (SOURCE_SHA256,),
            )
            if cursor.fetchone():
                raise ImportConflict("File voltage yang sama sudah pernah disimpan.")
            audit = {
                "mapping_confirmed": True, "parameter_kind": "voltage",
                "mapping_version": "generator-voltage-2026-01-v1",
                "unit_map_by_tag": {tag: data[0] for tag, data in CHANNELS.items()},
                "source_sha256": SOURCE_SHA256, "engineering_unit": None,
                "review_points": info["review_points"],
                "zero_policy": "Preserve zero as numeric; do not infer operating state.",
            }
            cursor.execute(
                """INSERT INTO import_batches
                   (source_filename, source_sha256, source_timezone,
                    source_datetime_format, source_row_count, import_config)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (info["source_filename"], SOURCE_SHA256, None,
                 info["source_datetime_format"], info["row_count"],
                 json.dumps(audit, ensure_ascii=False)),
            )
            batch_id = cursor.lastrowid
            channel_ids = {}
            for item in info["channels"]:
                tag = item["tag_name"]
                unit_id = CHANNELS[tag][0]
                cursor.execute(
                    """SELECT id, unit_id, measurement_type,
                              engineering_unit, measurement_definition
                       FROM channels WHERE tag_name = %s""", (tag,),
                )
                existing = cursor.fetchall()
                if any(r["unit_id"] != unit_id or r["measurement_type"] != "other"
                       or r["engineering_unit"] is not None
                       or r["measurement_definition"] != definition(tag) for r in existing):
                    raise ImportConflict("Metadata tag lama berbeda. Periksa dahulu: " + tag)
                if existing:
                    channel_ids[tag] = existing[0]["id"]
                else:
                    cursor.execute(
                        """INSERT INTO channels
                           (unit_id, tag_name, display_name, measurement_type,
                            engineering_unit, measurement_definition)
                           VALUES (%s, %s, %s, %s, %s, %s)""",
                        (unit_id, tag, "Voltage generator", "other", None, definition(tag)),
                    )
                    channel_ids[tag] = cursor.lastrowid
            writer = VoltageWriter(cursor, batch_id, channel_ids)
            actual_hash = write_stream(file.file, writer)
            if (actual_hash != SOURCE_SHA256 or writer.inserted != 312480
                    or writer.flagged != 17 or writer.reviewed_points != 1):
                raise ValueError("Hash, jumlah pengukuran, atau kualitas tidak sesuai; impor dibatalkan.")
            cursor.execute(
                "UPDATE import_batches SET inserted_count = %s, flagged_count = %s WHERE id = %s",
                (writer.inserted, writer.flagged, batch_id),
            )
        connection.commit()
        return {
            "import_batch_id": batch_id, "source_filename": info["source_filename"],
            "source_sha256": SOURCE_SHA256, "source_row_count": 44640,
            "channel_count": 7, "inserted_count": writer.inserted,
            "flagged_count": writer.flagged, "suspect_count": 1,
            "missing_count": 16, "invalid_count": 0, "skipped_count": 0,
            "source_timezone": None, "engineering_unit": None,
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
        raise HTTPException(400, "Encoding tidak didukung. Gunakan UTF-8.") from None
    except ImportConflict as error:
        raise HTTPException(409, str(error)) from None
    except ValueError as error:
        raise HTTPException(400, str(error)) from None
    except pymysql.IntegrityError as error:
        if error.args and error.args[0] == 1062:
            raise HTTPException(409, "File atau pengukuran sudah ada. Impor dibatalkan; data lama dipertahankan.") from None
        logger.error("Integritas impor voltage gagal; kode=%s", error.args[0] if error.args else "unknown")
        raise HTTPException(500, "Integritas database gagal. Periksa log backend.") from None
    except pymysql.MySQLError as error:
        logger.error("Impor voltage gagal; kode=%s", error.args[0] if error.args else "unknown")
        raise HTTPException(503, "Operasi database gagal. Periksa MySQL dan catatan impor sebelum mencoba kembali.") from None
    finally:
        file.file.close()


@router.post("/preview")
def preview_voltage(file: UploadFile = File(...)):
    with upload_errors(file):
        return {"status": "ok", "database_written": False, "data": inspect_voltage(file)}


@router.post("/commit")
def commit_voltage(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
):
    with upload_errors(file):
        if not mapping_confirmed:
            raise ValueError("Konfirmasi pemetaan tujuh unit sebelum menyimpan.")
        if source_sha256 != SOURCE_SHA256:
            raise ValueError("Hash preview tidak sesuai dengan file voltage yang diperiksa.")
        info = inspect_voltage(file)
        return {"status": "ok", "database_written": True, "data": save_voltage(file, info)}
