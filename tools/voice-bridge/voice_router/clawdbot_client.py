from __future__ import annotations

from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class ClawdbotClientConfig:
    gateway_url: str
    token: str
    agent_id: str = "main"
    user: str = "pc-voice"
    timeout_s: float = 60.0


class ClawdbotClient:
    def __init__(self, cfg: ClawdbotClientConfig) -> None:
        self._cfg = cfg

    def chat(self, text: str) -> str:
        url = f"{self._cfg.gateway_url.rstrip('/')}/v1/chat/completions"
        payload = {
            "model": f"clawdbot:{self._cfg.agent_id}",
            "user": self._cfg.user,
            "messages": [{"role": "user", "content": text}],
        }
        headers = {
            "Authorization": f"Bearer {self._cfg.token}",
            "Content-Type": "application/json",
            "x-clawdbot-agent-id": self._cfg.agent_id,
        }
        resp = requests.post(url, json=payload, headers=headers, timeout=self._cfg.timeout_s)
        resp.raise_for_status()
        data = resp.json()
        choices = data.get("choices") or []
        msg = (choices[0] if choices else {}).get("message") or {}
        content = msg.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("Resposta vazia do gateway (/v1/chat/completions).")
        return content.strip()

