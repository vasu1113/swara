"""FastAPI entry point for Swara's context vault server."""

from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from context_store import list_context, seed_profile
from documents import router as documents_router
from planner import plan
from schemas import ContextItem, PlanRequest, PlanResponse


app = FastAPI(title="Swara server")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(RuntimeError)
async def runtime_error_handler(_, exc: RuntimeError) -> JSONResponse:
    """Surface missing configuration cleanly instead of an opaque 500 body."""
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/health")
def health() -> dict[str, bool | str]:
    return {
        "status": "ok",
        "supabase": bool(settings.supabase_url and settings.supabase_service_key),
        "sarvam": bool(settings.sarvam_api_key),
        "gemini": bool(settings.google_api_key),
    }


@app.get("/context", response_model=list[ContextItem])
def get_context(
    scope: str | None = Query(default=None),
    session_id: str | None = Query(default=None),
) -> list[ContextItem]:
    return list_context(scope=scope, session_id=session_id)


@app.post("/context/seed", response_model=list[ContextItem])
def seed_context() -> list[ContextItem]:
    return seed_profile()


@app.post("/plan", response_model=PlanResponse)
def make_plan(request: PlanRequest) -> PlanResponse:
    return plan(request)


app.include_router(documents_router)
