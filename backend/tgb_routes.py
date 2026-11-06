"""Import the confirmed Larona TGB export directly, without project data files."""
import hashlib
import json
import logging
import re
from contextlib import contextmanager, suppress
from datetime import datetime

import pymysql
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from database import get_connection
from import_preview import MAX_BYTES, PreviewParser
from import_service import ImportConflict, parse_value

router = APIRouter(prefix="/api/imports/tgb", tags=["Import TGB Larona"])
logger = logging.getLogger(__name__)
SOURCE_SHA256 = "2aa12148f05692dc5874756b75374483aaa6a743c066e2bf5bcd76c268378603"
TABLE_MAP = (
    (1, "LRN-01", "X", "U-LGS1-TGB-X-IMPORT-TABLE1"),
    (2, "LRN-01", "Y", "U-LGS1-TGB-Y-IMPORT-TABLE2"),
    (3, "LRN-02", "X", "U-LGS2-TGB-X-IMPORT-TABLE3"),
    (4, "LRN-02", "Y", "U-LGS2-TGB-Y-IMPORT-TABLE4"),
    (5, "LRN-03", "X", "U-LGS3-TGB-X-IMPORT-TABLE5"),
    (6, "LRN-03", "Y", "U-LGS3-TGB-Y-IMPORT-TABLE6"),
)


class Capture(PreviewParser):
    def __init__(self):
        super().__init__()
        self.records = []

    def consume_row(self, cells):
        is_header = self.headers is None
        super().consume_row(cells)
        if not is_header:
            self.records.append((self.previous, cells[1]))


def read_tgb(file):
    filename = (file.filename or "").replace("\\", "/").rsplit("/", 1)[-1]
    if not filename or len(filename) > 255:
        raise ValueError("Nama file kosong atau terlalu panjang.")
    if not filename.lower().endswith((".xls", ".html", ".htm")):
        raise ValueError("Gunakan file ekspor HTML .xls, .html, atau .htm.")
    if file.size is not None and file.size > MAX_BYTES:
        raise HTTPException(413, "Ukuran file melebihi 100 MiB.")
    file.file.seek(0)
    raw = file.file.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise HTTPException(413, "Ukuran file melebihi 100 MiB.")
    source_hash = hashlib.sha256(raw).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise ValueError(
            "File berbeda dari TGB Larona yang pemetaan tabelnya sudah "
            "dikonfirmasi. Ekspor lain perlu diperiksa dahulu."
        )
    tables = re.findall(
        r"<table\b[^>]*>.*?</table\s*>",
        raw.decode("utf-8-sig"),
        flags=re.IGNORECASE | re.DOTALL,
    )
    del raw
    if len(tables) != 6:
        raise ValueError("File harus berisi enam tabel sumber.")

    metadata, active, times = [], [], None
    for (number, unit_id, axis, alias), table in zip(TABLE_MAP, tables):
        parser = Capture()
        parser.feed(table)
        parser.close()
        if parser.headers != ["TimeStamp", "Values"]:
            raise ValueError(f"Header tabel {number} tidak sesuai.")
        if parser.in_table or parser.row is not None or parser.cell is not None:
            raise ValueError(f"Tabel {number} tidak lengkap.")
        meta = {
            "table": number, "unit_id": unit_id, "axis": axis,
            "tag_name": alias, "original_tag": None,
            "is_internal_alias": True, "row_count": parser.row_count,
            "empty": parser.row_count == 0,
            "review_entire_channel": number == 4,
        }
        if number == 3:
            if parser.row_count != 0:
                raise ValueError("Isi tabel 3 berbeda dari yang sudah dikonfirmasi.")
        else:
            result = parser.result()
            if (result["row_count"] != 44640
                    or result["duplicate_timestamps"]
                    or result["non_60_second_intervals"]):
                raise ValueError(f"Jumlah atau interval tabel {number} tidak sesuai.")
            row_times = [stamp for stamp, _ in parser.records]
            if times is None:
                times = row_times
            elif times != row_times:
                raise ValueError("Waktu antartabel berbeda. Impor dibatalkan.")
            channel = result["channels"][0]
            for key in ("numeric_count", "missing_count", "invalid_count",
                        "negative_count", "min", "max"):
                meta[key] = channel[key]
            active.append({"meta": meta, "records": parser.records})
        metadata.append(meta)

    if (times[0], times[-1]) != (
        datetime(2026, 1, 1), datetime(2026, 1, 31, 23, 59)
    ):
        raise ValueError("Periode file tidak sesuai.")
    missing = sum(item["meta"]["missing_count"] for item in active)
    invalid = sum(item["meta"]["invalid_count"] for item in active)
    if (len(active), missing, invalid) != (5, 10, 0):
        raise ValueError("Jumlah kanal atau kualitas data berbeda.")
    public = {
        "source_filename": filename, "source_sha256": source_hash,
        "source_format": "HTML with six source tables",
        "source_datetime_format": "%m/%d/%Y %H:%M:%S",
        "source_timezone": None, "engineering_unit": None,
        "row_count": len(times), "table_count": 6, "channel_count": 5,
        "start_time": times[0].isoformat(sep=" "),
        "end_time": times[-1].isoformat(sep=" "),
        "missing_values": missing, "invalid_values": invalid,
        "expected_inserted_count": 223200, "expected_flagged_count": 44648,
        "mapping_confirmed": False, "tables": metadata,
        "review_note": (
            "Tabel 3 kosong. Seluruh nilai numerik tabel 4 (TGB Y Unit 2) "
            "ditandai suspect sementara menunggu pemeriksaan sumber. "
            "Nama kanal adalah alias internal, bukan tag asli sensor."
        ),
    }
    return public, active


def save_tgb(public, active):
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
            if any(units.get(f"LRN-0{i}") != "LRN" for i in (1, 2, 3)):
                raise ValueError("Unit Larona pada database belum sesuai.")
            cursor.execute(
                "SELECT id FROM import_batches WHERE source_sha256 = %s",
                (public["source_sha256"],),
            )
            if cursor.fetchone():
                raise ImportConflict("File TGB yang sama sudah pernah disimpan.")
            audit = {
                "mapping_version": "larona-tgb-2026-01-v1",
                "mapping_confirmed": True,
                "mapping_basis": "Urutan tabel dikonfirmasi pengguna",
                "tables": public["tables"],
                "review_note": public["review_note"],
                "source_sha256": public["source_sha256"],
            }
            cursor.execute(
                """INSERT INTO import_batches
                   (source_filename, source_sha256, source_timezone,
                    source_datetime_format, source_row_count, import_config)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (public["source_filename"], public["source_sha256"], None,
                 public["source_datetime_format"], public["row_count"],
                 json.dumps(audit, ensure_ascii=False)),
            )
            batch_id = cursor.lastrowid
            inserted = flagged = 0
            sql = """INSERT INTO measurements
                     (channel_id, measured_at, measured_value, raw_value,
                      quality, import_batch_id, source_row)
                     VALUES (%s, %s, %s, %s, %s, %s, %s)"""
            for item in active:
                meta = item["meta"]
                cursor.execute(
                    "SELECT id, unit_id, measurement_type FROM channels WHERE tag_name = %s",
                    (meta["tag_name"],),
                )
                existing = cursor.fetchall()
                if any(r["unit_id"] != meta["unit_id"]
                       or r["measurement_type"] != "vibration" for r in existing):
                    raise ImportConflict("Metadata kanal berbeda: " + meta["tag_name"])
                if existing:
                    channel_id = existing[0]["id"]
                else:
                    cursor.execute(
                        "INSERT INTO channels (unit_id, tag_name, measurement_type) VALUES (%s, %s, %s)",
                        (meta["unit_id"], meta["tag_name"], "vibration"),
                    )
                    channel_id = cursor.lastrowid
                pending = []
                for source_row, (stamp, raw) in enumerate(item["records"], 1):
                    value, quality = parse_value(raw, meta["review_entire_channel"])
                    pending.append((channel_id, stamp, value, raw, quality, batch_id, source_row))
                    inserted += 1
                    flagged += int(quality != "unverified")
                    if len(pending) == 1000:
                        cursor.executemany(sql, pending)
                        pending.clear()
                if pending:
                    cursor.executemany(sql, pending)
            if (inserted, flagged) != (223200, 44648):
                raise ValueError("Jumlah pengukuran atau kualitas tidak sesuai; impor dibatalkan.")
            cursor.execute(
                "UPDATE import_batches SET inserted_count = %s, flagged_count = %s WHERE id = %s",
                (inserted, flagged, batch_id),
            )
        connection.commit()
        return {
            "import_batch_id": batch_id, "source_filename": public["source_filename"],
            "source_sha256": public["source_sha256"],
            "source_row_count": public["row_count"], "channel_count": 5,
            "inserted_count": inserted, "flagged_count": flagged,
            "skipped_count": 0, "empty_tables": [3], "source_timezone": None,
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
            raise HTTPException(
                409, "File atau pengukuran sudah ada. Impor dibatalkan; data lama dipertahankan."
            ) from None
        logger.error("Integritas impor TGB gagal; kode=%s", error.args[0] if error.args else "unknown")
        raise HTTPException(500, "Integritas database gagal. Periksa log backend.") from None
    except pymysql.MySQLError as error:
        logger.error("Impor TGB gagal; kode=%s", error.args[0] if error.args else "unknown")
        raise HTTPException(
            503, "Operasi database gagal. Periksa MySQL dan catatan impor sebelum mencoba kembali."
        ) from None
    finally:
        file.file.close()


@router.post("/preview")
def preview_tgb(file: UploadFile = File(...)):
    with upload_errors(file):
        public, _ = read_tgb(file)
        return {"status": "ok", "database_written": False, "data": public}


@router.post("/commit")
def commit_tgb(
    file: UploadFile = File(...),
    source_sha256: str = Form(...),
    mapping_confirmed: bool = Form(False),
):
    with upload_errors(file):
        if not mapping_confirmed:
            raise ValueError("Konfirmasi pemetaan tabel sebelum menyimpan.")
        if source_sha256 != SOURCE_SHA256:
            raise ValueError("Hash preview tidak sesuai file TGB yang disetujui.")
        public, active = read_tgb(file)
        result = save_tgb(public, active)
        return {"status": "ok", "database_written": True, "data": result}
