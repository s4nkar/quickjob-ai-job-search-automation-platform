"""Postgres persistence for resume-tailor sessions.

Two tables:
    resume_versions    — one row per (user, uploaded PDF content hash). Dedups
                         parsing/chunking/embedding/structuring cost across
                         every JD the same resume gets tailored against.
    tailoring_sessions — one row per (resume_version, JD) tailoring run. The
                         durable identity behind a `session_id` the frontend
                         holds in the URL, replacing the old bare
                         `resume_text:{user_id}` Redis handoff that could not
                         tell two concurrent tailoring flows apart.

Redis (see cache.py) remains a read-through accelerator in front of these
tables, not the source of truth.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, TIMESTAMP, UUID as PG_UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.shared.models import Base, UUIDPKMixin, CreatedAtMixin


class ResumeVersion(Base, UUIDPKMixin, CreatedAtMixin):
    __tablename__ = "resume_versions"
    __table_args__ = (
        UniqueConstraint("user_id", "sha256", name="resume_versions_user_id_sha256_key"),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    sha256: Mapped[str] = mapped_column(nullable=False)
    raw_text: Mapped[str] = mapped_column(nullable=False)
    chunks: Mapped[list] = mapped_column(JSONB, server_default="[]", nullable=False)
    embeddings: Mapped[list] = mapped_column(JSONB, server_default="[]", nullable=False)
    embeddings_model: Mapped[str | None] = mapped_column(nullable=True)
    # NULL = not yet structured into cv_data. Populated lazily on first editor visit.
    base_cv_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    base_cv_data_prompt_version: Mapped[str | None] = mapped_column(nullable=True)
    # Bumped explicitly by the repository on every reuse — not trigger-managed,
    # every write to this column goes through one narrow, single-purpose call.
    last_used_at: Mapped[datetime] = mapped_column(
        TIMESTAMP(timezone=True), server_default=func.now(), nullable=False
    )


class TailoringSession(Base, UUIDPKMixin, CreatedAtMixin):
    __tablename__ = "tailoring_sessions"
    __table_args__ = (
        CheckConstraint("status in ('ready', 'failed')", name="tailoring_sessions_status_check"),
        CheckConstraint("ai_status in ('ok', 'degraded')", name="tailoring_sessions_ai_status_check"),
        # Defense in depth alongside the Form(..., max_length=...) boundary
        # check in routes.py — belt-and-suspenders per this codebase's input
        # length convention, in case a future code path ever writes this
        # column without going through that endpoint.
        CheckConstraint("char_length(job_text) <= 20000", name="tailoring_sessions_job_text_length_check"),
        CheckConstraint("title is null or char_length(title) <= 200", name="tailoring_sessions_title_length_check"),
        Index(
            "tailoring_sessions_user_resume_job_idx",
            "user_id", "resume_version_id", "job_hash",
        ),
    )

    user_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    resume_version_id: Mapped[uuid.UUID] = mapped_column(
        PG_UUID(as_uuid=True), ForeignKey("resume_versions.id", ondelete="CASCADE"), nullable=False
    )
    job_hash: Mapped[str] = mapped_column(nullable=False)
    job_text: Mapped[str] = mapped_column(nullable=False)
    job_text_clean: Mapped[str] = mapped_column(nullable=False)
    job_chunks: Mapped[list] = mapped_column(JSONB, server_default="[]", nullable=False)
    job_embeddings: Mapped[list] = mapped_column(JSONB, server_default="[]", nullable=False)
    # Deterministic MatchResult.as_dict() — authoritative, never LLM-touched.
    analysis: Mapped[dict] = mapped_column(JSONB, server_default="{}", nullable=False)
    # AI-generated fields. NULL when generation fully failed (ai_status='degraded').
    prose: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    matcher_version: Mapped[str] = mapped_column(nullable=False)
    prompt_version: Mapped[str] = mapped_column(nullable=False)
    status: Mapped[str] = mapped_column(server_default="ready", nullable=False)
    ai_status: Mapped[str] = mapped_column(server_default="ok", nullable=False)
    ai_provider: Mapped[str | None] = mapped_column(nullable=True)
    ai_error: Mapped[str | None] = mapped_column(nullable=True)
    # Last template picked in the editor. Validated against rendering.TEMPLATE_REGISTRY
    # at the route layer, not a DB check — avoids a migration per template add/remove.
    template_id: Mapped[str | None] = mapped_column(nullable=True)
    # User-chosen label for this session (e.g. "Primary Resume", "Google SWE
    # v2") — lets one resume have many named tailoring sessions without them
    # blurring together. NULL until the user renames it; the editor UI falls
    # back to a generic display label in that case rather than storing one.
    title: Mapped[str | None] = mapped_column(nullable=True)
    # User's in-progress editor edits, autosaved (debounced) from the editor
    # form. NULL until the user's first edit — GET /editor prefers this over
    # the freshly-computed base+tailoring overlay once it exists, so
    # re-opening the editor resumes from where the user left off rather than
    # the original AI-generated starting point.
    draft_cv_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    # Linkage, not ownership — records where a session came from so a future
    # tracker feature can find past sessions for a job without a retrofit
    # migration. ON DELETE SET NULL (not CASCADE): a resume analysis is still
    # worth keeping if the user later deletes the application/opportunity it
    # was built for.
    source_opportunity_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("startup_hunt_opportunities.id", ondelete="SET NULL"),
        nullable=True,
    )
    source_application_id: Mapped[uuid.UUID | None] = mapped_column(
        PG_UUID(as_uuid=True),
        ForeignKey("job_search_applications.id", ondelete="SET NULL"),
        nullable=True,
    )
