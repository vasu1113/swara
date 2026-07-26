"""Sarvam OCR ingestion and document-context extraction."""

from __future__ import annotations

import io
import json
import time
import urllib.request
import zipfile
from pathlib import Path
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
OCR_LANGUAGE = "en-IN"
OCR_POLL_SECONDS = 3
OCR_TIMEOUT_SECONDS = 180
# States Sarvam reports while the job is still in flight.
OCR_PENDING_STATES = {"Accepted", "Pending", "Running"}


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


def _run_sarvam_ocr(content: bytes, filename: str) -> tuple[dict[str, Any], str]:
    """Digitise a document with Sarvam and return (job metadata, markdown).

    Sarvam's Document Intelligence is an asynchronous job, not a single call:
    initialise, fetch a presigned upload URL, PUT the bytes to Azure blob
    storage, start the job, poll until it leaves a running state, then download
    a zip of the outputs. The markdown lives in `document.md` inside that zip.
    """
    try:
        from sarvamai import SarvamAI
    except ImportError as exc:
        raise RuntimeError("Sarvam SDK is unavailable. Install server/requirements.txt.") from exc

    client = SarvamAI(api_subscription_key=require("SARVAM_API_KEY"))
    intelligence = client.document_intelligence

    job = intelligence.initialise(
        job_parameters={"language": OCR_LANGUAGE, "output_format": "md"}
    )
    job_id = job.job_id

    # Sarvam keys the upload map by the name we hand it, so keep it simple and
    # predictable rather than passing through a user-supplied filename.
    upload_name = f"document{Path(filename).suffix.lower() or '.pdf'}"
    links = intelligence.get_upload_links(job_id=job_id, files=[upload_name])
    upload_url = links.upload_urls[upload_name].file_url

    # Azure block blobs reject a PUT without this header.
    request = urllib.request.Request(
        upload_url,
        data=content,
        method="PUT",
        headers={"x-ms-blob-type": "BlockBlob"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        if response.status not in (200, 201):
            raise RuntimeError(f"Upload to Sarvam storage failed with status {response.status}.")

    intelligence.start(job_id)

    deadline = time.monotonic() + OCR_TIMEOUT_SECONDS
    while True:
        status = intelligence.get_status(job_id)
        if status.job_state not in OCR_PENDING_STATES:
            break
        if time.monotonic() > deadline:
            raise RuntimeError(
                f"Sarvam OCR did not finish within {OCR_TIMEOUT_SECONDS}s (state: {status.job_state})."
            )
        time.sleep(OCR_POLL_SECONDS)

    if status.job_state != "Completed":
        detail = getattr(status, "error_message", None) or status.job_state
        raise RuntimeError(f"Sarvam OCR failed: {detail}")

    downloads = intelligence.get_download_links(job_id)
    if not downloads.download_urls:
        raise RuntimeError("Sarvam returned no output files.")

    archive_url = next(iter(downloads.download_urls.values())).file_url
    with urllib.request.urlopen(archive_url, timeout=120) as response:
        archive_bytes = response.read()

    markdown = ""
    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
        names = archive.namelist()
        for name in names:
            if name.lower().endswith(".md"):
                markdown = archive.read(name).decode("utf-8", "replace")
                break

    if not markdown.strip():
        raise RuntimeError("Sarvam produced no readable text for this document.")

    return _serialise_response(downloads), markdown


def _markdown_sections(markdown: str) -> list[tuple[str, str]]:
    """Split OCR markdown into (heading, body) sections.

    Resumes and forms are heading-structured, so sections map cleanly onto
    retrievable vault rows: "WORK EXPERIENCE", "EDUCATION", and so on.
    """
    sections: list[tuple[str, str]] = []
    heading = "Document"
    body: list[str] = []

    for line in markdown.splitlines():
        if line.lstrip().startswith("#"):
            if any(part.strip() for part in body):
                sections.append((heading, "\n".join(body).strip()))
            heading = line.lstrip("#").strip() or "Document"
            body = []
        else:
            body.append(line)

    if any(part.strip() for part in body):
        sections.append((heading, "\n".join(body).strip()))

    return [(name, text) for name, text in sections if text]


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

    try:
        _set_document_status(client, document_id, "processing")
        job_metadata, markdown = _run_sarvam_ocr(content, filename)

        # Keep the job metadata and the full extracted text, so a document can
        # be re-chunked later without paying for OCR again.
        raw_output = {**job_metadata, "markdown": markdown}
        _set_document_status(client, document_id, "processing", ocr_output=raw_output, error=None)

        sections = _markdown_sections(markdown)
        inserted_context = [
            add_context(
                ContextItem(
                    type="document",
                    category=heading.lower(),
                    key=f"document:{document_id}:{heading.lower().replace(' ', '_')}",
                    value=body[:OCR_CHUNK_SIZE],
                    source=filename,
                    source_type="document",
                    scope="persistent",
                    document_id=document_id,
                )
            )
            for heading, body in sections
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
        await file.close()
