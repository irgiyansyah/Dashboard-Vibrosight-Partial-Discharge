import codecs
import hashlib
import math
import re
from contextlib import suppress

from pydantic import BaseModel, ConfigDict, Field

from database import get_connection
from import_preview import MAX_BYTES, MISSING, PreviewParser, preview_file


class ImportConflict(Exception):
    pass


class ImportConfig(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    source_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    mapping_confirmed: bool
    unit_map: dict[str, str]
    review_tags: list[str] = Field(default_factory=list)


NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
PREFIX = re.compile(r"^U-(KGS[12]|BGS[12])(?:_|-)")


def parse_value(raw, review):
    if raw.upper() in MISSING:
        return None, "missing"

    if NUMBER.fullmatch(raw) is None:
        return None, "invalid"

    value = float(raw)

    if not math.isfinite(value):
        return None, "invalid"

    return value, "suspect" if review else "unverified"


class MeasurementWriter(PreviewParser):
    def __init__(self, cursor, batch_id, channel_ids, review_tags):
        super().__init__()

        self.cursor = cursor
        self.batch_id = batch_id
        self.channel_ids = channel_ids
        self.review_tags = review_tags

        self.pending = []
        self.inserted = 0
        self.flagged = 0

    def consume_row(self, cells):
        is_header = self.headers is None

        # Gunakan validasi struktur, tanggal, dan baris dari parser preview.
        super().consume_row(cells)

        if is_header:
            if cells[1:] != list(self.channel_ids):
                raise ValueError("Header berubah antara preview dan impor.")
            return

        for tag, raw in zip(self.headers[1:], cells[1:]):
            value, quality = parse_value(
                raw,
                tag in self.review_tags,
            )

            self.pending.append((
                self.channel_ids[tag],
                self.previous,
                value,
                raw,
                quality,
                self.batch_id,
                self.row_count,
            ))

            self.flagged += int(quality != "unverified")

            # Kirim bertahap agar tidak menampung seluruh data di memori.
            if len(self.pending) >= 1000:
                self.flush()

    def flush(self):
        if self.pending:
            self.cursor.executemany(
                """INSERT INTO measurements
                   (channel_id, measured_at, measured_value, raw_value,
                    quality, import_batch_id, source_row)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                self.pending,
            )

            self.inserted += len(self.pending)
            self.pending.clear()


def write_stream(stream, writer):
    stream.seek(0)

    decoder = codecs.getincrementaldecoder(
        "utf-8-sig"
    )(errors="strict")

    digest = hashlib.sha256()
    size = 0

    while chunk := stream.read(1024 * 1024):
        size += len(chunk)

        if size > MAX_BYTES:
            raise ValueError("Ukuran file melebihi 100 MiB.")

        digest.update(chunk)
        writer.feed(decoder.decode(chunk))

    writer.feed(decoder.decode(b"", final=True))
    writer.close()

    # Pastikan tabel selesai dan tidak terpotong.
    writer.result()
    writer.flush()

    return digest.hexdigest()


def save_import(stream, filename, config):
    if not config.mapping_confirmed:
        raise ValueError(
            "Konfirmasi pemetaan unit sebelum menyimpan."
        )

    # Validasi seluruh file sebelum membuka transaksi.
    preview = preview_file(stream)

    if preview["source_sha256"] != config.source_sha256:
        raise ValueError(
            "Hash berbeda. Lakukan preview file ini kembali."
        )

    if preview["duplicate_timestamps"]:
        raise ValueError(
            "Ada waktu duplikat dalam file. Periksa dahulu."
        )

    if int(preview["start_time"][:4]) < 1000:
        raise ValueError(
            "Tahun pengukuran di luar rentang DATETIME database."
        )

    tags = [
        channel["tag_name"]
        for channel in preview["channels"]
    ]

    if not set(config.review_tags).issubset(tags):
        raise ValueError(
            "review_tags memuat tag yang tidak ada dalam file."
        )

    mapping = {}
    prefixes = set()

    for tag in tags:
        match = PREFIX.match(tag)

        if match is None or match.group(1) not in config.unit_map:
            raise ValueError(
                f"Pemetaan unit belum tersedia untuk: {tag}"
            )

        prefix = match.group(1)
        prefixes.add(prefix)
        mapping[tag] = config.unit_map[prefix]

    if prefixes != set(config.unit_map):
        raise ValueError(
            "unit_map harus hanya memuat awalan tag dalam file."
        )

    if len(set(config.unit_map.values())) != len(config.unit_map):
        raise ValueError(
            "Setiap awalan tag harus dipetakan ke unit berbeda."
        )

    connection = get_connection()

    try:
        # Pastikan database menolak nilai yang tidak sesuai tipe kolom.
        with connection.cursor() as cursor:
            cursor.execute("SELECT @@SESSION.sql_mode AS mode")
            mode = cursor.fetchone()["mode"] or ""

            cursor.execute(
                "SET SESSION sql_mode = %s",
                (
                    mode + ",STRICT_ALL_TABLES"
                    if mode
                    else "STRICT_ALL_TABLES",
                ),
            )

        # Transaksi eksplisit meskipun database.py memakai autocommit=True.
        connection.begin()

        with connection.cursor() as cursor:
            cursor.execute("SELECT id, plant_id FROM units")

            units = {
                row["id"]: row["plant_id"]
                for row in cursor.fetchall()
            }

            for prefix, unit_id in config.unit_map.items():
                plant = (
                    "KRB"
                    if prefix.startswith("KGS")
                    else "BLB"
                )

                if units.get(unit_id) != plant:
                    raise ValueError(
                        f"Unit {unit_id} tidak sesuai PLTA untuk {prefix}."
                    )

            # Cegah file identik diimpor kembali.
            cursor.execute(
                """
                SELECT id
                FROM import_batches
                WHERE source_sha256 = %s
                """,
                (config.source_sha256,),
            )

            if cursor.fetchone():
                raise ImportConflict(
                    "File yang sama sudah pernah disimpan."
                )

            cursor.execute(
                """INSERT INTO import_batches
                   (source_filename, source_sha256, source_timezone,
                    source_datetime_format, source_row_count, import_config)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    filename,
                    config.source_sha256,
                    None,
                    preview["source_datetime_format"],
                    preview["row_count"],
                    config.model_dump_json(),
                ),
            )

            batch_id = cursor.lastrowid
            channel_ids = {}

            for tag, unit_id in mapping.items():
                cursor.execute(
                    """
                    SELECT id, unit_id
                    FROM channels
                    WHERE tag_name = %s
                    """,
                    (tag,),
                )

                existing = cursor.fetchall()

                if any(
                    row["unit_id"] != unit_id
                    for row in existing
                ):
                    raise ImportConflict(
                        f"Tag sudah terdaftar pada unit berbeda: {tag}"
                    )

                if existing:
                    channel_ids[tag] = existing[0]["id"]

                else:
                    # Jenis dan satuan belum dianggap terverifikasi.
                    cursor.execute(
                        """INSERT INTO channels
                           (unit_id, tag_name, measurement_type)
                           VALUES (%s, %s, 'unknown')""",
                        (unit_id, tag),
                    )

                    channel_ids[tag] = cursor.lastrowid

            writer = MeasurementWriter(
                cursor,
                batch_id,
                channel_ids,
                set(config.review_tags),
            )

            actual_hash = write_stream(stream, writer)

            expected = (
                preview["row_count"] * len(channel_ids)
            )

            if (
                actual_hash != config.source_sha256
                or writer.inserted != expected
            ):
                raise ValueError(
                    "Isi file atau jumlah pengukuran tidak konsisten."
                )

            cursor.execute(
                """UPDATE import_batches
                   SET inserted_count = %s, flagged_count = %s
                   WHERE id = %s""",
                (
                    writer.inserted,
                    writer.flagged,
                    batch_id,
                ),
            )

        # Semua bagian impor berhasil: simpan transaksi.
        connection.commit()

        return {
            "import_batch_id": batch_id,
            "source_row_count": preview["row_count"],
            "channel_count": len(channel_ids),
            "inserted_count": writer.inserted,
            "flagged_count": writer.flagged,
            "skipped_count": 0,
            "source_timezone": None,
        }

    except Exception:
        # Batalkan perubahan jika terjadi kegagalan sebelum commit.
        with suppress(Exception):
            connection.rollback()

        raise

    finally:
        connection.close()