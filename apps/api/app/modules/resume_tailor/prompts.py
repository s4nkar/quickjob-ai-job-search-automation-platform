"""Prompt content + version constants for resume-tailor's LLM calls.

Kept separate from generation.py so that file stays pure orchestration
(calling the LLM, parsing JSON, validating, caching) without ~150 lines of
prompt text interspersed. A version constant lives next to the prompt it
versions, since bumping one always means the other changed too.

Bumping any of the three version constants below forces a fresh cache key /
fresh get_or_create_session lookup (see cache.py/repository.py) — no manual
cache-busting code needed. This module intentionally keeps only the CURRENT
text of each prompt (not a historical registry of every past version) — git
history already answers "what did this prompt used to say"; the version
constants exist purely to invalidate caches on change, not to replay history.
"""

from __future__ import annotations

# Bumping any of these forces a fresh cache key / fresh get_or_create_session
# lookup — see cache.py and repository.py.
MATCHER_VERSION = "matcher-v1"
# v3 switched these to tier="light" to dodge a reasoning model leaking
# chain-of-thought instead of JSON — didn't fully fix it (the OpenRouter
# fallback model leaked too, and the light model's own lower per-minute
# token ceiling made rate-limit failures more likely, not less). v4 reverts
# to tier="heavy" and adds response_format={"type": "json_object"} instead —
# a structural JSON constraint at the API level, not a model choice bet.
STRUCT_PROMPT_VERSION = "struct-v4"
PROSE_PROMPT_VERSION = "prose-v4"


JD_TRANSLATE_SYSTEM_PROMPT = (
    "Translate the following job description to English. "
    "CRITICAL: Preserve ALL original line breaks, bullet points, and list structure exactly — "
    "each item that was on its own line must remain on its own line after translation. "
    "If the text contains the SAME content in BOTH German AND English already, "
    "output ONLY the English version — do NOT translate the German again or duplicate any section. "
    "Preserve all technical terms, tool names, company names, and section headers exactly. "
    "Return only the translated text with no commentary or preamble."
)


STRUCT_SYSTEM_PROMPT = """You are a professional CV writer. Parse the resume text into a structured JSON object.

CRITICAL RULES — violating any of these produces a broken CV:
1. full_name: Extract the COMPLETE name (e.g. "Sankar Dev Santhosh", NOT just "Sankar"). Never truncate.
2. skills: For EVERY skill category, populate "items" as a non-empty comma-separated string of the actual tools/skills listed. NEVER leave "items" as null, empty string, or an empty list.
3. languages: Copy language entries EXACTLY as written in the resume. Do NOT substitute, add, or remove languages.
4. Completeness: Include ALL experience entries, ALL projects, ALL publications found in the resume. Do not omit any.
5. bullets: Each string in ANY bullets array MUST NOT start with a bullet character (•, -, *, ▪, –). The template adds its own markers. Strip any such prefix before including the text.
6. publications venue: Preserve the COMPLETE venue string verbatim, including any ranking qualifiers (e.g. "Q1-ranked", "Scopus indexed", "SJR"). Never truncate the venue name.
7. featured_project: If the resume contains a section labelled "FEATURED PROJECT", "HIGHLIGHT PROJECT", or similar, you MUST extract it into the `featured_project` field. NEVER leave featured_project null if the resume shows one. Do NOT duplicate it in the `projects` array.
8. other_sections: The categories above (experience/education/skills/projects/publications/languages) don't cover every possible resume section. If the resume has a section that doesn't fit any of them (e.g. "Volunteering", "Patents", "Certifications", "Awards", "References"), put it in `other_sections` with its ORIGINAL heading preserved verbatim. Do NOT drop it, and do NOT force it into an unrelated category above.

Return ONLY this JSON structure (no markdown, no extra text):
{
  "full_name": "string — complete name",
  "job_title": "string — headline/tagline",
  "location": "string (City, Country)",
  "email": "string",
  "phone": "string or null",
  "github": "string or null (path only, e.g. github.com/user)",
  "linkedin": "string or null (path only, e.g. linkedin.com/in/user)",
  "website": "string or null",
  "work_authorization": "string or null",
  "summary": "string — professional summary paragraph",
  "featured_project": {
    "name": "string", "year": "string or null", "tech": "string or null",
    "bullets": ["string"], "results": "string or null"
  },
  "experience": [
    {"title": "string", "company": "string", "location": "string or null",
     "period": "string", "bullets": ["string"]}
  ],
  "education": [
    {"degree": "string", "institution": "string", "location": "string or null",
     "period": "string", "details": "string or null"}
  ],
  "skills": [
    {"category": "string", "items": "SINGLE STRING — skills separated by commas, e.g. \\"Python, PyTorch, Docker\\". NOT an array. NEVER null or empty."}
  ],
  "projects": [
    {"name": "string", "tech": "string or null", "bullets": ["string"]}
  ],
  "publications": [
    {"title": "string", "venue": "string", "year": "string or null"}
  ],
  "languages": ["string — exact language entries from resume"],
  "relocation": "string or null",
  "other_sections": [
    {"heading": "string — the section's ORIGINAL heading from the resume, e.g. \\"Volunteering\\"", "bullets": ["string"]}
  ]
}"""


TAILOR_PROSE_SYSTEM_PROMPT = """You are a CV tailoring assistant. The deterministic ATS analysis is already done —
you receive its results and must NOT recompute scores, matched keywords, or missing keywords.

Return ONLY valid JSON in this shape:
{
  "target_role": "<job title from the JD>",
  "target_company": "<company name from the JD>",
  "profile_headline": "<headline in the format: [target job title] | [relevant skill] | [relevant skill] | [relevant skill] — use the exact target job title from the JD as the first segment, then 2–3 skills from the resume most relevant to this specific role>",
  "tailored_summary": "<professional summary paragraph — see tone rules below>",
  "bullet_patches": [{"bullet_id": "<EXACT id shown in brackets in REWRITE CANDIDATES, e.g. b12>", "improved": "<sharpened framing>"}],
  "implied_skills_to_add": [{"category": "<a skills category name matching how this resume already labels its skills>", "items": "<comma-separated foundational tools implied by the candidate's existing tech stack>"}],
  "summary": "<1-paragraph honest fit assessment noting strengths and real gaps>"
}

Hard rules:
- bullet_patches: ONLY patch bullets from the REWRITE CANDIDATES list. Echo the EXACT bullet_id shown in brackets — do NOT retype the original bullet text.
  * PRESERVE every number, percentage, and metric from the original
  * NEVER add tools, methods, or domains absent from the original
  * Adjust only verb / framing / emphasis — the evidence must stay identical
- implied_skills_to_add: for any tool or library in the MISSING KEYWORDS list that is clearly implied by the candidate's existing tech stack (e.g. Pandas/NumPy implied by PyTorch/ML work), add it under a category name that matches this resume's own skills section labelling. Only do this for standard foundational tools — never invent specialised domain experience. Leave empty if nothing qualifies.
- profile_headline: lead with the exact job title from the JD, then 2–3 of the candidate's REAL skills most relevant to THIS SPECIFIC ROLE. Prefer specific technical skills (e.g. RAG, NLP, LangChain, Transformers, EU AI Act) over generic acronyms — NEVER use "AI", "ML", or "Machine Learning" as a standalone headline segment; they are redundant when the job title already implies them. Draw from MATCHED KEYWORDS and resume skills when they clearly overlap the JD's domain. Never add skills the resume doesn't show.
- tailored_summary TONE AND CONTENT — strict CV style, not cover letter style:
  * Write in NOMINATIVE STYLE ONLY — no pronouns at all. Do NOT use "I", "my", "their", "they", "this candidate", "the candidate". Start directly with a noun phrase: "Applied AI Engineer with 3+ years…".
  * NO cover-letter phrases: "I am confident", "I am excited", "I look forward to", "I believe".
  * NO vague filler: "drive innovation", "leveraging expertise", "improve complex workflows", "passionate about".
  * Lead with years of experience and core specialty, e.g. "Applied AI Engineer with 3+ years of experience building..."
  * Include at least ONE specific achievement from the resume (a metric, a project name, or a publication). Make it feel like THIS candidate, not any AI engineer.
  * Reframe genuine transferable experience for this specific role. Never claim domain expertise the resume does not show.
  * Write in your own words — do NOT copy or paraphrase sentence fragments from the JD requirements. The summary must read as the candidate's own story, not a reflection of the job posting.
  * NEVER mention any skill from the MISSING KEYWORDS list — those are absent from the resume.
- summary: ground the fit assessment in the provided CRITICAL GAPS and TRANSFERABLE STRENGTHS.
- Return ONLY valid JSON, no markdown fences."""
