"""Unit tests for resume_tailor.schemas.validate_cv_data — the field-by-field
lenient validator that guards generate_base_cv_data's untrusted LLM output."""

from app.modules.resume_tailor.schemas import validate_cv_data


def test_validate_cv_data_passes_through_well_formed_input():
    raw = {
        "full_name": "Jane Doe",
        "job_title": "Backend Engineer",
        "email": "jane@example.com",
        "experience": [
            {"title": "Engineer", "company": "Acme", "period": "2020-2024", "bullets": ["Did things"]},
        ],
        "skills": [{"category": "Languages", "items": "Python, Go"}],
        "languages": ["English", "German"],
    }

    result = validate_cv_data(raw)

    assert result["full_name"] == "Jane Doe"
    assert result["experience"][0]["company"] == "Acme"
    assert result["skills"] == [{"category": "Languages", "items": "Python, Go"}]
    assert result["languages"] == ["English", "German"]


def test_validate_cv_data_fills_missing_fields_with_schema_defaults():
    result = validate_cv_data({"full_name": "Jane Doe"})

    assert result["full_name"] == "Jane Doe"
    assert result["experience"] == []
    assert result["education"] == []
    assert result["skills"] == []
    assert result["other_sections"] == []
    assert result["featured_project"] is None


def test_validate_cv_data_falls_back_to_default_for_wrong_shaped_field():
    result = validate_cv_data({
        "full_name": "Jane Doe",
        "skills": "Python, Go",  # wrong shape — should be list[{category, items}]
        "experience": [{"title": "Engineer", "company": "Acme", "period": "2024", "bullets": []}],
    })

    assert result["skills"] == []
    assert result["experience"][0]["title"] == "Engineer"


def test_validate_cv_data_drops_malformed_nested_experience_entry_only():
    result = validate_cv_data({
        "experience": [
            {"title": "Engineer", "company": "Acme", "period": "2024", "bullets": ["ok"]},
            {"title": "Manager", "company": "Beta", "period": "2022", "bullets": "not a list"},
        ],
    })

    # One malformed item in the list invalidates that whole field (TypeAdapter
    # validates the list as a unit) — falls back to [] rather than raising.
    assert result["experience"] == []


def test_validate_cv_data_ignores_unknown_extra_keys():
    result = validate_cv_data({"full_name": "Jane Doe", "some_unexpected_field": "value"})

    assert result["full_name"] == "Jane Doe"
    assert "some_unexpected_field" not in result


def test_validate_cv_data_defaults_section_order_to_empty_list():
    result = validate_cv_data({"full_name": "Jane Doe"})

    assert result["section_order"] == []


def test_validate_cv_data_passes_through_valid_section_order():
    result = validate_cv_data({
        "section_order": ["education", "skills", "summary", "experience"],
    })

    assert result["section_order"] == ["education", "skills", "summary", "experience"]


def test_validate_cv_data_rejects_unknown_section_key():
    # Not one of the nine SectionKey literals — the whole field falls back to
    # [] rather than silently keeping a key no template macro dispatch table
    # recognizes (that would KeyError inside the Jinja template).
    result = validate_cv_data({
        "section_order": ["summary", "not_a_real_section"],
    })

    assert result["section_order"] == []
