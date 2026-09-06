"""Unit tests for resume_tailor.generation — pure prompt construction/parsing
with the LLM call mocked via monkeypatch. No Redis, no network access (the
cached/single-flight wrapper generate_tailor_prose is intentionally NOT
exercised here — it needs Redis, and is out of scope for Tier 1)."""

import json

from app.ai.llm.provider import AIGenerationError
from app.modules.resume_tailor import generation, prompts
from app.modules.resume_tailor.chunker import Chunk
from app.modules.resume_tailor.matcher import MatchResult, RewriteCandidate


def _match_result(rewrite_candidates=None):
    return MatchResult(
        matches=[],
        matched_keywords=["Python"],
        missing_keywords=["Kubernetes"],
        transferable_strengths=[],
        critical_missing=[],
        rewrite_candidates=rewrite_candidates or [],
        score_breakdown={"core_skills": 80},
        overall_score=80,
        degraded=False,
    )


async def test_generate_tailor_prose_returns_bullet_patches_keyed_by_chunk_id(monkeypatch):
    resume_chunks = [
        Chunk(kind="bullet", section="experience", text="Built backend services for production traffic"),
        Chunk(kind="bullet", section="experience", text="Mentored two junior engineers on the team"),
    ]
    candidates = [
        RewriteCandidate(resume_bullet=resume_chunks[0].text, target_requirement="Backend engineering", similarity=0.6),
    ]
    analysis = _match_result(candidates)

    llm_response = json.dumps({
        "target_role": "Backend Engineer",
        "target_company": "Acme",
        "profile_headline": "Backend Engineer | Python | AWS",
        "tailored_summary": "Backend engineer with production experience.",
        "bullet_patches": [{"bullet_id": "b0", "improved": "Engineered backend services for production traffic"}],
        "implied_skills_to_add": [],
        "summary": "Strong fit.",
    })

    async def fake_generate_text_with_provider(prompt, system, max_tokens=1200, tier="heavy", response_format=None):
        assert "[b0]" in prompt
        return llm_response, "groq"

    monkeypatch.setattr(generation.ai_provider, "generate_text_with_provider", fake_generate_text_with_provider)

    result = await generation._generate_tailor_prose_uncached(
        resume_text="Built backend services for production traffic. Mentored two junior engineers on the team.",
        resume_chunks=resume_chunks,
        job_description="We need a backend engineer.",
        analysis=analysis,
    )

    assert result.ai_status == "ok"
    assert result.ai_provider == "groq"
    assert result.bullet_rewrites == [
        {"original": resume_chunks[0].text, "improved": "Engineered backend services for production traffic"},
    ]


async def test_generate_tailor_prose_degrades_on_ai_generation_error(monkeypatch):
    analysis = _match_result()

    async def fake_generate_text_with_provider(prompt, system, max_tokens=1200, tier="heavy", response_format=None):
        raise AIGenerationError("all providers exhausted")

    monkeypatch.setattr(generation.ai_provider, "generate_text_with_provider", fake_generate_text_with_provider)

    result = await generation._generate_tailor_prose_uncached(
        resume_text="Some resume text.", resume_chunks=[], job_description="JD", analysis=analysis,
    )
    assert result.ai_status == "degraded"
    assert result.ai_error is not None
    assert result.bullet_rewrites == []


async def test_generate_tailor_prose_handles_malformed_json_gracefully(monkeypatch):
    analysis = _match_result()

    async def fake_generate_text_with_provider(prompt, system, max_tokens=1200, tier="heavy", response_format=None):
        return "not json at all", "groq"

    monkeypatch.setattr(generation.ai_provider, "generate_text_with_provider", fake_generate_text_with_provider)

    result = await generation._generate_tailor_prose_uncached(
        resume_text="Some resume text.", resume_chunks=[], job_description="JD", analysis=analysis,
    )
    assert result.ai_status == "degraded"
    assert result.ai_provider == "groq"


async def test_generate_base_cv_data_passes_through_well_formed_response(monkeypatch):
    llm_response = json.dumps({
        "full_name": "Jane Doe",
        "job_title": "Backend Engineer",
        "location": "Berlin, Germany",
        "email": "jane@example.com",
        "summary": "Backend engineer with 5 years of experience.",
        "experience": [
            {"title": "Engineer", "company": "Acme", "period": "2020-2024", "bullets": ["Built things"]},
        ],
        "skills": [{"category": "Languages", "items": "Python, Go"}],
    })

    async def fake_generate_text(prompt, system, max_tokens=4000, tier="heavy", response_format=None):
        return llm_response

    monkeypatch.setattr(generation.ai_provider, "generate_text", fake_generate_text)

    result = await generation.generate_base_cv_data("Some resume text.")

    assert result["full_name"] == "Jane Doe"
    assert result["experience"] == [
        {"title": "Engineer", "company": "Acme", "location": None, "period": "2020-2024", "bullets": ["Built things"]},
    ]
    assert result["skills"] == [{"category": "Languages", "items": "Python, Go"}]
    # Fields the LLM omitted still come back with their schema defaults,
    # never missing entirely.
    assert result["projects"] == []
    assert result["other_sections"] == []


async def test_generate_base_cv_data_falls_back_per_field_on_malformed_shape(monkeypatch):
    """response_format=json_object guarantees valid JSON syntax, not the right
    shape — a model can still return e.g. skills as a string instead of a list
    of objects. That single bad field should fall back to its default instead
    of raising / corrupting the whole result."""
    llm_response = json.dumps({
        "full_name": "Jane Doe",
        "skills": "Python, Go",  # wrong shape: should be a list of {category, items}
        "experience": [{"title": "Engineer", "company": "Acme", "period": "2020-2024", "bullets": ["Built things"]}],
    })

    async def fake_generate_text(prompt, system, max_tokens=4000, tier="heavy", response_format=None):
        return llm_response

    monkeypatch.setattr(generation.ai_provider, "generate_text", fake_generate_text)

    result = await generation.generate_base_cv_data("Some resume text.")

    assert result["full_name"] == "Jane Doe"
    assert result["skills"] == []  # malformed field falls back to default
    assert result["experience"] == [
        {"title": "Engineer", "company": "Acme", "location": None, "period": "2020-2024", "bullets": ["Built things"]},
    ]  # well-formed sibling field is unaffected


def test_generate_base_cv_data_prompt_excludes_tailoring_fields():
    """The base structuring prompt must stay JD-agnostic — tailoring-specific
    rules (bullet substitution, tailored headline/summary override, missing-
    keyword injection) belong only in the prose prompt, since base_cv_data is
    now dedup'd per resume version independent of any JD."""
    assert "bullet_rewrites" not in prompts.STRUCT_SYSTEM_PROMPT
    assert "TAILORED HEADLINE" not in prompts.STRUCT_SYSTEM_PROMPT
    assert "MISSING KEYWORDS" not in prompts.STRUCT_SYSTEM_PROMPT


def test_bullet_ids_for_rewrites_maps_duplicate_text_to_distinct_indices():
    resume_chunks = [
        Chunk(kind="bullet", section="experience", text="Improved system performance significantly"),
        Chunk(kind="bullet", section="experience", text="Improved system performance significantly"),
    ]
    candidates = [
        RewriteCandidate(resume_bullet=resume_chunks[0].text, target_requirement="Perf", similarity=0.6),
        RewriteCandidate(resume_bullet=resume_chunks[0].text, target_requirement="Perf", similarity=0.6),
    ]
    ids = generation._bullet_ids_for_rewrites(resume_chunks, candidates)
    assert ids == ["b0", "b1"]


async def test_translate_jd_only_called_for_non_english_input(monkeypatch):
    calls = []

    async def fake_translate(text):
        calls.append(text)
        return "translated"

    monkeypatch.setattr(generation, "_translate_jd", fake_translate)

    english_result = await generation.translate_jd_if_needed("We are looking for a backend engineer.")
    assert english_result == "We are looking for a backend engineer."
    assert calls == []

    german_result = await generation.translate_jd_if_needed(
        "Wir suchen einen Softwareentwickler mit mehrjährige Erfahrung im Bereich Backend-Entwicklung."
    )
    assert german_result == "translated"
    assert len(calls) == 1
