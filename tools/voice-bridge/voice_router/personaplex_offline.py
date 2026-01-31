from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass


@dataclass(frozen=True)
class PersonaPlexOfflineConfig:
    hf_token: str
    voice_prompt: str = "NATM1.pt"
    text_prompt: str = "You enjoy having a good conversation."
    seed: int = 42424242
    python_exe: str = "python"
    cpu_offload: bool = False


def run_personaplex_offline(cfg: PersonaPlexOfflineConfig, input_wav: bytes) -> tuple[bytes, str]:
    """
    Integração opcional baseada na doc oficial do PersonaPlex:
    - Executa `python -m moshi.offline` e retorna (wav_bytes, output_text_raw).

    Observação importante (limitação do upstream):
    o offline gera um output wav com a mesma duração do input wav.
    """
    with tempfile.TemporaryDirectory(prefix="personaplex-") as td:
        in_wav = os.path.join(td, "input.wav")
        out_wav = os.path.join(td, "output.wav")
        out_json = os.path.join(td, "output.json")
        with open(in_wav, "wb") as f:
            f.write(input_wav)

        env = os.environ.copy()
        env["HF_TOKEN"] = cfg.hf_token

        args = [
            cfg.python_exe,
            "-m",
            "moshi.offline",
            "--voice-prompt",
            cfg.voice_prompt,
            "--text-prompt",
            cfg.text_prompt,
            "--input-wav",
            in_wav,
            "--seed",
            str(cfg.seed),
            "--output-wav",
            out_wav,
            "--output-text",
            out_json,
        ]
        if cfg.cpu_offload:
            args.insert(3, "--cpu-offload")

        proc = subprocess.run(args, env=env, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                "PersonaPlex offline falhou.\n"
                f"stdout:\n{proc.stdout}\n\nstderr:\n{proc.stderr}"
            )

        with open(out_wav, "rb") as f:
            wav_bytes = f.read()

        # A estrutura do JSON pode mudar; tratamos como “best effort”.
        output_text = ""
        try:
            with open(out_json, "rb") as f:
                payload = json.loads(f.read().decode("utf-8", errors="replace"))
            if isinstance(payload, dict):
                # heurísticas comuns
                for key in ("text", "output_text", "transcript", "decoded_text"):
                    val = payload.get(key)
                    if isinstance(val, str) and val.strip():
                        output_text = val.strip()
                        break
        except Exception:
            output_text = ""

        return wav_bytes, output_text

