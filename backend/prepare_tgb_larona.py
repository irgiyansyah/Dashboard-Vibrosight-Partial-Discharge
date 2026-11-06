"""Prepare the confirmed January 2026 Larona TGB export; never write to MySQL."""
import argparse
import hashlib
import json
import re
from html import escape
from pathlib import Path

from import_preview import MAX_BYTES, PreviewParser, preview_file

SOURCE_SHA256 = "2aa12148f05692dc5874756b75374483aaa6a743c066e2bf5bcd76c268378603"
# Confirmed table order. These are internal aliases, NOT original sensor tags.
TABLE_MAP = [
    (1, "LRN-01", "X", "U-LGS1-TGB-X-IMPORT-TABLE1"),
    (2, "LRN-01", "Y", "U-LGS1-TGB-Y-IMPORT-TABLE2"),
    (3, "LRN-02", "X", "U-LGS2-TGB-X-IMPORT-TABLE3"),
    (4, "LRN-02", "Y", "U-LGS2-TGB-Y-IMPORT-TABLE4"),
    (5, "LRN-03", "X", "U-LGS3-TGB-X-IMPORT-TABLE5"),
    (6, "LRN-03", "Y", "U-LGS3-TGB-Y-IMPORT-TABLE6"),
]


class Capture(PreviewParser):
    def __init__(self):
        super().__init__()
        self.records = []

    def consume_row(self, cells):
        is_header = self.headers is None
        super().consume_row(cells)
        if not is_header:
            self.records.append(tuple(cells))


def prepare(source, output):
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("File melebihi batas ukuran.")
    raw = source.read_bytes()
    source_hash = hashlib.sha256(raw).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise ValueError(
            "File berbeda dari TGB yang sudah diperiksa. "
            "Jangan gunakan pemetaan ini untuk ekspor lain."
        )

    tables = re.findall(
        r"<table\b[^>]*>.*?</table\s*>",
        raw.decode("utf-8-sig"),
        flags=re.IGNORECASE | re.DOTALL,
    )
    if len(tables) != 6:
        raise ValueError("Harus ada tepat enam tabel sumber.")

    active = []
    table_notes = []
    expected_times = None
    for (number, unit_id, axis, alias), table in zip(TABLE_MAP, tables):
        parser = Capture()
        parser.feed(table)
        parser.close()
        if parser.headers != ["TimeStamp", "Values"]:
            raise ValueError(f"Header tabel {number} tidak sesuai.")
        if parser.in_table or parser.row is not None or parser.cell is not None:
            raise ValueError(f"Tabel {number} belum lengkap.")
        if number == 3:
            if parser.row_count != 0:
                raise ValueError("Tabel 3 berbeda: sekarang memiliki data.")
        else:
            result = parser.result()
            if result["row_count"] != 44640 or result["duplicate_timestamps"]:
                raise ValueError(f"Jumlah/waktu tabel {number} tidak sesuai.")
            if result["non_60_second_intervals"]:
                raise ValueError(f"Interval tabel {number} tidak sesuai.")
            times = [row[0] for row in parser.records]
            if expected_times is None:
                expected_times = times
            elif times != expected_times:
                raise ValueError("Waktu antartabel berbeda; penggabungan dibatalkan.")
            active.append((alias, parser.records))
        table_notes.append({
            "table": number, "unit_id": unit_id, "axis": axis,
            "internal_alias": alias, "original_tag": None,
            "rows": parser.row_count, "empty": parser.row_count == 0,
        })

    output.mkdir(parents=True, exist_ok=True)
    html_path = output / "vib_tgb_larona_prepared_v1.html"
    config_path = output / "tgb_config.json"
    provenance_path = output / "tgb_provenance.json"
    if any(p.exists() for p in (html_path, config_path, provenance_path)):
        raise ValueError("Hasil persiapan sudah ada; file lama tidak ditimpa.")

    # Same timestamps were checked above. No interpolation or invented values.
    with html_path.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write("<!doctype html><html><head><meta charset='utf-8'>")
        handle.write("<title>Larona TGB - prepared import</title></head><body>\n")
        note = {
            "source_filename": source.name,
            "source_sha256": source_hash,
            "mapping": table_notes,
            "note": "Internal aliases; table order confirmed by user; table 3 empty.",
        }
        handle.write("<pre>" + escape(json.dumps(note, ensure_ascii=False)) + "</pre>\n")
        handle.write("<table><tr><th>TimeStamp</th>")
        for alias, _ in active:
            handle.write("<th>" + escape(alias) + "</th>")
        handle.write("</tr>\n")
        for index, stamp in enumerate(expected_times):
            values = [stamp] + [rows[index][1] for _, rows in active]
            handle.write("<tr>" + "".join("<td>" + escape(v) + "</td>" for v in values) + "</tr>\n")
        handle.write("</table></body></html>\n")

    with html_path.open("rb") as stream:
        checked = preview_file(stream)
    if (checked["row_count"], checked["channel_count"], checked["missing_values"], checked["invalid_values"]) != (44640, 5, 10, 0):
        raise ValueError("Validasi hasil berbeda. Jangan impor file hasil ini.")

    config = {
        "source_sha256": checked["source_sha256"],
        "mapping_confirmed": True,
        "unit_map": {"LGS1": "LRN-01", "LGS2": "LRN-02", "LGS3": "LRN-03"},
        "vibration_tags": [alias for alias, _ in active],
        # Quarantine the entire numeric channel pending source review.
        "review_tags": ["U-LGS2-TGB-Y-IMPORT-TABLE4"],
    }
    provenance = {
        "source_filename": source.name,
        "source_sha256": source_hash,
        "prepared_filename": html_path.name,
        "prepared_sha256": checked["source_sha256"],
        "mapping_basis": "Table order confirmed by user in this workflow",
        "aliases_are_original_tags": False,
        "tables": table_notes,
        "source_timezone": None,
        "engineering_unit": None,
        "review_note": "Table 4 contains 1247.84 at 2026-01-24 09:15:00. Entire numeric channel marked suspect pending review; no alarm/trip inferred.",
        "expected_inserted_count": 223200,
        "expected_flagged_count": 44648,
    }
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    provenance_path.write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    print("Persiapan selesai. Database BELUM ditulis.")
    print(f"File impor : {html_path}")
    print(f"Konfigurasi: {config_path}")
    print(f"Catatan    : {provenance_path}")
    print("44640 baris waktu; 5 kanal; 10 nilai kosong; 223200 pengukuran.")
    print("Tabel 3 kosong. Seluruh nilai numerik tabel 4 ditandai suspect saat commit.")
    return html_path, config_path, provenance_path


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("source", type=Path)
    cli.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "local_data" / "tgb_prepared")
    args = cli.parse_args()
    try:
        prepare(args.source, args.output)
    except (OSError, ValueError) as error:
        cli.exit(1, f"Persiapan dibatalkan: {error}\n")
