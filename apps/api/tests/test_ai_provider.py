"""Unit tests for app.ai.llm.provider's chain dispatch — specifically the
429 backoff-and-retry behavior. httpx.AsyncClient.post is monkeypatched
directly (no network access); asyncio.sleep is monkeypatched to a no-op so
the retry test doesn't actually wait."""

import httpx

from app.ai.llm import provider
from app.core.config import settings


def _response(status_code: int, content: str = "") -> httpx.Response:
    if status_code >= 400:
        return httpx.Response(status_code, text="rate limited")
    body = {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}
    return httpx.Response(status_code, json=body)


def _patch_settings(monkeypatch):
    monkeypatch.setattr(settings, "ai_provider", "groq")
    monkeypatch.setattr(settings, "ai_fallback_chain", "openrouter")
    monkeypatch.setattr(settings, "groq_api_key", "test-groq-key")
    monkeypatch.setattr(settings, "openrouter_api_key", "test-openrouter-key")


async def test_run_chain_retries_same_provider_once_after_429_then_succeeds(monkeypatch):
    _patch_settings(monkeypatch)

    sleep_calls = []

    async def fake_sleep(seconds):
        sleep_calls.append(seconds)

    monkeypatch.setattr(provider.asyncio, "sleep", fake_sleep)

    responses = [_response(429), _response(200, "hello")]

    async def fake_post(self, url, headers=None, json=None):
        return responses.pop(0)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    content, used_provider = await provider._run_chain("prompt", "system", 100, "heavy")

    assert content == "hello"
    assert used_provider == "groq"
    assert sleep_calls == [provider._RATE_LIMIT_BACKOFF_SECONDS]
    assert responses == []


async def test_run_chain_falls_through_to_next_provider_if_retry_also_rate_limited(monkeypatch):
    _patch_settings(monkeypatch)

    async def fake_sleep(seconds):
        return None

    monkeypatch.setattr(provider.asyncio, "sleep", fake_sleep)

    # groq: 429, retry: 429 again -> falls through to openrouter: 200
    responses = [_response(429), _response(429), _response(200, "from openrouter")]

    async def fake_post(self, url, headers=None, json=None):
        return responses.pop(0)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    content, used_provider = await provider._run_chain("prompt", "system", 100, "heavy")

    assert content == "from openrouter"
    assert used_provider == "openrouter"
    assert responses == []


async def test_run_chain_raises_after_all_providers_exhausted_on_429(monkeypatch):
    _patch_settings(monkeypatch)

    async def fake_sleep(seconds):
        return None

    monkeypatch.setattr(provider.asyncio, "sleep", fake_sleep)

    # groq initial 429, groq retry 429 -> openrouter initial 429, openrouter retry 429 -> exhausted
    responses = [_response(429), _response(429), _response(429), _response(429)]

    async def fake_post(self, url, headers=None, json=None):
        return responses.pop(0)

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    try:
        await provider._run_chain("prompt", "system", 100, "heavy")
        assert False, "expected AIGenerationError"
    except provider.AIGenerationError:
        pass

    assert responses == []
