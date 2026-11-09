import json
from types import SimpleNamespace

import pytest
from PIL import Image

import extract
from extract import ExtractionError, MissingApiKeyError, extract_receipt
from fakes import FakeClient

GOOD = {
    "merchant": "Cafe",
    "date": "2026-01-02",
    "items": [{"name": "Latte", "qty": 1, "unit_price": 4.0, "total": 4.0}],
    "subtotal": 4.0,
    "tax": 0.3,
    "tip": None,
    "total": 4.3,
}


@pytest.fixture
def img(tmp_path):
    p = tmp_path / "r.jpg"
    Image.new("RGB", (50, 50), "white").save(p)
    return p


def test_first_attempt_success(img):
    client = FakeClient([json.dumps(GOOD)])
    r = extract_receipt(img, client=client)
    assert r.merchant == "Cafe"
    assert len(client.messages.calls) == 1


def test_request_shape(img):
    client = FakeClient([json.dumps(GOOD)])
    extract_receipt(img, client=client, model="m-1")
    call = client.messages.calls[0]
    assert call["model"] == "m-1"
    assert call["system"] == extract.SYSTEM_PROMPT
    block = call["messages"][0]["content"][0]
    assert block["type"] == "image"
    assert block["source"]["media_type"] == "image/jpeg"
    assert block["source"]["data"]


def test_model_from_env(img, monkeypatch):
    monkeypatch.setenv("RECEIPT_MODEL", "env-model")
    client = FakeClient([json.dumps(GOOD)])
    extract_receipt(img, client=client)
    assert client.messages.calls[0]["model"] == "env-model"


def test_default_model(img):
    client = FakeClient([json.dumps(GOOD)])
    extract_receipt(img, client=client)
    assert client.messages.calls[0]["model"] == extract.DEFAULT_MODEL


def test_retry_fixes_invalid_json_on_second_attempt(img):
    bad = json.dumps({**GOOD, "subtotal": "n/a"})
    client = FakeClient([bad, json.dumps(GOOD)])
    r = extract_receipt(img, client=client)
    assert str(r.total) == "4.3"
    assert len(client.messages.calls) == 2
    retry = client.messages.calls[1]["messages"]
    assert retry[1] == {"role": "assistant", "content": bad}
    assert "subtotal" in retry[2]["content"]
    assert "not valid" in retry[2]["content"]


def test_retry_on_non_json_prose(img):
    client = FakeClient(["Sorry, I can't read it", json.dumps(GOOD)])
    assert extract_receipt(img, client=client).merchant == "Cafe"


def test_clear_error_after_second_failure(img):
    client = FakeClient(["nope", '{"merchant": "x"}'])
    with pytest.raises(ExtractionError, match="after 2 attempts") as exc:
        extract_receipt(img, client=client)
    assert "items" in str(exc.value)
    assert len(client.messages.calls) == 2  # exactly one retry, no more


def test_empty_reply_is_retried(img):
    client = FakeClient(["", json.dumps(GOOD)])
    assert extract_receipt(img, client=client).merchant == "Cafe"
    assert client.messages.calls[1]["messages"][1]["content"] == "(empty reply)"


def test_ignores_non_text_blocks():
    resp = SimpleNamespace(
        content=[SimpleNamespace(type="thinking", thinking="hm"), SimpleNamespace(type="text", text="{}")]
    )
    assert extract._response_text(resp) == "{}"


def test_missing_api_key_message(monkeypatch):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    with pytest.raises(MissingApiKeyError, match="ANTHROPIC_API_KEY is not set"):
        extract.get_client()


def test_blank_api_key_counts_as_missing(monkeypatch):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    with pytest.raises(MissingApiKeyError):
        extract.get_client()


def test_get_client_with_key(monkeypatch):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    client = extract.get_client()
    assert client.api_key == "sk-test"


def test_missing_key_checked_before_any_work(tmp_path, monkeypatch):
    monkeypatch.setattr(extract, "load_dotenv", lambda: None)
    # No client given and no key: fail with the key message, not an image error.
    with pytest.raises(MissingApiKeyError):
        extract_receipt(tmp_path / "x.jpg")
