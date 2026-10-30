from fastapi import FastAPI

app = FastAPI(title="Hydro Insight API")


@app.get("/")
def root():
    return {
        "message": "Hydro Insight API berhasil berjalan",
        "database": "Belum diuji",
    }


@app.get("/api/health")
def health_check():
    return {
        "status": "ok",
        "service": "hydro-insight-backend",
    }