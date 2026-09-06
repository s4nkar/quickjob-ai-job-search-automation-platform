"""AI provider abstraction — Groq (primary), OpenRouter (fallback).

Configured via env:
    AI_PROVIDER=groq           # primary
    AI_FALLBACK_CHAIN=openrouter   # tried on transient failures

Both Groq and OpenRouter expose OpenAI-compatible REST APIs and are reached
via httpx — no extra SDK needed for either.

Public interface:
    generate_text(prompt, system, max_tokens, tier="heavy", response_format=None) -> str
    generate_text_with_provider(prompt, system, max_tokens, tier="heavy", response_format=None) -> (str, provider_name)
    stream_text(prompt, system, max_tokens, tier="heavy")   -> AsyncGenerator[str, None]

response_format: pass {"type": "json_object"} to structurally constrain the
model's output to valid JSON (Groq/OpenAI-compatible "JSON mode") instead of
relying on a prompt instruction alone — see _openai_compat_generate's comment
for why this matters. Not available on the streaming path. Per Groq/OpenAI's
own requirement, the word "JSON" must appear somewhere in the prompt/system
message when this is set, or the API rejects the request.

Both generate_text and stream_text raise AIGenerationError when every provider
in the chain fails — callers should catch this specifically and degrade
gracefully (mirrors app.ai.embeddings.EmbeddingError) rather than letting a
total outage fail the whole request.

tier: "heavy" (default) uses each provider's configured generation model — for
prose the user reads (resume rewrites, cover letters, interview answers). "light"
uses a smaller, non-reasoning model where available (currently Groq only, via
groq_light_model) — for small extraction/classification tasks (e.g. parsing a
free-text preferences prompt into structured JSON) that don't need a heavy
model's quality, and where a reasoning model would waste its token budget on
invisible chain-of-thought instead of writing the answer. OpenRouter is the
sole fallback and isn't tier-split - it's rarely invoked (only on a Groq
failure), so one general-purpose non-reasoning model serves both tiers.

Failure semantics:
    - generate_text retries the next provider on 5xx / network errors, AND on an
      empty completion (e.g. a reasoning model exhausting max_tokens on
      chain-of-thought before writing any content) - an empty string is never
      treated as a successful response.
    - A 429 gets ONE short backoff-and-retry on the SAME provider first (see
      _RATE_LIMIT_BACKOFF_SECONDS) before falling through to the next provider
      in the chain - a per-minute-token-budget blip is often gone in a couple
      seconds, cheaper than downgrading to a different model.
    - stream_text retries the next provider ONLY if the first provider fails before
      yielding any tokens. Once a stream has started emitting, we do not switch
      mid-stream (would produce garbled output).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import AsyncGenerator

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# One short backoff-and-retry on the SAME provider before downgrading to the
# next one in the chain — a 429 is often a brief per-minute-token-budget blip,
# and a couple seconds' wait is cheaper than switching models mid-request
# (different model, different prompt-adherence characteristics).
_RATE_LIMIT_BACKOFF_SECONDS = 2.0


class _ProviderError(Exception):
    """Transient provider failure — caller should try the next provider."""


class _ProviderUnavailable(_ProviderError):
    """Provider is not configured (e.g. missing API key) — skip without logging as error."""


class _ProviderRateLimited(_ProviderError):
    """The provider responded 429 — worth one short same-provider retry before
    falling through to the next provider in the chain."""


class AIGenerationError(RuntimeError):
    """All LLM providers exhausted for a generate_text/stream_text call. Callers
    should degrade gracefully (e.g. return deterministic-only results) rather
    than failing the request entirely. Mirrors embeddings.EmbeddingError."""


# ── OpenAI-compatible (Groq, OpenRouter) ────────────────────────────

async def _openai_compat_generate(
    prompt: str, system: str, max_tokens: int,
    base_url: str, api_key: str, model: str, label: str,
    response_format: dict | None = None,
) -> str:
    if not api_key:
        raise _ProviderUnavailable(f"{label}: API key not configured")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    body: dict = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": 0.7}
    if response_format:
        # Structural JSON enforcement (constrains decoding to valid JSON
        # tokens), not a prompt instruction — a "return ONLY JSON" system
        # prompt alone was observed not being reliably honored (models kept
        # leaking chain-of-thought/planning text as the response content
        # instead of JSON, exhausting max_tokens before ever emitting the
        # actual object). response_format enforces this at the API level
        # regardless of which model ends up serving the request. Per Groq/
        # OpenAI's own requirement, the word "JSON" must appear somewhere in
        # the prompt/system message for this to work — every caller that
        # sets this already says "Return ONLY valid JSON" in its prompt.
        body["response_format"] = response_format

    try:
        async with httpx.AsyncClient(timeout=settings.ai_request_timeout_seconds) as client:
            resp = await client.post(
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=body,
            )
    except httpx.HTTPError as exc:
        raise _ProviderError(f"{label} network error: {exc!r}") from exc

    if resp.status_code == 429:
        raise _ProviderRateLimited(f"{label} HTTP 429: {resp.text[:200]}")

    if resp.status_code >= 400:
        # Every call site here always sends a well-formed payload (message shape
        # never varies, only content/system/max_tokens) - so in practice a 4xx
        # means a provider-specific problem (deprecated/inaccessible model, org
        # policy), not a malformed request that would fail identically on every
        # provider. Retrying the next provider is the right move, not a hard
        # stop - a stale model id on one provider must not break the whole chain.
        raise _ProviderError(f"{label} HTTP {resp.status_code}: {resp.text[:200]}")

    data = resp.json()
    try:
        choice = data["choices"][0]
        content = choice["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise _ProviderError(f"{label} malformed response: {exc!r}") from exc

    if not content.strip():
        # A reasoning model can spend its whole max_tokens budget on invisible
        # chain-of-thought and finish with finish_reason="length" before writing
        # any content - that's a real failure to produce output, not a valid
        # empty response, so it must retry the next provider like any other
        # transient failure instead of silently returning "".
        raise _ProviderError(f"{label} returned empty content (finish_reason={choice.get('finish_reason')!r})")

    return content


async def _openai_compat_stream(
    prompt: str, system: str, max_tokens: int,
    base_url: str, api_key: str, model: str, label: str,
) -> AsyncGenerator[str, None]:
    if not api_key:
        raise _ProviderUnavailable(f"{label}: API key not configured")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    # No client-level timeout on streams — long-running by nature. We rely on the
    # server to terminate; connect timeout still applies.
    timeout = httpx.Timeout(connect=15.0, read=None, write=15.0, pool=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            async with client.stream(
                "POST",
                f"{base_url}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model, "messages": messages,
                    "max_tokens": max_tokens, "temperature": 0.7, "stream": True,
                },
            ) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    raise _ProviderError(f"{label} HTTP {resp.status_code}: {body[:200]!r}")

                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    payload = line[6:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                        delta = chunk["choices"][0]["delta"].get("content")
                        if delta:
                            yield delta
                    except (json.JSONDecodeError, KeyError, IndexError):
                        # Skip malformed SSE frames silently — stream continues.
                        continue
        except httpx.HTTPError as exc:
            raise _ProviderError(f"{label} network error: {exc!r}") from exc


# ── Provider dispatch ────────────────────────────────────────────

def _provider_chain() -> list[str]:
    primary = settings.ai_provider.lower().strip()
    fallbacks = [p.strip().lower() for p in settings.ai_fallback_chain.split(",") if p.strip()]
    chain = [primary] + [p for p in fallbacks if p != primary]
    return chain


def _groq_model(tier: str) -> str:
    return settings.groq_light_model if tier == "light" else settings.groq_model


async def _dispatch_generate(
    provider: str, prompt: str, system: str, max_tokens: int, tier: str, response_format: dict | None = None,
) -> str:
    if provider == "groq":
        return await _openai_compat_generate(
            prompt, system, max_tokens,
            settings.groq_base_url, settings.groq_api_key, _groq_model(tier), "groq",
            response_format=response_format,
        )
    if provider == "openrouter":
        return await _openai_compat_generate(
            prompt, system, max_tokens,
            settings.openrouter_base_url, settings.openrouter_api_key, settings.openrouter_model, "openrouter",
            response_format=response_format,
        )
    raise ValueError(f"Unknown AI provider: {provider!r}")


def _dispatch_stream(provider: str, prompt: str, system: str, max_tokens: int, tier: str) -> AsyncGenerator[str, None]:
    if provider == "groq":
        return _openai_compat_stream(
            prompt, system, max_tokens,
            settings.groq_base_url, settings.groq_api_key, _groq_model(tier), "groq",
        )
    if provider == "openrouter":
        return _openai_compat_stream(
            prompt, system, max_tokens,
            settings.openrouter_base_url, settings.openrouter_api_key, settings.openrouter_model, "openrouter",
        )
    raise ValueError(f"Unknown AI provider: {provider!r}")


# ── Public Interface ─────────────────────────────────────────────

async def _run_chain(
    prompt: str, system: str, max_tokens: int, tier: str, response_format: dict | None = None,
) -> tuple[str, str]:
    """Shared dispatch loop for generate_text/generate_text_with_provider. Returns
    (content, provider_name). Raises AIGenerationError if every provider fails."""
    chain = _provider_chain()
    last_error: Exception | None = None
    for provider in chain:
        try:
            content = await _dispatch_generate(provider, prompt, system, max_tokens, tier, response_format)
            return content, provider
        except _ProviderUnavailable as exc:
            logger.info("ai_provider skip %s: %s", provider, exc)
            last_error = exc
            continue
        except _ProviderRateLimited as exc:
            logger.warning(
                "ai_provider rate-limited on %s, backing off %.1fs before one retry: %s",
                provider, _RATE_LIMIT_BACKOFF_SECONDS, exc,
            )
            last_error = exc
            await asyncio.sleep(_RATE_LIMIT_BACKOFF_SECONDS)
            try:
                content = await _dispatch_generate(provider, prompt, system, max_tokens, tier, response_format)
                return content, provider
            except _ProviderError as retry_exc:
                logger.warning("ai_provider retry after rate limit also failed on %s: %s", provider, retry_exc)
                last_error = retry_exc
                continue
        except _ProviderError as exc:
            logger.warning("ai_provider transient failure on %s: %s", provider, exc)
            last_error = exc
            continue
    raise AIGenerationError(f"All AI providers exhausted ({chain}). Last error: {last_error!r}")


async def generate_text(
    prompt: str, system: str = "", max_tokens: int = 2048, tier: str = "heavy", response_format: dict | None = None,
) -> str:
    content, _ = await _run_chain(prompt, system, max_tokens, tier, response_format)
    return content


async def generate_text_with_provider(
    prompt: str, system: str = "", max_tokens: int = 2048, tier: str = "heavy", response_format: dict | None = None,
) -> tuple[str, str]:
    """Same as generate_text but also returns which provider served the response —
    for callers surfacing provider-level observability (e.g. resume-tailor's
    ai.provider field). Most callers should keep using generate_text."""
    return await _run_chain(prompt, system, max_tokens, tier, response_format)


async def stream_text(prompt: str, system: str = "", max_tokens: int = 2048, tier: str = "heavy") -> AsyncGenerator[str, None]:
    chain = _provider_chain()
    last_error: Exception | None = None

    for provider in chain:
        try:
            gen = _dispatch_stream(provider, prompt, system, max_tokens, tier)
            # Pull the first chunk eagerly so we can fall back on a clean failure
            # before any bytes reach the client.
            first_iter = gen.__aiter__()
            try:
                first_chunk = await first_iter.__anext__()
            except StopAsyncIteration:
                # Provider returned an empty stream — treat as a transient failure.
                last_error = _ProviderError(f"{provider} returned empty stream")
                logger.warning("ai_provider empty stream on %s", provider)
                continue
            yield first_chunk
            async for chunk in first_iter:
                yield chunk
            return
        except _ProviderUnavailable as exc:
            logger.info("ai_provider skip %s: %s", provider, exc)
            last_error = exc
            continue
        except _ProviderError as exc:
            logger.warning("ai_provider transient failure on %s: %s", provider, exc)
            last_error = exc
            continue

    raise AIGenerationError(f"All AI providers exhausted ({chain}). Last error: {last_error!r}")
