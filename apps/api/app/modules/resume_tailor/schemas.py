"""Request/response models for resume-tailor's session-based API.

cv_data stays a pass-through dict[str, Any] on every WIRE model (Editor/
Preview/Pdf/DraftSave) — its shape varies across 17 templates, and once a
human is editing it in the browser we deliberately don't want to reject their
own edits for not perfectly matching a rigid schema. CvDataSchema below is a
different thing: it validates the LLM's OWN untrusted output at the moment
it's generated (see generation.py::generate_base_cv_data), before anything
else ever touches it — that boundary needs validation (CLAUDE.md: "Validate
everything at the boundary"), the human-editing boundary deliberately doesn't.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, Field, TypeAdapter, ValidationError

logger = logging.getLogger(__name__)


class MissingKeyword(BaseModel):
    keyword: str
    suggested_placement: str


class AnalysisPayload(BaseModel):
    match_score: int
    matched_keywords: list[str]
    missing_keywords: list[MissingKeyword]
    score_breakdown: dict[str, int] = Field(default_factory=dict)
    transferable_strengths: list[str] = Field(default_factory=list)
    critical_missing: list[str] = Field(default_factory=list)
    matches: list[dict[str, Any]] = Field(default_factory=list)
    degraded: bool = False


class BulletRewrite(BaseModel):
    original: str
    improved: str


class TailoringPayload(BaseModel):
    target_role: str = ""
    target_company: str = ""
    profile_headline: str = ""
    tailored_summary: str = ""
    bullet_rewrites: list[BulletRewrite] = Field(default_factory=list)
    summary: str = ""
    validation_flags: list[str] = Field(default_factory=list)


class AiStatusPayload(BaseModel):
    status: str  # "ok" | "degraded"
    provider: str | None = None


class TailorResponse(BaseModel):
    session_id: str
    status: str  # "ready" | "failed"
    analysis: AnalysisPayload
    tailoring: TailoringPayload | None = None
    ai: AiStatusPayload


class EditorResponse(BaseModel):
    cv_data: dict[str, Any]
    session_id: str
    template_id: str
    templates: list[dict[str, Any]]
    is_draft: bool = False


class TemplateListResponse(BaseModel):
    templates: list[dict[str, Any]]


class PreviewRequest(BaseModel):
    template_id: str
    cv_data: dict[str, Any]


class ThumbnailsRequest(BaseModel):
    cv_data: dict[str, Any]


class ThumbnailsResponse(BaseModel):
    thumbnails: dict[str, str]


class PdfRequest(BaseModel):
    template_id: str
    cv_data: dict[str, Any]
    opportunity_id: str | None = None


class DraftSaveRequest(BaseModel):
    cv_data: dict[str, Any]


# ── CvDataSchema — validates generate_base_cv_data's LLM output ──────
# Mirrors the frontend's CvData TypeScript interface (apps/web/lib/types.ts)
# field-for-field. response_format=json_object (see provider.py) guarantees
# syntactically valid JSON, but says nothing about SHAPE — a model can return
# well-formed JSON that's still missing "experience" entirely, or return
# "skills" as a string instead of an array. Without this, that malformed
# object would be persisted as base_cv_data and shipped straight to the
# frontend, which would then crash trying to .map() over a field that isn't
# there (the same failure class as the earlier match_score crash, just
# unguarded on this boundary).

class CvExperienceSchema(BaseModel):
    title: str = ""
    company: str = ""
    location: str | None = None
    period: str = ""
    bullets: list[str] = Field(default_factory=list)


class CvEducationSchema(BaseModel):
    degree: str = ""
    institution: str = ""
    location: str | None = None
    period: str = ""
    details: str | None = None


class CvSkillSchema(BaseModel):
    category: str = ""
    items: str = ""


class CvProjectSchema(BaseModel):
    name: str = ""
    tech: str | None = None
    bullets: list[str] = Field(default_factory=list)


class CvPublicationSchema(BaseModel):
    title: str = ""
    venue: str = ""
    year: str | None = None


class CvFeaturedProjectSchema(BaseModel):
    name: str = ""
    year: str | None = None
    tech: str | None = None
    bullets: list[str] = Field(default_factory=list)
    results: str | None = None


class CvOtherSectionSchema(BaseModel):
    heading: str = ""
    bullets: list[str] = Field(default_factory=list)


# Every reorderable section kind a template can render. "other_sections" is
# ONE slot in this order — the custom sections inside it keep their own
# internal array order, they aren't individually interleaved with built-ins.
# "relocation" isn't included: it's rendered bundled with "languages" under
# one heading in several templates and isn't independently orderable.
SectionKey = Literal[
    "summary", "featured_project", "experience", "education",
    "skills", "projects", "publications", "languages", "other_sections",
]


class CvDataSchema(BaseModel):
    full_name: str = ""
    job_title: str = ""
    location: str = ""
    email: str = ""
    phone: str | None = None
    github: str | None = None
    linkedin: str | None = None
    website: str | None = None
    work_authorization: str | None = None
    summary: str = ""
    featured_project: CvFeaturedProjectSchema | None = None
    experience: list[CvExperienceSchema] = Field(default_factory=list)
    education: list[CvEducationSchema] = Field(default_factory=list)
    skills: list[CvSkillSchema] = Field(default_factory=list)
    projects: list[CvProjectSchema] = Field(default_factory=list)
    publications: list[CvPublicationSchema] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    relocation: str | None = None
    other_sections: list[CvOtherSectionSchema] = Field(default_factory=list)
    # Empty list = "not customized yet" — each Jinja template falls back to
    # its OWN historical hardcoded section order in that case (see the
    # templates/ directory), so existing resumes render identically until a
    # user actively drags a section in the editor. Once non-empty, every
    # template reorders within its own column assignment (sidebar vs main
    # for two-column templates) to match.
    section_order: list[SectionKey] = Field(default_factory=list)


def validate_cv_data(raw: dict[str, Any]) -> dict[str, Any]:
    """Field-by-field lenient validation against CvDataSchema — a single
    malformed field (wrong type, missing nested key) falls back to that
    field's default instead of rejecting the whole structuring result.
    Preferred over a single `CvDataSchema.model_validate(raw)` call
    specifically so one bad field (e.g. a malformed skills entry) doesn't
    discard everything else the LLM got right (e.g. a fully correct
    experience section) — the failure should be as narrow as the LLM's
    actual mistake, not the whole document.

    Returns a plain JSON-safe dict (same shape CvDataSchema.model_dump()
    would give), not a CvDataSchema instance — callers persist/merge this as
    a dict, same as the rest of this module's cv_data handling.
    """
    result: dict[str, Any] = {}
    for name, field in CvDataSchema.model_fields.items():
        adapter = TypeAdapter(field.annotation)
        default = field.get_default(call_default_factory=True)
        value = raw.get(name, default)
        try:
            validated = adapter.validate_python(value)
            result[name] = adapter.dump_python(validated, mode="json")
        except ValidationError as exc:
            logger.warning("base_cv_data field %r failed schema validation (%s) — using default", name, exc)
            result[name] = default
    return result
