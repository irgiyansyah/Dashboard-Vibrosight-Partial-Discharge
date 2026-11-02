import logging

import pymysql
from fastapi import FastAPI, HTTPException
from import_routes import router as import_router
from database import get_connection
from fastapi.middleware.cors import CORSMiddleware
from import_routes import router as import_router



app = FastAPI(title="Hydro Insight API")
app.include_router(import_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["Accept"],
)
app.include_router(import_router)
logger = logging.getLogger("uvicorn.error")


@app.get("/")
def root():
    return {
        "message": "Hydro Insight API berhasil berjalan",
        "database": "Periksa melalui /api/units",
    }


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "hydro-insight-backend",
    }


@app.get("/api/units")
def get_units():
    connection = None

    try:
        connection = get_connection()

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    u.id AS id,
                    p.id AS plant_id,
                    p.name AS plant,
                    u.name AS name
                FROM units AS u
                JOIN plants AS p ON p.id = u.plant_id
                ORDER BY
                    FIELD(p.id, 'LRN', 'KRB', 'BLB'),
                    u.id
                """
            )

            units = cursor.fetchall()

        return {
            "status": "ok",
            "total": len(units),
            "data": units,
        }

    except pymysql.MySQLError as error:
        error_code = error.args[0] if error.args else "unknown"
        logger.error("Query database gagal. Kode: %s", error_code)

        raise HTTPException(
            status_code=503,
            detail=(
                "Data unit belum dapat dibaca. "
                "Periksa layanan MySQL dan konfigurasi backend."
            ),
        ) from None

    finally:
        if connection is not None:
            connection.close()