from __future__ import annotations

import io
import os
import queue
import time
import wave
import base64
from dataclasses import dataclass

import numpy as np
import requests
import sounddevice as sd
import webrtcvad

try:
    import pyttsx3
except Exception:  # noqa: BLE001
    pyttsx3 = None  # type: ignore[assignment]


@dataclass(frozen=True)
class ListenerConfig:
    router_url: str = "http://127.0.0.1:8787"
    activation_mode: str = "hotword"  # hotword|ptt (ptt ainda não implementado no MVP)
    hotword_phrase: str = "jarvis"
    sample_rate_hz: int = 16000
    frame_ms: int = 30
    vad_aggressiveness: int = 2  # 0..3
    max_utterance_s: float = 8.0
    silence_end_ms: int = 450
    speak_reply: bool = True


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def load_cfg() -> ListenerConfig:
    return ListenerConfig(
        router_url=(os.getenv("VOICE_ROUTER_URL") or "http://127.0.0.1:8787").strip(),
        activation_mode=(os.getenv("VOICE_ACTIVATION_MODE") or "hotword").strip().lower(),
        hotword_phrase=(os.getenv("VOICE_HOTWORD_PHRASE") or "jarvis").strip(),
        speak_reply=_env_bool("VOICE_SPEAK_REPLY", True),
    )


def pcm16_to_wav_bytes(pcm: bytes, sample_rate_hz: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate_hz)
        wf.writeframes(pcm)
    return buf.getvalue()


def speak(text: str) -> None:
    if not text.strip():
        return
    if pyttsx3 is None:
        print("[WARN] pyttsx3 não está disponível; resposta será só texto.")
        return
    engine = pyttsx3.init()
    engine.setProperty("rate", 185)
    engine.say(text)
    engine.runAndWait()


def play_wav_bytes(wav_bytes: bytes) -> None:
    with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
        sr = wf.getframerate()
        channels = wf.getnchannels()
        frames = wf.readframes(wf.getnframes())
    audio = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        audio = audio.reshape(-1, channels)
    sd.play(audio, sr)
    sd.wait()


def post_utterance(router_url: str, wav_bytes: bytes, mode: str, hotword_phrase: str) -> dict:
    url = f"{router_url.rstrip('/')}/ingest/audio"
    files = {"file": ("audio.wav", wav_bytes, "audio/wav")}
    data = {"mode": mode, "hotword": hotword_phrase}
    resp = requests.post(url, files=files, data=data, timeout=180)
    resp.raise_for_status()
    return resp.json()


def iter_frames(pcm: bytes, frame_bytes: int):
    for i in range(0, len(pcm), frame_bytes):
        chunk = pcm[i : i + frame_bytes]
        if len(chunk) == frame_bytes:
            yield chunk


def main() -> None:
    cfg = load_cfg()
    print(f"[INFO] Voice listener (Windows) -> {cfg.router_url}")
    print(f"[INFO] mode={cfg.activation_mode} hotword='{cfg.hotword_phrase}' sr={cfg.sample_rate_hz}")

    if cfg.activation_mode == "ptt":
        print("[INFO] Push-to-talk: pressione ENTER para começar a gravar; ENTER novamente para enviar.")
        _run_push_to_talk(cfg)
        return

    vad = webrtcvad.Vad(cfg.vad_aggressiveness)
    frame_bytes = int(cfg.sample_rate_hz * (cfg.frame_ms / 1000.0) * 2)

    q: queue.Queue[bytes] = queue.Queue()

    def callback(indata, frames, time_info, status):  # noqa: ANN001
        if status:
            # status is a sounddevice.CallbackFlags
            pass
        q.put(indata.tobytes())

    in_speech = False
    utterance = bytearray()
    last_voiced = 0.0
    utterance_start = 0.0

    with sd.InputStream(
        samplerate=cfg.sample_rate_hz,
        channels=1,
        dtype="int16",
        blocksize=int(cfg.sample_rate_hz * (cfg.frame_ms / 1000.0)),
        callback=callback,
    ):
        print("[INFO] Escutando... (Ctrl+C para sair)")
        while True:
            chunk = q.get()
            now = time.time()
            for frame in iter_frames(chunk, frame_bytes):
                is_voiced = vad.is_speech(frame, cfg.sample_rate_hz)
                if is_voiced:
                    last_voiced = now
                    if not in_speech:
                        in_speech = True
                        utterance_start = now
                        utterance = bytearray()
                if in_speech:
                    utterance.extend(frame)

                # corta por silêncio após ter falado
                if in_speech:
                    silence_ms = max(0, int((now - last_voiced) * 1000))
                    dur_s = now - utterance_start
                    if silence_ms >= cfg.silence_end_ms or dur_s >= cfg.max_utterance_s:
                        in_speech = False
                        wav_bytes = pcm16_to_wav_bytes(bytes(utterance), cfg.sample_rate_hz)
                        try:
                            res = post_utterance(
                                cfg.router_url, wav_bytes, cfg.activation_mode, cfg.hotword_phrase
                            )
                            if res.get("ignored"):
                                print(f"[IGNORED] {res.get('reason')} :: {res.get('transcript','')}")
                            else:
                                transcript = res.get("transcript", "")
                                reply = res.get("replyText", "")
                                print(f"[YOU] {transcript}")
                                print(f"[BOT] {reply}")
                                audio_b64 = res.get("replyAudioWavBase64")
                                if isinstance(audio_b64, str) and audio_b64:
                                    try:
                                        play_wav_bytes(base64.b64decode(audio_b64))
                                    except Exception:
                                        # se falhar, ainda tenta TTS fallback
                                        pass
                                if cfg.speak_reply:
                                    speak(reply)
                        except Exception as e:  # noqa: BLE001
                            print(f"[ERR] {e}")


def _run_push_to_talk(cfg: ListenerConfig) -> None:
    """
    MVP simples (sem hotkey global):
    - ENTER inicia gravação
    - ENTER encerra e envia
    """
    recorded = bytearray()
    recording = False

    def callback(indata, frames, time_info, status):  # noqa: ANN001
        nonlocal recorded, recording
        if not recording:
            return
        recorded.extend(indata.tobytes())

    stream = sd.InputStream(
        samplerate=cfg.sample_rate_hz,
        channels=1,
        dtype="int16",
        callback=callback,
    )
    stream.start()
    try:
        while True:
            _ = input()
            if not recording:
                print("[REC] gravando... (ENTER para parar)")
                recording = True
                recorded = bytearray()
                continue

            recording = False
            print("[SEND] enviando...")
            wav_bytes = pcm16_to_wav_bytes(bytes(recorded), cfg.sample_rate_hz)
            try:
                res = post_utterance(cfg.router_url, wav_bytes, "ptt", cfg.hotword_phrase)
                if res.get("ignored"):
                    print(f"[IGNORED] {res.get('reason')} :: {res.get('transcript','')}")
                    continue
                transcript = res.get("transcript", "")
                reply = res.get("replyText", "")
                print(f"[YOU] {transcript}")
                print(f"[BOT] {reply}")
                audio_b64 = res.get("replyAudioWavBase64")
                if isinstance(audio_b64, str) and audio_b64:
                    try:
                        play_wav_bytes(base64.b64decode(audio_b64))
                    except Exception:
                        pass
                if cfg.speak_reply:
                    speak(reply)
            except Exception as e:  # noqa: BLE001
                print(f"[ERR] {e}")
    finally:
        stream.stop()
        stream.close()


if __name__ == "__main__":
    main()

