"""Repository layer for resume_tailor's Postgres tables.

Subclasses the generic UserScopedRepository for the base CRUD surface, with
hand-written queries alongside for hash/lookup access the generic base
doesn't cover — same mixing pattern already used by job_search/bulk_email/
startup_hunt's service.py files.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select

from app.shared.repository import UserScopedRepository
from app.modules.resume_tailor.models import ResumeVersion, TailoringSession


class ResumeVersionRepository(UserScopedRepository[ResumeVersion]):
    model = ResumeVersion

    async def get_by_hash(self, user_id: str, sha256: str) -> ResumeVersion | None:
        stmt = self._scoped(select(self.model), user_id).where(self.model.sha256 == sha256)
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def create_from_upload(
        self,
        user_id: str,
        sha256: str,
        raw_text: str,
        chunks: list[dict],
        embeddings: list[list[float]],
        embeddings_model: str | None,
    ) -> ResumeVersion:
        return await self.create(
            user_id,
            sha256=sha256,
            raw_text=raw_text,
            chunks=chunks,
            embeddings=embeddings,
            embeddings_model=embeddings_model,
        )

    async def set_base_cv_data(
        self, user_id: str, id_: str, base_cv_data: dict[str, Any], prompt_version: str,
    ) -> ResumeVersion | None:
        return await self.update(
            user_id, id_,
            base_cv_data=base_cv_data,
            base_cv_data_prompt_version=prompt_version,
        )

    async def touch_last_used(self, user_id: str, id_: str) -> None:
        await self.update(user_id, id_, last_used_at=datetime.now(timezone.utc))


class TailoringSessionRepository(UserScopedRepository[TailoringSession]):
    model = TailoringSession

    async def create_session(
        self,
        user_id: str,
        resume_version_id: str,
        *,
        job_hash: str,
        job_text: str,
        job_text_clean: str,
        job_chunks: list[dict],
        job_embeddings: list[list[float]],
        analysis: dict[str, Any],
        prose: dict[str, Any] | None,
        matcher_version: str,
        prompt_version: str,
        ai_status: str,
        ai_provider: str | None,
        ai_error: str | None,
        source_opportunity_id: str | None = None,
        source_application_id: str | None = None,
    ) -> TailoringSession:
        return await self.create(
            user_id,
            resume_version_id=resume_version_id,
            job_hash=job_hash,
            job_text=job_text,
            job_text_clean=job_text_clean,
            job_chunks=job_chunks,
            job_embeddings=job_embeddings,
            analysis=analysis,
            prose=prose,
            matcher_version=matcher_version,
            prompt_version=prompt_version,
            ai_status=ai_status,
            ai_provider=ai_provider,
            ai_error=ai_error,
            source_opportunity_id=source_opportunity_id,
            source_application_id=source_application_id,
        )

    async def get_or_create_session(
        self,
        user_id: str,
        resume_version_id: str,
        job_hash: str,
        *,
        matcher_version: str,
        prompt_version: str,
    ) -> TailoringSession | None:
        """Look up the most recent ai_status='ok' session for this exact
        (resume_version_id, job_hash) pair under the CURRENT matcher_version AND
        prompt_version. Returns None if none exists — the caller then does the
        real work and calls create_session(). A matcher/prompt version bump
        naturally forces a fresh row since it's part of this filter, so old
        sessions' editor links keep working against the row they were created
        with rather than being silently rewritten.

        Despite the name, this method never writes — it's a lookup only. There
        is deliberately no UniqueConstraint on (user_id, resume_version_id,
        job_hash) backing this as a DB-level upsert; two truly-concurrent
        identical submissions are handled by the Redis single-flight lock in
        cache.py, not by a DB constraint.
        """
        stmt = (
            self._scoped(select(self.model), user_id)
            .where(
                self.model.resume_version_id == resume_version_id,
                self.model.job_hash == job_hash,
                self.model.matcher_version == matcher_version,
                self.model.prompt_version == prompt_version,
                self.model.ai_status == "ok",
            )
            .order_by(self.model.created_at.desc())
            .limit(1)
        )
        return (await self.session.execute(stmt)).scalar_one_or_none()

    async def set_template(self, user_id: str, id_: str, template_id: str) -> TailoringSession | None:
        return await self.update(user_id, id_, template_id=template_id)

    async def set_title(self, user_id: str, id_: str, title: str) -> TailoringSession | None:
        return await self.update(user_id, id_, title=title)

    async def save_draft(self, user_id: str, id_: str, draft_cv_data: dict[str, Any]) -> TailoringSession | None:
        """Autosaved editor edits. Overwrites any previous draft wholesale —
        the editor always sends its full current cv_data, not a diff."""
        return await self.update(user_id, id_, draft_cv_data=draft_cv_data)
