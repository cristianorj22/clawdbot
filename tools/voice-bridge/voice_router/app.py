from __future__ import annotations

import os
import base64
import time
from dataclasses import dataclass

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

from .clawdbot_client import ClawdbotClient, ClawdbotClientConfig
from .personaplex_offline import PersonaPlexOfflineConfig, run_personaplex_offline
from .stt_openai import OpenAiStt, OpenAiSttConfig


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


def _get_env(name: str, default: str) -> str:
    value = (os.getenv(name) or "").strip()
    return value if value else default


def _normalize_space(text: str) -> str:
    return " ".join(text.strip().split())


def _starts_with_hotword(transcript: str, hotword: str) -> tuple[bool, str]:
    t = transcript.strip()
    h = hotword.strip()
    if not h:
        return True, t

    t_norm = t.lower()
    h_norm = h.lower()
    if not t_norm.startswith(h_norm):
        return False, t

    rest = t[len(h) :].strip()
    # optional punctuation after hotword: "jarvis," / "jarvis:"
    rest = rest.lstrip(" ,:;-").strip()
    return True, rest


app = FastAPI(title="Clawdbot Voice Router", version="0.1.0")


@dataclass(frozen=True)
class RouterConfig:
    activation_mode: str
    hotword_phrase: str
    personaplex_enabled: bool
    personaplex_url: str | None
    personaplex_mode: str


def _load_router_config() -> RouterConfig:
    activation_mode = _get_env("VOICE_ACTIVATION_MODE", "hotword")  # hotword|ptt
    hotword_phrase = _get_env("VOICE_HOTWORD_PHRASE", "jarvis")
    personaplex_enabled = _get_env("VOICE_PERSONAPLEX_ENABLED", "0") in ("1", "true", "yes", "on")
    personaplex_url = (os.getenv("PERSONAPLEX_URL") or "").strip() or None
    personaplex_mode = _get_env("PERSONAPLEX_MODE", "disabled")  # disabled|offline|server
    return RouterConfig(
        activation_mode=activation_mode,
        hotword_phrase=hotword_phrase,
        personaplex_enabled=personaplex_enabled,
        personaplex_url=personaplex_url,
        personaplex_mode=personaplex_mode,
    )


def _build_clients() -> tuple[ClawdbotClient, OpenAiStt, RouterConfig]:
    router_cfg = _load_router_config()
    claw = ClawdbotClient(
        ClawdbotClientConfig(
            gateway_url=_get_env("CLAWDBOT_GATEWAY_URL", "http://127.0.0.1:18789"),
            token=_require_env("CLAWDBOT_GATEWAY_TOKEN"),
            agent_id=_get_env("CLAWDBOT_AGENT_ID", "main"),
            user=_get_env("CLAWDBOT_VOICE_USER", "pc-voice"),
            timeout_s=float(_get_env("CLAWDBOT_TIMEOUT_S", "120")),
        )
    )
    stt = OpenAiStt(
        OpenAiSttConfig(
            api_key=_require_env("OPENAI_API_KEY"),
            model=_get_env("OPENAI_STT_MODEL", "gpt-4o-mini-transcribe"),
            language=_get_env("VOICE_LANGUAGE", "pt"),
            timeout_s=float(_get_env("OPENAI_STT_TIMEOUT_S", "90")),
        )
    )
    return claw, stt, router_cfg


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/ingest/text")
async def ingest_text(payload: dict) -> JSONResponse:
    try:
        claw, _, _ = _build_clients()
        text = payload.get("text")
        if not isinstance(text, str) or not text.strip():
            return JSONResponse(status_code=400, content={"ok": False, "error": "missing text"})

        reply = claw.chat(_normalize_space(text))
        return JSONResponse(status_code=200, content={"ok": True, "replyText": reply})
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@app.post("/ingest/audio")
async def ingest_audio(
    file: UploadFile = File(...),
    mode: str | None = Form(default=None),
    hotword: str | None = Form(default=None),
) -> JSONResponse:
    """
    Recebe WAV/PCM e executa o pipeline:
    - STT
    - (opcional) gate por hotword-frase
    - Clawdbot chat completions
    - (opcional) PersonaPlex TTS (fase 2)
    """
    try:
        claw, stt, cfg = _build_clients()
        router_mode = (mode or cfg.activation_mode).strip().lower()
        hotword_phrase = (hotword or cfg.hotword_phrase).strip()

        content = await file.read()
        if not content:
            return JSONResponse(status_code=400, content={"ok": False, "error": "empty file"})

        t0 = time.time()
        transcript = stt.transcribe_wav(content)
        stt_ms = int((time.time() - t0) * 1000)
        if not transcript:
            return JSONResponse(status_code=200, content={"ok": True, "ignored": True, "reason": "empty transcript"})

        if router_mode == "hotword":
            ok, rest = _starts_with_hotword(transcript, hotword_phrase)
            if not ok:
                return JSONResponse(
                    status_code=200,
                    content={
                        "ok": True,
                        "ignored": True,
                        "reason": "hotword_not_present",
                        "transcript": transcript,
                    },
                )
            prompt_text = rest if rest else ""
        else:
            prompt_text = transcript

        prompt_text = _normalize_space(prompt_text)
        if not prompt_text:
            return JSONResponse(status_code=200, content={"ok": True, "ignored": True, "reason": "no command after hotword"})

        t1 = time.time()
        reply = claw.chat(prompt_text)
        claw_ms = int((time.time() - t1) * 1000)

        # Fase 2 (opcional): PersonaPlex.
        # Nota: PersonaPlex é speech-to-speech. Para manter o Clawdbot desacoplado,
        # usamos 2 estratégias:
        # - MVP: resposta falada via fallback no Windows (SAPI) → sempre disponível.
        # - Opcional: PersonaPlex offline para “fala” (limitação: duração ~ input).
        personaplex_payload = {
            "enabled": cfg.personaplex_enabled,
            "mode": cfg.personaplex_mode,
            "url": cfg.personaplex_url,
            "status": "disabled",
        }

        reply_audio_b64: str | None = None
        if cfg.personaplex_enabled and cfg.personaplex_mode == "offline":
            hf_token = (os.getenv("HF_TOKEN") or os.getenv("PERSONAPLEX_HF_TOKEN") or "").strip()
            if not hf_token:
                personaplex_payload["status"] = "missing_hf_token"
            else:
                voice_prompt = _get_env("PERSONAPLEX_VOICE_PROMPT", "NATM1.pt")
                text_prompt = _get_env(
                    "PERSONAPLEX_TEXT_PROMPT",
                    "You enjoy having a good conversation.",
                )
                cpu_offload = _get_env("PERSONAPLEX_CPU_OFFLOAD", "0") in ("1", "true", "yes", "on")
                t2 = time.time()
                wav_bytes, _ = run_personaplex_offline(
                    PersonaPlexOfflineConfig(
                        hf_token=hf_token,
                        voice_prompt=voice_prompt,
                        text_prompt=text_prompt,
                        cpu_offload=cpu_offload,
                    ),
                    input_wav=content,
                )
                personaplex_payload["latencyMs"] = int((time.time() - t2) * 1000)
                # Para evitar payloads gigantes: 2MB (best-effort).
                if len(wav_bytes) <= 2_000_000:
                    reply_audio_b64 = base64.b64encode(wav_bytes).decode("ascii")
                    personaplex_payload["status"] = "ok"
                else:
                    personaplex_payload["status"] = "audio_too_large"

        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "mode": router_mode,
                "transcript": transcript,
                "promptText": prompt_text,
                "replyText": reply,
                "latencyMs": {"stt": stt_ms, "clawdbot": claw_ms},
                "replyAudioWavBase64": reply_audio_b64,
                "personaplex": personaplex_payload,
            },
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})

