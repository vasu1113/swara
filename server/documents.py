"""Sarvam OCR ingestion and document-context extraction."""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, HTTPException, UploadFile

from config import require
from context_store import add_context
from schemas import ContextItem


router = APIRouter(prefix="/documents", tags=["documents"])

ALLOWED_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".zip"}
MAX_DOCUMENT_BYTES = 20 * 1024 * 1024
OCR_CHUNK_SIZE = 3_000


def _supabase_client() -> Any:
    try:
        from supabase import create_client
    except ImportError as exc:
        raise RuntimeError("Supabase SDK is unavailable. Install server/requirements.txt.") from exc
    return create_client(require("SUPABASE_URL"), require("SUPABASE_SERVICE_KEY"))


def _serialise_response(response: Any) -> dict[str, Any]:
    if hasattr(response, "model_dump"):
        data = response.model_dump(mode="json")
    elif hasattr(response, "dict"):
        data = response.dict()
    elif isinstance(response, dict):
        data = response
    else:
        data = {"raw": str(response)}
    # Normalise SDK-specific objects to JSON-safe values before JSONB insertion.
    return json.loads(json.dumps(data, default=str))


def _ocr_blocks(response: Any) -> list[tuple[str, str]]:
    blocks: list[tuple[str, str]] = []
    for page in getattr(response, "pages", []) or []:
        for block in getattr(page, "blocks", []) or []:
            text = str(getattr(block, "text", "") or "").strip()
            if text:
                blocks.append((str(getattr(block, "layout_tag", "text") or "text"), text))
    return blocks


def _chunk_blocks(blocks: list[tuple[str, str]]) -> list[str]:
    """Group OCR blocks into logical, bounded Markdown context entries."""
    chunks: list[str] = []
    current: list[str] = []
    current_length = 0

    def flush() -> None:
        nonlocal current, current_length
        if current:
            chunks.append("\n\n".join(current))
        current = []
        current_length = 0

    for layout_tag, text in blocks:
        is_heading = "heading" in layout_tag.lower() or "title" in layout_tag.lower()
        block_markdown = f"<!-- {layout_tag} -->\n{text}"
        if current and (is_heading or current_length + len(block_markdown) > OCR_CHUNK_SIZE):
            flush()

        # A very large OCR block is split by paragraphs, rather than becoming a
        # single unusable vault row.
        paragraphs = [part.strip() for part in text.split("\n\n") if part.strip()] or [text]
        for paragraph in paragraphs:
            paragraph_markdown = f"<!-- {layout_tag} -->\n{paragraph}"
            if current and current_length + len(paragraph_markdown) > OCR_CHUNK_SIZE:
                flush()
            if len(paragraph_markdown) > OCR_CHUNK_SIZE:
                for start in range(0, len(paragraph_markdown), OCR_CHUNK_SIZE):
                    if current:
                        flush()
                    chunks.append(paragraph_markdown[start : start + OCR_CHUNK_SIZE])
            else:
                current.append(paragraph_markdown)
                current_length += len(paragraph_markdown) + 2
    flush()
    return chunks


def _set_document_status(client: Any, document_id: str, status: str, **values: Any) -> None:
    client.table("documents").update({"status": status, **values}).eq("id", document_id).execute()


@router.post("/upload")
async def upload_document(file: UploadFile) -> dict[str, Any]:
    """Upload a document, OCR it with Sarvam, and make its text searchable context."""
    filename = Path(file.filename or "").name
    suffix = Path(filename).suffix.lower()
    if not filename or suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=400, detail="Only PDF, PNG, JPEG, and ZIP documents are supported.")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="The uploaded document is empty.")
    if len(content) > MAX_DOCUMENT_BYTES:
        raise HTTPException(status_code=413, detail="Documents must be 20 MB or smaller.")

    client = _supabase_client()
    storage_path = f"{uuid4()}/{filename}"
    try:
        client.storage.from_("documents").upload(
            path=storage_path,
            file=content,
            file_options={"content-type": file.content_type or "application/octet-stream"},
        )
        document_response = (
            client.table("documents")
            .insert({"filename": filename, "storage_path": storage_path, "status": "pending"})
            .execute()
        )
        if not document_response.data:
            raise RuntimeError("Supabase did not return the created document row.")
        document_id = str(document_response.data[0]["id"])
    except RuntimeError:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Could not store document: {exc}") from exc

    temporary_path = ""
    try:
        try:
            from sarvamai import SarvamAI
        except ImportError as exc:
            raise RuntimeError("Sarvam SDK is unavailable. Install server/requirements.txt.") from exc

        with NamedTemporaryFile(suffix=suffix, delete=False) as temporary_file:
            temporary_file.write(content)
            temporary_path = temporary_file.name

        _set_document_status(client, document_id, "processing")
        sarvam = SarvamAI(api_subscription_key=require("SARVAM_API_KEY"))
        ocr_response = sarvam.document_digitization.digitize(
            file_path=temporary_path,
            language="en-IN",
            output_format="md",
        )
        raw_output = _serialise_response(ocr_response)
        # Preserve Sarvam's raw result even if a later context-row insertion
        # fails, so the document can be diagnosed or reprocessed.
        _set_document_status(client, document_id, "processing", ocr_output=raw_output, error=None)
        chunks = _chunk_blocks(_ocr_blocks(ocr_response))
        inserted_context = [
            add_context(
                ContextItem(
                    type="document",
                    category="document",
                    key=f"document:{document_id}:section:{index}",
                    value=chunk,
                    source=filename,
                    source_type="document",
                    scope="persistent",
                    document_id=document_id,
                )
            )
            for index, chunk in enumerate(chunks, start=1)
        ]
        _set_document_status(client, document_id, "done", error=None)
        return {
            "id": document_id,
            "filename": filename,
            "status": "done",
            "contextItemsCreated": len(inserted_context),
        }
    except RuntimeError as exc:
        # A missing key is a configuration issue and should remain explicit, but
        # the persisted document must not remain stuck in pending/processing.
        try:
            _set_document_status(client, document_id, "failed", error=str(exc)[:2_000])
        except Exception:
            pass
        raise
    except Exception as exc:
        try:
            _set_document_status(client, document_id, "failed", error=str(exc)[:2_000])
        except Exception:
            pass
        raise HTTPException(status_code=502, detail=f"Document OCR failed: {exc}") from exc
    finally:
        if temporary_path:
            try:
                os.unlink(temporary_path)
            except FileNotFoundError:
                pass
        await file.close()
