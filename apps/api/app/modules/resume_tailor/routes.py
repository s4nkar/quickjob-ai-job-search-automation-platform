"""Resume Tailor — session-based API.

/tailor creates a durable TailoringSession (Postgres) instead of stashing
state behind a bare resume_text:{user_id} Redis key — that legacy key let two
concurrent tailoring flows (two tabs, or a second upload before the first
editor visit) silently cross-contaminate. Every downstream endpoint
(editor/preview/pdf) now addresses a specific {session_id} instead of
guessing which resume/analysis "the current user" meant.

Endpoints:
    POST  /tailor                        — analyze resume+JD, create/reuse a session
    GET   /tailor/{id}                   — re-fetch an existing session's analysis
    GET   /tailor/{id}/editor            — base_cv_data + tailoring overlay + templates
    PATCH /tailor/{id}/draft             — debounced autosave of in-progress editor edits
    PATCH /tailor/{id}/title             — rename the session (e.g. "Primary Resume")
    POST  /tailor/{id}/preview           — render HTML for live preview (one template)
    POST  /tailor/{id}/preview/thumbnails — render HTML for every template at once (template-switcher rail)
    POST  /tailor/{id}/pdf               — render + return the final PDF
    GET   /tailor/templates              — template registry metadata
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging

import fitz  # PyMuPDF
import numpy as np
from fastapi import APIRouter, Depends, Request, HTTPException, UploadFile, File, Form
from fastapi.responses import Response, HTMLResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.security import get_current_user_id
from app.services.cache import check_rate_limit, check_burst_limit, get_cached, set_cached
from app.shared.utils import _rl_error
from app.modules.usage.service import record_event as record_tool_usage
from app.modules.resume_tailor import cache as resume_cache
from app.modules.resume_tailor import generation
from app.modules.resume_tailor import rendering
from app.modules.resume_tailor import service as resume_tailor_service
from app.modules.resume_tailor.chunker import chunk_jd, chunk_resume, chunks_from_dicts, chunks_to_dicts, clean_jd_text, Chunk
from app.modules.resume_tailor.matcher import match_resume_to_jd
from app.modules.resume_tailor.models import ResumeVersion, TailoringSession
from app.modules.resume_tailor.repository import ResumeVersionRepository, TailoringSessionRepository
from app.modules.resume_tailor.schemas import (
    DraftSaveRequest,
    EditorResponse,
    PdfRequest,
    PreviewRequest,
    TailorResponse,
    TemplateListResponse,
    ThumbnailsRequest,
    ThumbnailsResponse,
    TitleUpdateRequest,
)
from app.ai.embeddings import EmbeddingError, embed
from app.ai.llm.provider import AIGenerationError

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_PDF_BYTES = 5 * 1024 * 1024  # 5 MB
# Generous upper bound for a pasted JD (including any tracker-appended role
# signals) — well past any legitimate posting, bounds worst-case prompt size
# and DB row size. Mirrored by a DB CHECK constraint on tailoring_sessions.job_text.
_MAX_JD_LENGTH = 20_000


def _empty_array() -> np.ndarray:
    return np.zeros((0, 0), dtype="float32")


def _embeddings_model_label() -> str:
    """Config-time embedding model identity, stored on resume_versions to
    detect staleness on a provider/model config change."""
    provider = settings.embedding_provider.lower().strip()
    if provider == "jina":
        return f"jina:{settings.jina_model}"
    if provider == "cohere":
        return f"cohere:{settings.cohere_embedding_model}"
    return provider


# ── Response shaping ────────────────────────────────────────────────

def _analysis_payload(analysis: dict) -> dict:
    return {
        "match_score": analysis.get("overall_score", 0),
        "matched_keywords": analysis.get("matched_keywords", []),
        "missing_keywords": [
            {"keyword": kw, "suggested_placement": "skills"} for kw in analysis.get("missing_keywords", [])
        ],
        "score_breakdown": analysis.get("score_breakdown", {}),
        "transferable_strengths": analysis.get("transferable_strengths", []),
        "critical_missing": analysis.get("critical_missing", []),
        "matches": analysis.get("matches", []),
        "degraded": analysis.get("degraded", False),
    }


def _tailoring_payload(prose: dict | None) -> dict | None:
    if not prose:
        return None
    return {
        "target_role": prose.get("target_role", ""),
        "target_company": prose.get("target_company", ""),
        "profile_headline": prose.get("profile_headline", ""),
        "tailored_summary": prose.get("tailored_summary", ""),
        "bullet_rewrites": prose.get("bullet_rewrites", []),
        "summary": prose.get("summary", ""),
        "validation_flags": prose.get("validation_flags", []),
    }


def _session_response(session: TailoringSession) -> dict:
    return {
        "session_id": str(session.id),
        "status": session.status,
        "analysis": _analysis_payload(session.analysis),
        "tailoring": _tailoring_payload(session.prose),
        "ai": {"status": session.ai_status, "provider": session.ai_provider},
    }


# ── Resume ingestion (Postgres source of truth, Redis accelerator) ──

async def _resolve_resume_version(
    db: AsyncSession, user_id: str, pdf_bytes: bytes, resume_hash: str,
) -> tuple[ResumeVersion, list[Chunk], np.ndarray]:
    """Redis hit -> skip Postgres. Miss -> read resume_versions, warm Redis.
    Absent from both -> extract/chunk/embed, INSERT, write Redis."""
    repo = ResumeVersionRepository(db)
    model_label = _embeddings_model_label()
    cached = await resume_cache.get_resume_cache(user_id, resume_hash)

    if cached and cached.get("text") and cached.get("chunks") and cached.get("embeddings"):
        resume_version = await repo.get_by_hash(user_id, resume_hash)
        if resume_version is None:
            # Redis has it but Postgres doesn't (e.g. cached before this
            # migration shipped) — backfill Postgres from the Redis blob.
            resume_version = await _create_resume_version(
                repo, user_id, resume_hash, cached["text"], cached["chunks"], cached["embeddings"], cached.get("embeddings_model"),
            )
        else:
            await repo.touch_last_used(user_id, str(resume_version.id))
        return resume_version, chunks_from_dicts(cached["chunks"]), resume_cache.deserialize_embeddings(cached["embeddings"])

    resume_version = await repo.get_by_hash(user_id, resume_hash)
    if resume_version is not None:
        resume_chunks = chunks_from_dicts(resume_version.chunks)
        resume_embeddings = resume_cache.deserialize_embeddings(resume_version.embeddings)

        if resume_version.embeddings_model != model_label or resume_embeddings.size == 0:
            # Stale or missing embeddings (provider/model config changed since
            # this row was written, or a prior embedding-provider outage left
            # it without any) — re-embed and persist.
            try:
                resume_embeddings = await embed([c.text for c in resume_chunks], purpose="matching")
                embeddings_model = model_label
            except EmbeddingError as exc:
                logger.warning("Resume embeddings unavailable: %r — falling back to keyword-only matching", exc)
                resume_embeddings = _empty_array()
                embeddings_model = None
            embeddings_list = resume_cache.serialize_embeddings(resume_embeddings) if resume_embeddings.size > 0 else []
            resume_version = await repo.update(
                user_id, str(resume_version.id), embeddings=embeddings_list, embeddings_model=embeddings_model,
            )
            await resume_cache.update_resume_cache(user_id, resume_hash, embeddings=embeddings_list, embeddings_model=embeddings_model)

        await repo.touch_last_used(user_id, str(resume_version.id))
        await resume_cache.update_resume_cache(
            user_id, resume_hash,
            text=resume_version.raw_text, chunks=resume_version.chunks,
            embeddings=resume_version.embeddings, embeddings_model=resume_version.embeddings_model,
        )
        return resume_version, resume_chunks, resume_embeddings

    # Absent from both — full extract/chunk/embed.
    def _extract_text() -> str:
        doc = fitz.open(stream=pdf_bytes, filetype="pdf")
        return "\n".join(page.get_text() for page in doc)

    try:
        resume_text = await asyncio.to_thread(_extract_text)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not parse PDF. Ensure it's a valid PDF file.")

    resume_chunks = chunk_resume(resume_text)
    embeddings_model = None
    try:
        resume_embeddings = await embed([c.text for c in resume_chunks], purpose="matching")
        embeddings_model = model_label
    except EmbeddingError as exc:
        logger.warning("Resume embeddings unavailable: %r — falling back to keyword-only matching", exc)
        resume_embeddings = _empty_array()

    chunk_dicts = chunks_to_dicts(resume_chunks)
    embeddings_list = resume_cache.serialize_embeddings(resume_embeddings) if resume_embeddings.size > 0 else []

    resume_version = await _create_resume_version(
        repo, user_id, resume_hash, resume_text, chunk_dicts, embeddings_list, embeddings_model,
    )
    await resume_cache.update_resume_cache(
        user_id, resume_hash, text=resume_text, chunks=chunk_dicts, embeddings=embeddings_list, embeddings_model=embeddings_model,
    )
    return resume_version, resume_chunks, resume_embeddings


async def _create_resume_version(
    repo: ResumeVersionRepository, user_id: str, resume_hash: str,
    raw_text: str, chunks: list[dict], embeddings: list[list[float]], embeddings_model: str | None,
) -> ResumeVersion:
    """Insert, tolerating the rare race where two concurrent first-ever
    uploads of the identical PDF both reach this point — the UniqueConstraint
    on (user_id, sha256) rejects the loser, which then just reads the
    winner's row instead. Uses a SAVEPOINT so the conflict doesn't poison the
    request's outer transaction (same pattern as usage/service.py)."""
    try:
        async with repo.session.begin_nested():
            return await repo.create_from_upload(user_id, resume_hash, raw_text, chunks, embeddings, embeddings_model)
    except IntegrityError:
        existing = await repo.get_by_hash(user_id, resume_hash)
        if existing is None:
            raise
        return existing


# ── POST /tailor ──────────────────────────────────────────────────

@router.post("/tailor", response_model=TailorResponse)
async def tailor_resume(
    request: Request,
    resume: UploadFile = File(...),
    job_description: str = Form(..., min_length=1, max_length=_MAX_JD_LENGTH),
    force_refresh: bool = Form(False),
    opportunity_id: str | None = Form(None),
    job_search_application_id: str | None = Form(None),
    db: AsyncSession = Depends(get_db),
):
    user_id = await get_current_user_id(request, db)
    allowed, _ = await check_rate_limit(user_id, "resume_tailor_ai", settings.rate_limit_resume_ai_per_day)
    if not allowed:
        raise _rl_error("Resume Tailor", settings.rate_limit_resume_ai_per_day)
    await record_tool_usage(db, user_id, "resume-tailor")

    pdf_bytes = await resume.read(_MAX_PDF_BYTES + 1)
    if len(pdf_bytes) > _MAX_PDF_BYTES:
        raise HTTPException(status_code=413, detail="PDF must be ≤ 5 MB")
    resume_hash = resume_cache.compute_resume_hash(pdf_bytes)

    resume_version, resume_chunks, resume_embeddings = await _resolve_resume_version(db, user_id, pdf_bytes, resume_hash)

    jd_for_processing = await generation.translate_jd_if_needed(job_description)
    jd_text_clean = clean_jd_text(jd_for_processing)
    jd_chunks = chunk_jd(jd_text_clean)
    try:
        jd_embeddings = await embed([c.text for c in jd_chunks], purpose="matching") if jd_chunks else _empty_array()
    except EmbeddingError as exc:
        logger.warning("JD embeddings unavailable: %r — falling back to keyword-only matching", exc)
        jd_embeddings = _empty_array()

    job_hash = hashlib.sha256(job_description.strip().encode("utf-8")).hexdigest()

    session_repo = TailoringSessionRepository(db)
    session = None
    if not force_refresh:
        session = await session_repo.get_or_create_session(
            user_id, str(resume_version.id), job_hash,
            matcher_version=generation.MATCHER_VERSION, prompt_version=generation.PROSE_PROMPT_VERSION,
        )

    if session is None:
        analysis = match_resume_to_jd(
            resume_chunks=resume_chunks, resume_embeddings=resume_embeddings,
            jd_chunks=jd_chunks, jd_embeddings=jd_embeddings,
            resume_text=resume_version.raw_text, jd_text=jd_text_clean,
        )
        prose = await generation.generate_tailor_prose(
            user_id, resume_hash, job_hash, resume_version.raw_text, resume_chunks, jd_for_processing, analysis,
        )

        source_opportunity_id = None
        if opportunity_id and await resume_tailor_service.verify_opportunity_ownership(db, user_id, opportunity_id):
            source_opportunity_id = opportunity_id
        source_application_id = None
        if job_search_application_id and await resume_tailor_service.verify_application_ownership(db, user_id, job_search_application_id):
            source_application_id = job_search_application_id

        session = await session_repo.create_session(
            user_id, str(resume_version.id),
            job_hash=job_hash,
            job_text=job_description,
            job_text_clean=jd_text_clean,
            job_chunks=chunks_to_dicts(jd_chunks),
            job_embeddings=resume_cache.serialize_embeddings(jd_embeddings) if jd_embeddings.size > 0 else [],
            analysis=analysis.as_dict(),
            prose=prose.as_dict() if prose.ai_status == "ok" else None,
            matcher_version=generation.MATCHER_VERSION,
            prompt_version=generation.PROSE_PROMPT_VERSION,
            ai_status=prose.ai_status,
            ai_provider=prose.ai_provider,
            ai_error=prose.ai_error,
            source_opportunity_id=source_opportunity_id,
            source_application_id=source_application_id,
        )

    return _session_response(session)


# ── GET /tailor/{session_id} ──────────────────────────────────────

@router.get("/tailor/{session_id}", response_model=TailorResponse)
async def get_tailor_session(session_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    user_id = await get_current_user_id(request, db)
    session = await TailoringSessionRepository(db).get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")
    return _session_response(session)


# ── GET /tailor/{session_id}/editor ───────────────────────────────

@router.get("/tailor/{session_id}/editor", response_model=EditorResponse)
async def get_tailor_editor(session_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Returns the saved draft if one exists (re-opening the editor resumes
    exactly where the user left off, at zero AI cost — no LLM call, no rate
    limit), otherwise computes the base_cv_data + tailoring overlay fresh."""
    user_id = await get_current_user_id(request, db)

    session = await TailoringSessionRepository(db).get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    if session.draft_cv_data:
        return {
            "cv_data": session.draft_cv_data,
            "session_id": str(session.id),
            "template_id": session.template_id or "standard",
            "templates": rendering.list_templates(),
            "is_draft": True,
            "title": session.title,
        }

    resume_repo = ResumeVersionRepository(db)
    resume_version = await resume_repo.get(user_id, str(session.resume_version_id))
    if resume_version is None:
        raise HTTPException(status_code=404, detail="Resume not found.")

    if resume_version.base_cv_data and resume_version.base_cv_data_prompt_version == generation.STRUCT_PROMPT_VERSION:
        base_cv_data = resume_version.base_cv_data
    else:
        # Only the actual structuring LLM call counts against the AI quota —
        # a cache/draft hit above is a plain read and shouldn't cost part of
        # the daily budget.
        allowed, _ = await check_rate_limit(user_id, "resume_tailor_ai", settings.rate_limit_resume_ai_per_day)
        if not allowed:
            raise _rl_error("Resume Tailor", settings.rate_limit_resume_ai_per_day)
        try:
            base_cv_data = await generation.generate_base_cv_data(resume_version.raw_text)
        except (ValueError, AIGenerationError) as exc:
            raise HTTPException(status_code=500, detail="Failed to structure resume. Please try again.") from exc
        rendering.normalize_cv_data(base_cv_data)
        await resume_repo.set_base_cv_data(user_id, str(resume_version.id), base_cv_data, generation.STRUCT_PROMPT_VERSION)
        await resume_cache.update_resume_cache(
            user_id, resume_version.sha256,
            base_cv_data=base_cv_data, base_cv_data_prompt_version=generation.STRUCT_PROMPT_VERSION,
        )

    prose = generation.TailorProseResult(**session.prose) if session.prose else generation.TailorProseResult(ai_status=session.ai_status)
    cv_data = rendering.apply_tailoring_overlay(base_cv_data, prose)

    profile = await resume_tailor_service.get_profile_for_overlay(db, user_id)
    template_id = session.template_id or "standard"
    await rendering.apply_profile_overlay(cv_data, profile, prose.profile_headline, template_id)

    return {
        "cv_data": cv_data,
        "session_id": str(session.id),
        "template_id": template_id,
        "templates": rendering.list_templates(),
        "is_draft": False,
        "title": session.title,
    }


# ── PATCH /tailor/{session_id}/draft ──────────────────────────────

@router.patch("/tailor/{session_id}/draft")
async def save_tailor_draft(session_id: str, request: Request, body: DraftSaveRequest, db: AsyncSession = Depends(get_db)):
    """Debounced autosave of in-progress editor edits — burst-limited only
    (cheap DB write, no LLM, no PDF conversion). Uses its own bucket name
    (not "resume_tailor_preview") so autosave and live-preview firing close
    together on every edit don't cannibalize each other's burst budget."""
    user_id = await get_current_user_id(request, db)

    session_repo = TailoringSessionRepository(db)
    session = await session_repo.get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    try:
        burst_ok = await check_burst_limit(
            user_id, "resume_tailor_draft", settings.rate_limit_burst_limit, settings.rate_limit_burst_window_seconds,
        )
    except Exception:
        burst_ok = True
    if not burst_ok:
        raise HTTPException(status_code=429, detail="Too many save requests — please wait a few seconds and try again.")

    await session_repo.save_draft(user_id, session_id, body.cv_data)
    return {"saved": True}


# ── PATCH /tailor/{session_id}/title ──────────────────────────────

@router.patch("/tailor/{session_id}/title")
async def rename_tailor_session(session_id: str, request: Request, body: TitleUpdateRequest, db: AsyncSession = Depends(get_db)):
    """User-chosen label for this session (e.g. "Primary Resume", "Google SWE
    v2") — lets one resume have many named tailoring sessions without them
    blurring together. Renaming is rare (not a per-keystroke autosave like
    /draft), so it gets its own light burst budget rather than sharing one."""
    user_id = await get_current_user_id(request, db)

    session_repo = TailoringSessionRepository(db)
    session = await session_repo.get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    try:
        burst_ok = await check_burst_limit(
            user_id, "resume_tailor_title", settings.rate_limit_burst_limit, settings.rate_limit_burst_window_seconds,
        )
    except Exception:
        burst_ok = True
    if not burst_ok:
        raise HTTPException(status_code=429, detail="Too many rename requests — please wait a few seconds and try again.")

    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="Title cannot be empty.")

    await session_repo.set_title(user_id, session_id, title)
    return {"title": title}


# ── POST /tailor/{session_id}/preview ─────────────────────────────

async def _render_cv_template(template_id: str, cv_data: dict, user_id: str, db: AsyncSession) -> str:
    """Shared by /preview and /preview/thumbnails. Callers must already have
    run rendering.normalize_cv_data on cv_data — that step is template-
    independent, so the batch endpoint runs it once rather than once per
    template."""
    data = dict(cv_data)
    if template_id == "lebenslauf":
        lebenslauf_cache_key = f"lebenslauf_profile:{user_id}"
        cached_profile = await get_cached(lebenslauf_cache_key)
        if cached_profile:
            lp = json.loads(cached_profile)
        else:
            profile = await resume_tailor_service.get_profile_photo_fields(db, user_id)
            lp = await rendering.fetch_lebenslauf_photo_fields(profile)
            await set_cached(lebenslauf_cache_key, json.dumps(lp), ttl_seconds=3600)
        data.update(lp)
    else:
        data.setdefault("photo_base64", None)
        data.setdefault("date_of_birth", None)
        data.setdefault("nationality", None)
    return rendering.render_html(template_id, data)


@router.post("/tailor/{session_id}/preview")
async def preview_tailor_html(session_id: str, request: Request, body: PreviewRequest, db: AsyncSession = Depends(get_db)):
    """Render CV template to HTML for live preview — burst-limited only (cheap
    Jinja-only render, no LLM, no PDF conversion)."""
    user_id = await get_current_user_id(request, db)

    session = await TailoringSessionRepository(db).get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    try:
        burst_ok = await check_burst_limit(
            user_id, "resume_tailor_preview", settings.rate_limit_burst_limit, settings.rate_limit_burst_window_seconds,
        )
    except Exception:
        burst_ok = True
    if not burst_ok:
        raise HTTPException(status_code=429, detail="Too many preview requests — please wait a few seconds and try again.")

    if body.template_id not in rendering.TEMPLATE_REGISTRY:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown template_id '{body.template_id}'. Valid: {', '.join(rendering.TEMPLATE_REGISTRY)}",
        )

    cv_data = dict(body.cv_data)
    rendering.normalize_cv_data(cv_data)
    html_out = await _render_cv_template(body.template_id, cv_data, user_id, db)
    return HTMLResponse(content=html_out)


# ── POST /tailor/{session_id}/preview/thumbnails ────────────────────

@router.post("/tailor/{session_id}/preview/thumbnails", response_model=ThumbnailsResponse)
async def preview_tailor_thumbnails(session_id: str, request: Request, body: ThumbnailsRequest, db: AsyncSession = Depends(get_db)):
    """Render every registered template against the same cv_data in ONE call —
    powers the editor's template-switcher rail, which shows a live thumbnail
    per template using the user's actual resume content instead of a generic
    placeholder. Deliberately batched server-side rather than having the
    frontend fire one /preview request per template: that would be 17 calls
    per debounce tick against a burst limit of 3/10s (rate_limit_burst_limit),
    and would fail almost immediately."""
    user_id = await get_current_user_id(request, db)

    session = await TailoringSessionRepository(db).get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    try:
        burst_ok = await check_burst_limit(
            user_id, "resume_tailor_thumbnails", settings.rate_limit_burst_limit, settings.rate_limit_burst_window_seconds,
        )
    except Exception:
        burst_ok = True
    if not burst_ok:
        raise HTTPException(status_code=429, detail="Too many thumbnail requests — please wait a few seconds and try again.")

    cv_data = dict(body.cv_data)
    rendering.normalize_cv_data(cv_data)

    thumbnails: dict[str, str] = {}
    for template_id in rendering.TEMPLATE_REGISTRY:
        thumbnails[template_id] = await _render_cv_template(template_id, cv_data, user_id, db)

    return ThumbnailsResponse(thumbnails=thumbnails)


# ── POST /tailor/{session_id}/pdf ─────────────────────────────────

@router.post("/tailor/{session_id}/pdf")
async def generate_tailor_pdf(session_id: str, request: Request, body: PdfRequest, db: AsyncSession = Depends(get_db)):
    user_id = await get_current_user_id(request, db)
    allowed, _ = await check_rate_limit(user_id, "resume_tailor_pdf", settings.rate_limit_resume_pdf_per_day)
    if not allowed:
        raise _rl_error("Resume Tailor PDF", settings.rate_limit_resume_pdf_per_day)

    session_repo = TailoringSessionRepository(db)
    session = await session_repo.get(user_id, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found.")

    if body.template_id not in rendering.TEMPLATE_REGISTRY:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown template_id '{body.template_id}'. Valid: {', '.join(rendering.TEMPLATE_REGISTRY)}",
        )

    cv_data = dict(body.cv_data)
    rendering.normalize_cv_data(cv_data)

    if body.template_id == "lebenslauf":
        profile = await resume_tailor_service.get_profile_photo_fields(db, user_id)
        cv_data.update(await rendering.fetch_lebenslauf_photo_fields(profile))
    else:
        cv_data.setdefault("photo_base64", None)
        cv_data.setdefault("date_of_birth", None)
        cv_data.setdefault("nationality", None)

    logger.info("CV render: template=%s name=%s", body.template_id, cv_data.get("full_name"))
    pdf_bytes = await rendering.render_pdf(body.template_id, cv_data)

    await session_repo.set_template(user_id, session_id, body.template_id)

    if body.opportunity_id:
        await resume_tailor_service.save_resume_artifact(
            db, user_id, body.opportunity_id, body.template_id, session.analysis.get("overall_score"),
        )

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="tailored_cv_{body.template_id}.pdf"'},
    )


# ── GET /tailor/templates ─────────────────────────────────────────

@router.get("/tailor/templates", response_model=TemplateListResponse)
async def list_tailor_templates():
    return {"templates": rendering.list_templates()}
