from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import requests


@dataclass(frozen=True)
class OpenAiSttConfig:
    api_key: str
    model: str = "gpt-4o-mini-transcribe"
    language: str = "pt"
    base_url: str = "https://api.openai.com/v1"
    timeout_s: float = 60.0


class OpenAiStt:
    def __init__(self, cfg: OpenAiSttConfig) -> None:
        self._cfg = cfg

    def transcribe_wav(self, wav_bytes: bytes) -> str:
        url = f"{self._cfg.base_url.rstrip('/')}/audio/transcriptions"
        headers = {"Authorization": f"Bearer {self._cfg.api_key}"}
        files = {
            "file": ("audio.wav", wav_bytes, "audio/wav"),
        }
        data: dict[str, str] = {
            "model": self._cfg.model,
            "language": self._cfg.language,
        }
        resp = requests.post(
            url,
            headers=headers,
            files=files,
            data=data,
            timeout=self._cfg.timeout_s,
        )
        resp.raise_for_status()
        payload = resp.json()

        # OpenAI returns { "text": "..." } for transcriptions.
        text = payload.get("text")
        if not isinstance(text, str):
            raise RuntimeError("Resposta inesperada do STT (sem campo 'text').")
        return text.strip()

