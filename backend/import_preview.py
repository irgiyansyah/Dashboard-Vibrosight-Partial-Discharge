import codecs
import hashlib
import math
import re
from collections import Counter
from datetime import datetime
from html.parser import HTMLParser


MAX_BYTES = 100 * 1024 * 1024
MAX_ROWS = 100_000

# Sesuai format kedua file yang sudah diperiksa.
DATE_FORMAT = "%m/%d/%Y %H:%M:%S"

MISSING = {"", "N/A", "NA", "NULL"}

# Usulan berdasarkan awalan tag, belum konfirmasi pengguna.
UNIT_MAP = {
    "KGS1": "KRB-01",
    "KGS2": "KRB-02",
    "BGS1": "BLB-01",
    "BGS2": "BLB-02",
}


def suggest_channel(tag):
    match = re.match(r"^U-(KGS[12]|BGS[12])(?:_|-)", tag)
    unit_id = UNIT_MAP.get(match.group(1)) if match else None

    upper = tag.upper()
    kind = "unknown"

    if "VIB" in upper:
        kind = "vibration"
    elif any(
        word in upper
        for word in ("TEMP", "TMP", "_TE_", "-PAD")
    ):
        kind = "temperature"
    elif "SPEED" in upper:
        # Mengikuti pilihan ENUM pada tabel channels saat ini.
        kind = "other"

    return unit_id, kind


class PreviewParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)

        self.table_count = 0
        self.in_table = False

        self.row = None
        self.cell = None
        self.headers = None

        self.channels = []
        self.row_count = 0

        self.seen_times = set()
        self.duplicates = 0
        self.intervals = Counter()

        self.previous = None
        self.start = None
        self.end = None

        self.samples = []

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.table_count += 1

            if self.table_count > 1:
                raise ValueError(
                    "File harus berisi tepat satu tabel."
                )

            self.in_table = True

        elif self.in_table and tag == "tr":
            if self.row is not None:
                raise ValueError(
                    "Struktur baris HTML tidak lengkap."
                )

            self.row = []

        elif self.in_table and tag in ("td", "th"):
            if self.row is None or self.cell is not None:
                raise ValueError(
                    "Struktur sel HTML tidak sesuai."
                )

            if any(
                key in ("colspan", "rowspan") and value != "1"
                for key, value in attrs
            ):
                raise ValueError(
                    "Sel gabungan belum didukung."
                )

            self.cell = ""

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data

            if len(self.cell) > 2048:
                raise ValueError("Isi sel terlalu panjang.")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(self.cell.strip())
            self.cell = None

            if len(self.row) > 65:
                raise ValueError(
                    "Maksimal 64 kanal per file."
                )

        elif tag == "tr" and self.row is not None:
            if self.cell is not None:
                raise ValueError(
                    "Ada sel yang belum ditutup."
                )

            self.consume_row(self.row)
            self.row = None

        elif tag == "table":
            if self.row is not None or self.cell is not None:
                raise ValueError(
                    "Tabel HTML tidak lengkap."
                )

            self.in_table = False

    def consume_row(self, cells):
        # Baris pertama adalah header.
        if self.headers is None:
            if (
                len(cells) < 2
                or cells[0].lower() != "timestamp"
            ):
                raise ValueError(
                    "Kolom pertama harus TimeStamp, "
                    "diikuti tag pengukuran."
                )

            tags = cells[1:]

            if any(
                not tag or len(tag) > 191
                for tag in tags
            ):
                raise ValueError(
                    "Nama tag kosong atau lebih dari 191 karakter."
                )

            if len(tags) != len(set(tags)):
                raise ValueError(
                    "Ada nama tag duplikat dalam header."
                )

            self.headers = cells

            for tag in tags:
                unit_id, kind = suggest_channel(tag)

                self.channels.append({
                    "tag_name": tag,
                    "suggested_unit_id": unit_id,
                    "suggested_measurement_type": kind,
                    "engineering_unit": None,
                    "numeric_count": 0,
                    "missing_count": 0,
                    "invalid_count": 0,
                    "negative_count": 0,
                    "zero_count": 0,
                    "minus_200_count": 0,
                    "min": None,
                    "max": None,
                })

            return

        # Baris berikutnya adalah data pengukuran.
        self.row_count += 1

        if self.row_count > MAX_ROWS:
            raise ValueError(
                "Maksimal 100.000 baris waktu per file."
            )

        if len(cells) != len(self.headers):
            raise ValueError(
                "Jumlah kolom berbeda pada baris data "
                f"{self.row_count}."
            )

        if any(len(value) > 255 for value in cells):
            raise ValueError(
                "Nilai terlalu panjang pada baris data "
                f"{self.row_count}."
            )

        if not re.fullmatch(
            r"\d{2}/\d{2}/\d{4} \d{2}:\d{2}:\d{2}",
            cells[0],
        ):
            raise ValueError(
                "Format waktu salah pada baris data "
                f"{self.row_count}."
            )

        try:
            timestamp = datetime.strptime(
                cells[0],
                DATE_FORMAT,
            )
        except ValueError:
            raise ValueError(
                "Tanggal tidak valid pada baris data "
                f"{self.row_count}."
            ) from None

        if timestamp in self.seen_times:
            self.duplicates += 1

        self.seen_times.add(timestamp)

        if self.previous is not None:
            seconds = int(
                (timestamp - self.previous).total_seconds()
            )
            self.intervals[seconds] += 1

        self.previous = timestamp

        self.start = (
            timestamp
            if self.start is None
            else min(self.start, timestamp)
        )

        self.end = (
            timestamp
            if self.end is None
            else max(self.end, timestamp)
        )

        # Hanya tiga baris contoh yang dikirim ke browser.
        if len(self.samples) < 3:
            self.samples.append(
                dict(zip(self.headers, cells))
            )

        for channel, raw in zip(
            self.channels,
            cells[1:],
        ):
            if raw.upper() in MISSING:
                channel["missing_count"] += 1
                continue

            try:
                if not re.fullmatch(
                    r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
                    r"(?:[eE][+-]?\d+)?",
                    raw,
                ):
                    raise ValueError

                value = float(raw)

                if not math.isfinite(value):
                    raise ValueError

            except ValueError:
                channel["invalid_count"] += 1
                continue

            channel["numeric_count"] += 1
            channel["negative_count"] += int(value < 0)
            channel["zero_count"] += int(value == 0)
            channel["minus_200_count"] += int(value == -200)

            channel["min"] = (
                value
                if channel["min"] is None
                else min(channel["min"], value)
            )

            channel["max"] = (
                value
                if channel["max"] is None
                else max(channel["max"], value)
            )

    def result(self):
        if (
            self.in_table
            or self.row is not None
            or self.cell is not None
        ):
            raise ValueError(
                "File HTML terpotong atau belum lengkap."
            )

        if self.headers is None or self.row_count == 0:
            raise ValueError(
                "Tidak ditemukan tabel pengukuran berisi data."
            )

        for channel in self.channels:
            channel["constant_numeric_value"] = (
                channel["numeric_count"] > 1
                and channel["min"] == channel["max"]
            )

        return {
            "source_format": "HTML table",
            "source_datetime_format": DATE_FORMAT,
            "source_timezone": None,
            "row_count": self.row_count,
            "channel_count": len(self.channels),
            "start_time": self.start.isoformat(sep=" "),
            "end_time": self.end.isoformat(sep=" "),
            "duplicate_timestamps": self.duplicates,
            "interval_seconds": [
                {
                    "seconds": seconds,
                    "count": count,
                }
                for seconds, count
                in self.intervals.most_common(10)
            ],
            "non_60_second_intervals": sum(
                count
                for seconds, count in self.intervals.items()
                if seconds != 60
            ),
            "missing_values": sum(
                channel["missing_count"]
                for channel in self.channels
            ),
            "invalid_values": sum(
                channel["invalid_count"]
                for channel in self.channels
            ),
            "mapping_confirmed": False,
            "channels": self.channels,
            "sample_rows": self.samples,
        }


def preview_file(stream):
    parser = PreviewParser()

    decoder = codecs.getincrementaldecoder(
        "utf-8-sig"
    )(errors="strict")

    digest = hashlib.sha256()
    size = 0

    stream.seek(0)

    # Baca bertahap, bukan menampung seluruh tabel di memori.
    while chunk := stream.read(1024 * 1024):
        if size == 0 and chunk.startswith(
            (b"PK\x03\x04", b"\xd0\xcf\x11\xe0")
        ):
            raise ValueError(
                "Endpoint ini untuk ekspor HTML .xls, "
                "bukan workbook Excel biner."
            )

        size += len(chunk)

        if size > MAX_BYTES:
            raise ValueError(
                "Ukuran file melebihi 100 MiB."
            )

        digest.update(chunk)
        parser.feed(decoder.decode(chunk))

    parser.feed(decoder.decode(b"", final=True))
    parser.close()

    result = parser.result()
    result["file_size_bytes"] = size
    result["source_sha256"] = digest.hexdigest()

    return result