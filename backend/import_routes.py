import logging

import pymysql
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import ValidationError

from import_preview import MAX_BYTES, preview_file
from import_service import ImportConfig, ImportConflict, save_import


logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/imports",
    tags=["Imports"],
)


def validate_file(file):
    filename = (
        (file.filename or "")
        .replace("\\", "/")
        .rsplit("/", 1)[-1]
    )

    if not filename or len(filename) > 255:
        raise HTTPException(
            400,
            "Nama file kosong atau terlalu panjang.",
        )

    if not filename.lower().endswith(
        (".xls", ".html", ".htm")
    ):
        raise HTTPException(
            400,
            "Gunakan ekspor tabel HTML .xls, .html, atau .htm.",
        )

    if file.size is not None and file.size > MAX_BYTES:
        raise HTTPException(
            413,
            "Ukuran file melebihi 100 MiB.",
        )

    return filename


@router.post("/preview")
def preview_import(file: UploadFile = File(...)):
    try:
        filename = validate_file(file)

        result = preview_file(file.file)
        result["source_filename"] = filename

        return {
            "status": "ok",
            "database_written": False,
            "data": result,
        }

    except UnicodeDecodeError:
        raise HTTPException(
            400,
            "Encoding tidak didukung. Gunakan UTF-8.",
        ) from None

    except ValueError as error:
        raise HTTPException(
            400,
            str(error),
        ) from None

    finally:
        file.file.close()


@router.post("/commit")
def commit_import(
    file: UploadFile = File(...),
    config_json: str = Form(...),
):
    try:
        filename = validate_file(file)

        if len(config_json) > 32_000:
            raise HTTPException(
                400,
                "Konfigurasi impor terlalu panjang.",
            )

        config = ImportConfig.model_validate_json(
            config_json
        )

        result = save_import(
            file.file,
            filename,
            config,
        )

        return {
            "status": "ok",
            "database_written": True,
            "data": result,
        }

    except ValidationError:
        raise HTTPException(
            400,
            "Format config_json tidak sesuai contoh.",
        ) from None

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
        if error.args[0] == 1062:
            raise HTTPException(
                409,
                (
                    "File, kanal, atau waktu pengukuran "
                    "bertabrakan dengan data yang sudah ada. "
                    "Impor ini dibatalkan; data lama dipertahankan."
                ),
            ) from None

        logger.error(
            "Integritas database gagal, kode=%s",
            error.args[0],
        )

        raise HTTPException(
            500,
            "Relasi data tidak sesuai. Periksa log backend.",
        ) from None

    except pymysql.MySQLError as error:
        logger.error(
            "Operasi database gagal, kode=%s",
            error.args[0],
        )

        raise HTTPException(
            503,
            (
                "Operasi database gagal. "
                "Periksa MySQL dan log backend. "
                "Periksa catatan impor sebelum mencoba kembali."
            ),
        ) from None

    finally:
        file.file.close()