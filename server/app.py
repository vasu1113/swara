"""FastAPI entry point for Swara's context vault server."""

from __future__ import annotations

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import settings
from context_store import apply_memory_update, list_context, seed_profile
from planner import plan
from pipecat_session import router as pipecat_session_router
from schemas import ContextItem, MemoryApplyRequest, PlanRequest, PlanResponse
from session import live_session
from vault import router as vault_router
from voice import router as voice_router


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


@app.post("/memory/apply", response_model=list[ContextItem])
def apply_memory(request: MemoryApplyRequest) -> list[ContextItem]:
    """Persist the plan's classified memory once the user has accepted it.

    Each update is routed by its own type: corrections supersede the fact they
    replace, instructions stay bound to this session, facts and preferences
    become persistent.
    """
    return [
        apply_memory_update(update, session_id=request.session_id)
        for update in request.memory_updates
    ]


app.include_router(vault_router)
app.include_router(pipecat_session_router)
app.add_api_websocket_route("/session/live", live_session)
app.include_router(voice_router)
