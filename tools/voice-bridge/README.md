# Voice Bridge (Windows + WSL2) — hotword/push-to-talk para Clawdbot

Este diretório adiciona um **cliente/bridge externo** para habilitar voz no PC (Windows) sem alterar a essência do Clawdbot.

- **Clawdbot** continua sendo o executor (tools/skills) via **HTTP** (`POST /v1/chat/completions`).
- **Voice Bridge** cuida de: microfone, ativação (hotword/push-to-talk), STT, roteamento, playback.
- **PersonaPlex** é **opcional** (feature flag). Enquanto ele não estiver estável, o bridge usa fallback (voz do Windows/SAPI).

## Componentes

- `voice_router/` (WSL2): servidor local que recebe áudio/texto, transcreve, chama o Clawdbot e devolve a resposta.
- `windows_listener/` (Windows): captura microfone e envia “utterances” para o `voice_router` (modo hotword frase ou push-to-talk).

## Requisitos (MVP)

### No Windows
- Python 3.11+ instalado
- Microfone funcional

### No WSL2 (Ubuntu recomendado)
- Python 3.11+ instalado
- Acesso ao Gateway do Clawdbot (normalmente `http://127.0.0.1:18789`)

## Variáveis de ambiente (VoiceRouter)

Defina no WSL2 (ou em `.env` do seu shell no WSL2):

- `CLAWDBOT_GATEWAY_URL` (ex.: `http://127.0.0.1:18789`)
- `CLAWDBOT_GATEWAY_TOKEN` (o mesmo do seu `.env` do Docker)
- `CLAWDBOT_AGENT_ID` (default `main`)
- `OPENAI_API_KEY` (para STT via OpenAI; MVP)
- `OPENAI_STT_MODEL` (default `gpt-4o-mini-transcribe`)

Feature flags:
- `VOICE_PERSONAPLEX_ENABLED=0|1` (default `0`)
- `VOICE_ACTIVATION_MODE=hotword|ptt` (default `hotword`)
- `VOICE_HOTWORD_PHRASE=jarvis` (default `jarvis`)
- `PERSONAPLEX_MODE=disabled|offline|server` (default `disabled`)

PersonaPlex (offline mode):
- `PERSONAPLEX_HF_TOKEN` (ou `HF_TOKEN`)
- `PERSONAPLEX_VOICE_PROMPT` (ex.: `NATM1.pt`)
- `PERSONAPLEX_TEXT_PROMPT` (prompt de persona)
- `PERSONAPLEX_CPU_OFFLOAD=0|1`

## Como rodar (WSL2)

No WSL2, dentro do repo:

```bash
cd /mnt/c/Users/Cristiano/clawdbot/tools/voice-bridge
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt

uvicorn voice_router.app:app --host 0.0.0.0 --port 8787
```

Teste rápido:

```bash
curl -sS http://127.0.0.1:8787/health
```

## Como rodar (Docker) — recomendado para o VoiceRouter

O `voice_router` roda muito bem em container (é só HTTP + STT + chamada ao Gateway). Isso mantém dependências travadas e simplifica restart/logs.

No PowerShell (Windows):

```powershell
cd C:\Users\Cristiano\clawdbot
docker compose -f docker-compose.yml -f docker-compose.voice-bridge.yml up -d --build voice-router
```

Teste:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Depois, no listener do Windows, a URL padrão já é `http://127.0.0.1:8787` (env `VOICE_ROUTER_URL`).

## Segurança (importante)

- **Não exponha** o Gateway do Clawdbot na LAN sem precisar. Prefira `bind=loopback`.
- O `CLAWDBOT_GATEWAY_TOKEN` deve ficar em **variável de ambiente** / store seguro (Windows Credential Manager), não em arquivos versionados.
- O `VoiceRouter` é um serviço local: mantenha em `127.0.0.1`/rede confiável.

## Como rodar (Windows)

No Windows (PowerShell):

```powershell
cd C:\Users\Cristiano\clawdbot\tools\voice-bridge
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

py -m windows_listener.listener
```

O listener envia áudio para `http://127.0.0.1:8787` por padrão.

### Alternar hotword vs push-to-talk

- Hotword (padrão):
  - `setx VOICE_ACTIVATION_MODE hotword`
- Push-to-talk (MVP):
  - `setx VOICE_ACTIVATION_MODE ptt`
  - No modo `ptt`, o listener usa **ENTER** para iniciar/parar (atalho global pode ser adicionado depois sem mudar o Clawdbot).

## Como funciona a “hotword”

No MVP, o modo **hotword** é “hotword por frase”:
- o listener segmenta fala (VAD),
- envia o áudio para o router,
- o router transcreve,
- **só aciona o Clawdbot se o texto começar com `jarvis`** (configurável).

Isso evita depender de um modelo dedicado de wakeword logo de início e mantém o recurso desacoplado.

## PersonaPlex (fase 2)

Quando `VOICE_PERSONAPLEX_ENABLED=1`, o `voice_router` passa a tentar usar PersonaPlex para saída de voz.

Documentação oficial do PersonaPlex:
- https://github.com/NVIDIA/personaplex

### Integração implementada (opcional): PersonaPlex offline

Para validar rapidamente com o mínimo acoplamento, o `VoiceRouter` suporta um modo opcional `offline` que chama:

```bash
python -m moshi.offline ...
```

Isso segue a doc oficial, mas tem uma limitação do upstream: o áudio de saída tende a ter duração semelhante ao input.
Mesmo assim, é útil para validar GPU/stack e pipeline de áudio antes de evoluir para o modo server/full-duplex.

Exemplo (no WSL2, em um ambiente onde `moshi` esteja instalado):

```bash
export VOICE_PERSONAPLEX_ENABLED=1
export PERSONAPLEX_MODE=offline
export PERSONAPLEX_HF_TOKEN=...
```

## Browser Relay no Windows (auto start)

Se você usa Edge/Chrome extension para controlar abas (Instagram, etc.), o relay precisa rodar no Windows.
Para automatizar (Task Scheduler), rode:

```powershell
cd C:\Users\Cristiano\clawdbot\tools\voice-bridge\windows_setup
.\setup-browser-relay.ps1
```

Esse setup tenta criar uma tarefa no Task Scheduler. Se o Windows negar permissão, ele cria um fallback no Startup folder:
- `clawdbot-browser-relay.cmd` em `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`

Em ambos os casos, o relay sobe automaticamente no login do Windows.

Logs do relay (para debug):
- `%LOCALAPPDATA%\\clawdbot-browser-relay\\relay.log`

