"""Supabase-backed context vault.

The service key is kept entirely on the server and is only requested when a
vault operation is performed, so imports and the health endpoint work without
credentials.
"""

from __future__ import annotations

from typing import Any

from config import require
from schemas import ContextItem, MemoryUpdate
from seed_data import SEED_PROFILE


def _client() -> Any:
    """Create a Supabase client only when the vault is used."""
    try:
        from supabase import create_client
    except ImportError as exc:  # Helpful when requirements have not been installed yet.
        raise RuntimeError("Supabase SDK is unavailable. Install server/requirements.txt.") from exc

    return create_client(require("SUPABASE_URL"), require("SUPABASE_SERVICE_KEY"))


def _to_context_item(row: dict[str, Any]) -> ContextItem:
    return ContextItem.model_validate(row)


def list_context(
    scope: str | None = None,
    session_id: str | None = None,
    include_superseded: bool = False,
) -> list[ContextItem]:
    """Return vault rows, optionally limited to one scope and/or session."""
    query = _client().table("context_items").select("*")
    if scope:
        query = query.eq("scope", scope)
    if session_id:
        query = query.eq("session_id", session_id)
    if not include_superseded:
        query = query.is_("superseded_by", "null")

    response = query.order("created_at", desc=False).execute()
    return [_to_context_item(row) for row in (response.data or [])]


def add_context(item: ContextItem) -> ContextItem:
    """Insert one context item and return its database representation."""
    payload = item.model_dump(exclude_none=True)
    payload.pop("id", None)
    response = _client().table("context_items").insert(payload).execute()
    if not response.data:
        raise RuntimeError("Supabase did not return the inserted context item.")
    return _to_context_item(response.data[0])


def _current_persistent_item(key: str) -> ContextItem | None:
    response = (
        _client()
        .table("context_items")
        .select("*")
        .eq("key", key)
        .eq("scope", "persistent")
        .is_("superseded_by", "null")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    if not response.data:
        return None
    return _to_context_item(response.data[0])


def apply_memory_update(update: MemoryUpdate, session_id: str) -> ContextItem:
    """Persist an extracted memory update, retaining correction history."""
    if update.type == "instruction":
        # Instructions are deliberately confined to this form session.
        scope = "session" if update.scope == "session" else "task"
        return add_context(
            ContextItem(
                type="instruction",
                category="instruction",
                key=update.key,
                value=update.value,
                source=update.reason,
                source_type="instruction",
                scope=scope,
                session_id=session_id,
            )
        )

    item = ContextItem(
        type=update.type,
        category="preference" if update.type == "preference" else "fact",
        key=update.key,
        value=update.value,
        source=update.reason,
        source_type="memory_update",
        scope=update.scope,
    )

    if update.type != "correction":
        return add_context(item)

    # Insert first to obtain the replacement id, then point the prior live row
    # at it. The old row remains queryable with include_superseded=True.
    prior = _current_persistent_item(update.key)
    corrected = add_context(item.model_copy(update={"scope": "persistent"}))
    if prior and prior.id:
        (
            _client()
            .table("context_items")
            .update({"superseded_by": corrected.id})
            .eq("id", prior.id)
            .execute()
        )
    return corrected


def clear_task_context(session_id: str) -> None:
    """Remove temporary task-scoped instructions for a completed form."""
    (
        _client()
        .table("context_items")
        .delete()
        .eq("scope", "task")
        .eq("session_id", session_id)
        .execute()
    )


def seed_profile() -> list[ContextItem]:
    """Insert the demo profile once, without overwriting an existing vault."""
    client = _client()
    existing = client.table("context_items").select("id").limit(1).execute()
    if existing.data:
        return []

    payload = [item.model_dump(exclude_none=True, exclude={"id"}) for item in SEED_PROFILE]
    response = client.table("context_items").insert(payload).execute()
    return [_to_context_item(row) for row in (response.data or [])]
