import logging

import pymysql
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from wicket_gate_routes import router as wicket_gate_router
from database import get_connection
from import_routes import router as import_router
from monitoring_routes import router as monitoring_router
from tgb_routes import router as tgb_router
from voltage_routes import router as voltage_router 
from current_routes import router as current_router
from speed_routes import router as speed_router
from power_routes import router as power_router

app = FastAPI(title="Hydro Insight API")
app.include_router(tgb_router)
app.include_router(voltage_router)
app.include_router(current_router)
app.include_router(wicket_gate_router)
app.include_router(speed_router)
app.include_router(power_router)
logger = logging.getLogger("uvicorn.error")


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Accept", "Content-Type"],
)


# Setiap router didaftarkan cukup sekali.
app.include_router(import_router)
app.include_router(monitoring_router)


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
        code = error.args[0] if error.args else "unknown"

        logger.error(
            "Query database gagal. Kode: %s",
            code,
        )

        raise HTTPException(
            status_code=503,
            detail=(
                "Data unit belum dapat dibaca. "
                "Periksa MySQL dan konfigurasi backend."
            ),
        ) from None

    finally:
        if connection is not None:
            connection.close()