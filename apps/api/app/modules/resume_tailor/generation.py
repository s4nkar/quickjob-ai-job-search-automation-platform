"""All LLM prompt orchestration for resume-tailor (calling the LLM, parsing
JSON, validating, caching) — prompt content and version constants live in
prompts.py, imported below.

Two independent LLM-facing operations, deliberately split because base_cv_data
must now be dedup'd per resume version, independent of any specific JD (see
models.py's ResumeVersion.base_cv_data):

    generate_base_cv_data(resume_text)  — pure structural parsing, JD-agnostic,
                                           called at most once per resume version.
    generate_tailor_prose(...)          — JD-specific prose (headline, summary,
                                           bullet patches), cached per
                                           (resume_hash, job_hash, prompt_version, model).

Also owns JD language detection/translation (_is_english/_translate_jd) since
that's the other place this module calls the LLM.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from app.core.config import settings
from app.ai.llm import provider as ai_provider
from app.modules.resume_tailor import cache as resume_cache
from app.modules.resume_tailor.prompts import (
    JD_TRANSLATE_SYSTEM_PROMPT,
    MATCHER_VERSION,
    PROSE_PROMPT_VERSION,
    STRUCT_PROMPT_VERSION,
    STRUCT_SYSTEM_PROMPT,
    TAILOR_PROSE_SYSTEM_PROMPT,
)
from app.modules.resume_tailor.schemas import validate_cv_data
from app.modules.resume_tailor.validation import validate_bullet_patch, validate_headline_skills, validate_summary

if TYPE_CHECKING:
    from app.modules.resume_tailor.chunker import Chunk
    from app.modules.resume_tailor.matcher import MatchResult, RewriteCandidate

logger = logging.getLogger(__name__)

# Re-exported from prompts.py — MATCHER_VERSION/STRUCT_PROMPT_VERSION/
# PROSE_PROMPT_VERSION are used throughout this module and by routes.py via
# `generation.STRUCT_PROMPT_VERSION` etc.; kept accessible here so callers
# don't need to know the constants physically live in a sibling file.
__all__ = [
    "MATCHER_VERSION", "STRUCT_PROMPT_VERSION", "PROSE_PROMPT_VERSION",
    "generate_base_cv_data", "generate_tailor_prose", "translate_jd_if_needed",
    "TailorProseResult",
]


# ── JD language detection/translation ───────────────────────────────

# German structural words that rarely appear in English technical text.
# Used to catch German JDs written mostly in ASCII (few umlauts).
_GERMAN_STRUCTURAL_RE = re.compile(
    r"\b(deine?[rns]?|kenntnisse[n]?|aufgaben|werkstudent|studium\b|praktikum|"
    r"bewerbung|erfahrung\b|bereich\b|programmierkenntnisse|abgeschlossenes|"
    r"mehrjährige|solide\b|fundierte|sicherer|vertrautheit|laufendes)\b",
    re.I,
)


def _is_english(text: str) -> bool:
    """Return False if the text appears to be non-English.

    Two-pass check:
    1. Non-ASCII ratio ≥ 1% → non-English (catches umlauts/accents).
    2. German structural word count ≥ 3 → non-English (catches ASCII-heavy
       German JDs like startup postings that use few umlauts).
    """
    if not text:
        return True
    non_ascii = sum(1 for c in text if ord(c) > 127)
    if (non_ascii / len(text)) >= 0.01:
        return False
    german_hits = len(_GERMAN_STRUCTURAL_RE.findall(text))
    return german_hits < 3


async def _translate_jd(text: str) -> str:
    """Translate a non-English JD to English via the configured LLM."""
    # tier="light" — same reasoning-leak risk as generate_base_cv_data/
    # generate_tailor_prose, but worse here: there's no JSON parse boundary
    # to catch a corrupted response, so a reasoning model prepending
    # "Let me translate this..." would silently become part of the "clean"
    # JD text fed into chunking/matching, with no error or degraded flag —
    # not a loud failure, a silently worse match score.
    return await ai_provider.generate_text(text[:4000], JD_TRANSLATE_SYSTEM_PROMPT, max_tokens=4000, tier="light")


async def translate_jd_if_needed(job_description: str) -> str:
    """English passthrough, or a best-effort translation on failure — never
    raises. Degrades to the original text rather than blocking the request."""
    if _is_english(job_description):
        return job_description
    logger.info("Non-English JD detected — translating to English before analysis")
    try:
        return await _translate_jd(job_description)
    except Exception as exc:
        logger.warning("JD translation failed: %r — proceeding with original text", exc)
        return job_description


# ── Base CV structuring (JD-agnostic, cached per resume version) ───

async def generate_base_cv_data(resume_text: str) -> dict[str, Any]:
    """Pure structural parsing, no JD/tailoring context — called at most once
    per resume_version_id and persisted to resume_versions.base_cv_data."""
    prompt = f"""Parse this resume into the required JSON format.

RESUME TEXT:
{resume_text[:6000]}"""

    # response_format=json_object structurally constrains the output to valid
    # JSON — a "return ONLY JSON" prompt instruction alone was observed NOT
    # being reliably honored: switching this call to tier="light" to dodge a
    # reasoning model's chain-of-thought leak didn't fix it either, since the
    # OpenRouter fallback model (and, on retest, the light model's own
    # provider) exhibited the same leak. JSON mode fixes it at the API level
    # regardless of which model serves the request, so tier="heavy" is back —
    # better quality and a materially higher per-minute token ceiling on Groq
    # than the light model had.
    raw = await ai_provider.generate_text(
        prompt, STRUCT_SYSTEM_PROMPT, max_tokens=4000, tier="heavy",
        response_format={"type": "json_object"},
    )
    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        parsed = json.loads(raw[start:end])
    except Exception as exc:
        raise ValueError(f"Failed to structure resume: malformed LLM JSON response: {exc!r}") from exc

    # response_format=json_object only guarantees valid JSON syntax, not the
    # right shape — validate_cv_data checks it field-by-field against
    # CvDataSchema and falls back per-field so one malformed field (e.g.
    # "skills" returned as a string) doesn't take down the whole result.
    return validate_cv_data(parsed)


# ── Tailoring prose (JD-specific, cached per resume+job+prompt+model) ──

@dataclass
class TailorProseResult:
    target_role: str = ""
    target_company: str = ""
    profile_headline: str = ""
    tailored_summary: str = ""
    bullet_rewrites: list[dict[str, str]] = field(default_factory=list)
    implied_skills_to_add: list[dict[str, str]] = field(default_factory=list)
    summary: str = ""
    ai_status: str = "ok"  # "ok" | "degraded"
    ai_provider: str | None = None
    ai_error: str | None = None
    validation_flags: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "target_role": self.target_role,
            "target_company": self.target_company,
            "profile_headline": self.profile_headline,
            "tailored_summary": self.tailored_summary,
            "bullet_rewrites": self.bullet_rewrites,
            "implied_skills_to_add": self.implied_skills_to_add,
            "summary": self.summary,
            "ai_status": self.ai_status,
            "ai_provider": self.ai_provider,
            "ai_error": self.ai_error,
            "validation_flags": self.validation_flags,
        }


def _prose_model_label() -> str:
    """Config-time model identity for the prose cache key — reflects what this
    deployment is CURRENTLY configured to use, not necessarily whichever
    provider ends up serving after a fallback (unknowable before the call).
    A provider/model config change naturally busts the cache, which is the
    actual goal.

    Must match the tier actually passed to generate_text_with_provider below
    (tier="heavy") — response_format=json_object handles JSON compliance now,
    so this call no longer needs to dodge the heavy model via a tier switch
    (see the call site's comment)."""
    provider = settings.ai_provider.lower().strip()
    if provider == "groq":
        return f"groq:{settings.groq_model}"
    if provider == "openrouter":
        return f"openrouter:{settings.openrouter_model}"
    return provider


def _bullet_ids_for_rewrites(
    resume_chunks: list["Chunk"], rewrite_candidates: list["RewriteCandidate"],
) -> list[str | None]:
    """One id per candidate, aligned BY POSITION with rewrite_candidates
    ('b{index}', where index is the bullet's position in resume_chunks —
    chunk_resume() is a pure function of immutable resume text, so a
    persisted resume_versions.chunks array is fixed forever once created, no
    changes to Chunk/chunker.py needed). None where the candidate's text
    can't be found at all (shouldn't happen since candidates are derived
    from resume_chunks in the first place, but handled defensively).

    Returns a parallel LIST, not a text-keyed dict — deliberately, so two
    candidates with identical bullet text still resolve to two distinct
    (correct) chunk positions instead of the second one silently
    overwriting the first in a shared dict slot.
    """
    text_to_indices: dict[str, list[int]] = {}
    for i, chunk in enumerate(resume_chunks):
        text_to_indices.setdefault(chunk.text, []).append(i)

    claimed: dict[str, int] = {}
    ids: list[str | None] = []
    for rc in rewrite_candidates:
        indices = text_to_indices.get(rc.resume_bullet)
        if not indices:
            ids.append(None)
            continue
        pos = min(claimed.get(rc.resume_bullet, 0), len(indices) - 1)
        claimed[rc.resume_bullet] = pos + 1
        ids.append(f"b{indices[pos]}")
    return ids


async def _generate_tailor_prose_uncached(
    resume_text: str,
    resume_chunks: list["Chunk"],
    job_description: str,
    analysis: "MatchResult",
) -> TailorProseResult:
    bullet_ids = _bullet_ids_for_rewrites(resume_chunks, analysis.rewrite_candidates)
    rewrites_block = (
        "\n".join(
            f"- [{bullet_id}] ORIGINAL: {rc.resume_bullet}\n  TARGET REQUIREMENT: {rc.target_requirement}"
            for rc, bullet_id in zip(analysis.rewrite_candidates, bullet_ids)
            if bullet_id is not None
        )
        or "(no bullets in the rewrite band — leave bullet_patches empty)"
    )
    transferable_block = "; ".join(analysis.transferable_strengths[:6]) or "(none)"
    critical_block = "; ".join(analysis.critical_missing[:6]) or "(none)"
    missing_block = ", ".join(analysis.missing_keywords) or "(none)"
    matched_block = ", ".join(analysis.matched_keywords[:15]) or "(none)"

    prompt = f"""DETERMINISTIC ANALYSIS (do not recompute, just use):
OVERALL SCORE: {analysis.overall_score}
SCORE BREAKDOWN: {json.dumps(analysis.score_breakdown)}
MATCHED KEYWORDS (use these to pick headline skills — prefer the ones most role-relevant): {matched_block}
TRANSFERABLE STRENGTHS: {transferable_block}
CRITICAL GAPS (do not invent experience to cover these): {critical_block}
MISSING KEYWORDS — absent from resume, do not mention in any prose field: {missing_block}

REWRITE CANDIDATES (only patch these — echo the bracketed id, not the text):
{rewrites_block}

JOB DESCRIPTION:
{job_description[:2500]}

RESUME (for extracting target_role/target_company and grounding prose only):
{resume_text[:3500]}"""

    try:
        # response_format=json_object — see generate_base_cv_data's comment.
        # tier="heavy" for the same reason: JSON compliance is now enforced
        # structurally, so there's no need to trade down to the light
        # model's lower quality and lower per-minute token ceiling.
        raw, provider = await ai_provider.generate_text_with_provider(
            prompt, TAILOR_PROSE_SYSTEM_PROMPT, max_tokens=1200, tier="heavy",
            response_format={"type": "json_object"},
        )
    except ai_provider.AIGenerationError as exc:
        logger.warning("Tailor prose generation failed: %r — returning deterministic analysis only", exc)
        return TailorProseResult(ai_status="degraded", ai_error=str(exc))

    try:
        start = raw.find("{")
        end = raw.rfind("}") + 1
        parsed = json.loads(raw[start:end])
    except Exception:
        logger.warning("LLM tailor prose returned malformed JSON: %r", raw[:300])
        return TailorProseResult(ai_status="degraded", ai_provider=provider, ai_error="malformed JSON response")

    validation_flags: list[str] = []

    bullet_text_by_id = {f"b{i}": chunk.text for i, chunk in enumerate(resume_chunks)}
    bullet_rewrites: list[dict[str, str]] = []
    for patch in parsed.get("bullet_patches") or []:
        bullet_id = patch.get("bullet_id")
        improved = patch.get("improved")
        original = bullet_text_by_id.get(bullet_id) if bullet_id else None
        if not improved or original is None:
            continue
        result = validate_bullet_patch(bullet_id, improved, resume_text)
        if not result.ok:
            validation_flags.append(f"{bullet_id}: {'; '.join(result.violations)}")
            continue
        bullet_rewrites.append({"original": original, "improved": improved})

    # profile_headline/tailored_summary get the same grounding check as
    # bullets — a failing field is dropped (empty string) rather than
    # rejecting the whole response; apply_tailoring_overlay() already treats
    # an empty profile_headline/tailored_summary as "keep the resume's own
    # untailored value," so this composes for free, no extra fallback logic.
    profile_headline = parsed.get("profile_headline", "")
    if profile_headline:
        headline_check = validate_headline_skills(profile_headline, resume_text)
        if not headline_check.ok:
            validation_flags.append(f"profile_headline: {'; '.join(headline_check.violations)}")
            profile_headline = ""

    tailored_summary = parsed.get("tailored_summary", "")
    if tailored_summary:
        summary_check = validate_summary(tailored_summary, resume_text)
        if not summary_check.ok:
            validation_flags.append(f"tailored_summary: {'; '.join(summary_check.violations)}")
            tailored_summary = ""

    return TailorProseResult(
        target_role=parsed.get("target_role", ""),
        target_company=parsed.get("target_company", ""),
        profile_headline=profile_headline,
        tailored_summary=tailored_summary,
        bullet_rewrites=bullet_rewrites,
        implied_skills_to_add=parsed.get("implied_skills_to_add") or [],
        summary=parsed.get("summary", ""),
        ai_status="ok",
        ai_provider=provider,
        validation_flags=validation_flags,
    )


async def generate_tailor_prose(
    user_id: str,
    resume_hash: str,
    job_hash: str,
    resume_text: str,
    resume_chunks: list["Chunk"],
    job_description: str,
    analysis: "MatchResult",
) -> TailorProseResult:
    """Cached, single-flight-guarded wrapper around _generate_tailor_prose_uncached.
    Never raises — a total AI outage degrades to an empty-prose TailorProseResult
    (ai_status="degraded") rather than failing the whole /tailor request."""
    model_label = _prose_model_label()

    cached = await resume_cache.get_prose_cache(user_id, resume_hash, job_hash, PROSE_PROMPT_VERSION, model_label)
    if cached is not None:
        return TailorProseResult(**cached)

    try:
        is_leader = await resume_cache.acquire_prose_lock(user_id, resume_hash, job_hash, PROSE_PROMPT_VERSION)
    except Exception:
        is_leader = True

    if not is_leader:
        waited = 0.0
        while waited < resume_cache.PROSE_SINGLE_FLIGHT_MAX_WAIT_SECONDS:
            await asyncio.sleep(resume_cache.PROSE_SINGLE_FLIGHT_POLL_INTERVAL_SECONDS)
            waited += resume_cache.PROSE_SINGLE_FLIGHT_POLL_INTERVAL_SECONDS
            cached = await resume_cache.get_prose_cache(user_id, resume_hash, job_hash, PROSE_PROMPT_VERSION, model_label)
            if cached is not None:
                return TailorProseResult(**cached)
        # Timed out waiting for the leader — proceed and call the LLM anyway
        # rather than hang forever, same fail-open philosophy as every other
        # limiter/lock in this codebase.

    result = await _generate_tailor_prose_uncached(resume_text, resume_chunks, job_description, analysis)

    if result.ai_status == "ok":
        try:
            await resume_cache.set_prose_cache(user_id, resume_hash, job_hash, PROSE_PROMPT_VERSION, model_label, result.as_dict())
        except Exception:
            pass

    return result
