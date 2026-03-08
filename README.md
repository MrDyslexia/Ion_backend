# ALMA — Asistente Lingüístico de Monitoreo Amigable

Sistema de voz en tiempo real con transcripción offline, conversación por IA local y síntesis de voz. Diseñado para evaluar el estado cognitivo del usuario a través de una secuencia guiada de preguntas.

---

## Arquitectura

```
Micrófono (browser)
       │  PCM 16kHz via Socket.IO
       ▼
  server.js (Node.js)
       │
       ├── Vosk STT ──────────► Transcripción en tiempo real (25ms)
       │
       ├── ConversationManager ► Detección de comandos de voz
       │                         "Hola ALMA" / "Gracias ALMA"
       │
       ├── Ollama LLM ─────────► Respuesta streaming (qwen2.5:7b)
       │
       └── TTS (Python) ───────► Síntesis de voz XTTS-v2 (puerto 8002)
```

---

## Requisitos

- **Node.js** v18+ (recomendado v20 LTS — Node 24 requiere `--ignore-scripts`)
- **Ollama** con modelo `qwen2.5:7b-instruct`
- **Python 3.10+** con FastAPI (solo para TTS, opcional)
- Modelo Vosk español descargado

---

## Instalación

### 1. Clonar e instalar dependencias

```bash
git clone <repo>
cd Ion_backend/src

# Node 20 LTS (recomendado)
npm install

# Node 24+ (ffi-napi no compila con Node 24 — usar --ignore-scripts)
npm install --ignore-scripts
```

### 2. Descargar modelo Vosk (español)

```bash
npm run model
```

Esto descarga y extrae `vosk-model-es-0.42` (~1.8 GB) en `src/models/`.

Si la descarga automática falla, descarga manualmente desde [alphacephei.com/vosk/models](https://alphacephei.com/vosk/models) y extrae en:

```
src/models/vosk-model-es-0.42/
```

### 3. Iniciar Ollama

```bash
# Instalar Ollama: https://ollama.com
ollama pull qwen2.5:7b-instruct

# En una terminal separada:
npm run ia   # equivale a: ollama serve
```

### 4. Iniciar el servidor

```bash
npm start        # producción
npm run dev      # desarrollo con auto-reload (nodemon)
```

El servidor queda disponible en `http://localhost:3000`.

---

## Configuración (.env)

Crea un archivo `.env` en `src/` (opcional — hay valores por defecto):

```env
PORT=3000
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=qwen2.5:7b-instruct
LLM_MAX_TOKENS=512
TTS_URL=http://localhost:8002/synthesize
```

---

## Uso

1. Abrir `http://localhost:3000` en el navegador
2. Permitir acceso al micrófono
3. Hacer clic en **Iniciar Grabación**
4. Hablar — la transcripción aparece en tiempo real

### Comandos de voz

| Comando | Acción |
|---|---|
| `"Hola ALMA"` | Activa la conversación con la IA |
| `"Hola ALMA, ¿qué hora es?"` | Activa y envía pregunta directamente |
| `"Gracias ALMA"` | Finaliza la conversación |
| `"Adiós ALMA"` | Finaliza la conversación |
| `"Detente ALMA"` | Finaliza la conversación |

Cuando la conversación está activa, todo lo que se diga se envía al LLM automáticamente al detectar una pausa.

---

## Protocolo de evaluación cognitiva

ALMA guía al usuario por una secuencia de 7 pasos después de la primera interacción:

1. ¿Qué año es?
2. ¿Qué mes es?
3. Repetir una dirección de memoria
4. ¿Qué hora es aproximadamente?
5. Contar hacia atrás desde 20 hasta 1
6. Decir los meses del año en orden inverso
7. Repetir la dirección memorizada en el paso 3

---

## API REST

| Endpoint | Descripción |
|---|---|
| `GET /` | Interfaz web |
| `GET /stats` | Estadísticas del servidor |
| `GET /transcriptions` | Últimas 10 transcripciones guardadas |
| `GET /transcription/:filename` | Transcripción completa con diálogo |
| `GET /conversations/active` | Conversaciones activas en este momento |
| `POST /conversations/reset-all` | Reinicia todas las conversaciones activas |
| `GET /test` | Health check |

---

## Eventos Socket.IO

### Cliente → Servidor

| Evento | Payload | Descripción |
|---|---|---|
| `audio_chunk` | `{ chunk: Int16Array }` | Chunk de audio PCM 16kHz |
| `start_recording` | — | Inicia grabación y writer WAV |
| `stop_recording` | — | Detiene grabación, dispara LLM si hay texto |
| `get_final_transcription` | — | Fuerza resultado final de Vosk |
| `reset_conversation` | — | Reinicia el historial del diálogo |

### Servidor → Cliente

| Evento | Payload | Descripción |
|---|---|---|
| `connected` | config | Confirmación de conexión con parámetros |
| `transcription` | `{ text, isFinal }` | Texto transcripto (parcial o final) |
| `voice_command_detected` | `{ action, text }` | Comando de voz reconocido |
| `assistant_status` | `{ status }` | `thinking` / `idle` |
| `assistant_text` | `{ delta }` | Fragmento de respuesta LLM (streaming) |
| `assistant_text_done` | `{ text }` | Respuesta LLM completa |
| `server_stats` | stats | Estadísticas cada 2s |
| `audio_ack` | stats | Confirmación cada 10 chunks |

---

## Estructura del proyecto

```
Ion_backend/
├── audio/                        # Grabaciones WAV y transcripciones JSON
└── src/
    ├── server.js                 # Servidor principal
    ├── download-model.js         # Script descarga modelo Vosk
    ├── package.json
    ├── .env                      # Variables de entorno (crear manualmente)
    ├── models/
    │   └── vosk-model-es-0.42/   # Modelo STT español (~1.8 GB)
    └── public/
        └── index.html            # Interfaz web
```

---

## Notas de compatibilidad

**Node 24+**: `ffi-napi` (dependencia transitiva de `vosk`) no compila con Node 24 debido a cambios en la API nativa. Usar siempre:

```bash
npm install --ignore-scripts
```

Vosk incluye binarios precompilados que no requieren compilación, por lo que `--ignore-scripts` no afecta su funcionamiento.

**Node 20 LTS**: instalación normal con `npm install` sin flags adicionales.

-----
# ALMA — Asistente Lingüístico de Monitoreo Amigable

Sistema de voz en tiempo real para evaluación cognitiva de pacientes. Combina reconocimiento de voz (Vosk), LLM local (Ollama) y síntesis de voz (XTTS-v2) en un pipeline completo.

---

## Arquitectura

```
[Navegador] ──WebSocket──► [Servidor Node.js / Fedora Linux]
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                  [Vosk]        [Ollama]        [XTTS-v2]
              STT offline     LLM GPU       TTS GPU
              (CPU, local)  (WSL2/Windows) (WSL2/Windows)
```

**Equipo 1 — Servidor Linux (Fedora)**
- Node.js + Socket.IO
- Vosk STT (español, offline, CPU)
- SQLite via sql.js

**Equipo 2 — Windows con WSL2 (Ubuntu 24.04)**
- Ollama con qwen2.5:7b (GPU)
- XTTS-v2 FastAPI microservicio (GPU)
- RTX 5070 Ti — 16GB VRAM

---

## Tiempos de respuesta medidos

| Componente | Tiempo |
|---|---|
| STT (Vosk) | 70–200ms |
| LLM primer token | ~300–500ms (GPU) |
| LLM respuesta completa | ~2–4s (GPU) |
| TTS síntesis | ~1.5–3s (GPU) |

---

## Requisitos

### Servidor Linux
- Node.js v20+ (recomendado via nvm)
- `nodemon` (devDependency)

### Equipo Windows / WSL2
- Windows 10/11 con WSL2 habilitado
- Ubuntu 24.04 en WSL2
- GPU NVIDIA con driver ≥ 595 y CUDA 12.8+
- Python 3.12
- FFmpeg instalado en WSL2

---

## 1. Servidor Linux — Instalación

```bash
git clone <repo>
cd Ion_backend/src

# Instalar dependencias (--ignore-scripts necesario para Vosk)
npm install --ignore-scripts

# Descargar modelo Vosk en español (~1.8GB)
npm run model
```

### Configurar `.env`

```env
PORT=3000
LLM_BASE_URL=http://<IP_WINDOWS>:11434
LLM_MODEL=qwen2.5:7b
LLM_MAX_TOKENS=100
TTS_URL=http://<IP_WINDOWS>:8002
SAVE_AUDIO=false
```

### Iniciar servidor

```bash
npm run dev
```

---

## 2. WSL2 — Configuración inicial

### Instalar dependencias del sistema

```bash
sudo apt-get update
sudo apt-get install -y python3.12 python3.12-venv python3-pip zstd ffmpeg tmux
```

### Crear entorno virtual Python

```bash
python3 -m venv ~/xtts-env
source ~/xtts-env/bin/activate
```

### Instalar PyTorch nightly con CUDA 12.8 (para RTX 5000 series / sm_120)

```bash
pip install --pre torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/nightly/cu128

# Verificar GPU
python3 -c "import torch; print('CUDA:', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0))"
```

---

## 3. WSL2 — Microservicio TTS (XTTS-v2)

### Instalar coqui-tts con versiones compatibles

```bash
source ~/xtts-env/bin/activate

pip install "coqui-tts==0.24.2" "transformers==4.42.4" "tokenizers==0.19.1"
pip install fastapi uvicorn soundfile
pip install torchcodec --pre --index-url https://download.pytorch.org/whl/nightly/cu128
```

### Parches necesarios (incompatibilidades con PyTorch nightly)

**Parche 1 — trainer/io.py (weights_only):**
```bash
sed -i 's/return torch.load(f, map_location=map_location, \*\*kwargs)/return torch.load(f, map_location=map_location, weights_only=False, **kwargs)/' \
  ~/xtts-env/lib/python3.12/site-packages/trainer/io.py
```

**Parche 2 — xtts.py (reemplazar torchaudio.load por soundfile):**
```bash
sed -i 's/audio, lsr = torchaudio.load(audiopath)/import soundfile as _sf; import numpy as _np; import torch as _torch; _data, lsr = _sf.read(audiopath, dtype="float32"); audio = _torch.from_numpy(_data.T if _data.ndim > 1 else _data[None,:])/' \
  ~/xtts-env/lib/python3.12/site-packages/TTS/tts/models/xtts.py
```

### Audio de referencia para clonación de voz

Coloca un archivo WAV de 6–30 segundos con voz en español, clara y sin ruido de fondo:

```bash
# Desde Windows (PowerShell) copiar a WSL2:
copy "C:\ruta\tu_audio.wav" "\\wsl$\Ubuntu\home\pc\reference_es.wav"

# Verificar
python3 -c "import soundfile as sf; i = sf.info('/home/pc/reference_es.wav'); print(f'{i.duration:.1f}s, {i.samplerate}Hz')"
```

### Crear microservicio FastAPI

```bash
cat > ~/tts_service.py << 'EOF'
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import torch, io, soundfile as sf, time

app = FastAPI()

print("🔄 Cargando modelo XTTS-v2...")
t0 = time.time()
from TTS.api import TTS

device = "cuda" if torch.cuda.is_available() else "cpu"
print(f"🖥️  Usando dispositivo: {device}")

tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
print(f"✅ Modelo cargado en {time.time()-t0:.1f}s")

REFERENCE_AUDIO = "/home/pc/reference_es.wav"

class TTSRequest(BaseModel):
    text: str
    language: str = "es"

@app.post("/synthesize")
async def synthesize(req: TTSRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Texto vacío")
    t0 = time.time()
    wav = tts.tts(text=req.text, speaker_wav=REFERENCE_AUDIO, language=req.language)
    buf = io.BytesIO()
    sf.write(buf, wav, 24000, format="WAV")
    buf.seek(0)
    print(f"⏱️  [TTS] '{req.text[:40]}' → {time.time()-t0:.2f}s ({device})")
    return Response(content=buf.read(), media_type="audio/wav")

@app.get("/health")
def health():
    return {"status": "ok", "device": device}
EOF
```

---

## 4. WSL2 — Ollama con GPU

```bash
# Instalar Ollama
sudo apt-get install -y zstd
curl -fsSL https://ollama.com/install.sh | sh

# Detener servicio del sistema (corre en 127.0.0.1 solamente)
sudo systemctl stop ollama
sudo systemctl disable ollama

# Iniciar Ollama escuchando en todas las interfaces
OLLAMA_HOST=0.0.0.0:11434 \
OLLAMA_NUM_PARALLEL=3 \
OLLAMA_MAX_LOADED_MODELS=1 \
OLLAMA_KEEP_ALIVE=-1 \
ollama serve &

# Descargar modelo
ollama pull qwen2.5:7b

# Verificar GPU
nvidia-smi  # debe mostrar proceso ollama con VRAM asignada
```

---

## 5. Windows — Port Proxy (exponer WSL2 al servidor Linux)

En **PowerShell como Administrador**:

```powershell
# Obtener IP de WSL2
$wslIp = (wsl hostname -I).Trim()
echo "WSL2 IP: $wslIp"

# Port proxy para TTS
netsh interface portproxy add v4tov4 listenport=8002 listenaddress=0.0.0.0 connectport=8002 connectaddress=$wslIp

# Port proxy para Ollama
netsh interface portproxy add v4tov4 listenport=11434 listenaddress=0.0.0.0 connectport=11434 connectaddress=$wslIp

# Reglas de firewall
netsh advfirewall firewall add rule name="WSL2 TTS 8002" dir=in action=allow protocol=TCP localport=8002
netsh advfirewall firewall add rule name="WSL2 Ollama 11434" dir=in action=allow protocol=TCP localport=11434

# Verificar
netsh interface portproxy show all
```

> ⚠️ La IP de WSL2 cambia en cada reinicio de Windows. Ejecuta este bloque nuevamente si los servicios dejan de responder.

---

## 6. Scripts de gestión (WSL2)

### Script de inicio

```bash
cat > ~/start_alma_services.sh << 'EOF'
#!/bin/bash
pkill ollama 2>/dev/null
tmux kill-session -t alma 2>/dev/null
sleep 2

tmux new-session -d -s alma
tmux send-keys -t alma:0 "OLLAMA_HOST=0.0.0.0:11434 OLLAMA_NUM_PARALLEL=3 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_KEEP_ALIVE=-1 ollama serve" Enter
tmux split-window -h -t alma:0
tmux send-keys -t alma:0 "source ~/xtts-env/bin/activate && uvicorn tts_service:app --host 0.0.0.0 --port 8002" Enter
tmux attach -t alma
EOF
chmod +x ~/start_alma_services.sh
```

### Script de parada

```bash
cat > ~/stop_alma_services.sh << 'EOF'
#!/bin/bash
pkill ollama && echo "✅ Ollama detenido"
pkill -f "uvicorn tts_service" && echo "✅ TTS detenido"
tmux kill-session -t alma 2>/dev/null
echo "✅ Todo detenido"
EOF
chmod +x ~/stop_alma_services.sh
```

### Comandos tmux

| Acción | Comando |
|---|---|
| Cambiar entre paneles | `Ctrl+B` luego `←/→` |
| Desconectarse sin matar servicios | `Ctrl+B` luego `d` |
| Reconectarse | `tmux attach -t alma` |
| Detener todo | `~/stop_alma_services.sh` |

---

## 7. Flujo de despliegue completo

```bash
# === En WSL2 ===
~/start_alma_services.sh
# Esperar ~15s hasta que TTS cargue el modelo

# === En servidor Linux ===
cd /home/services/Ion_backend/src
npm run dev
```

Acceder en el navegador: `http://<IP_SERVIDOR>:3000`

---

## 8. Verificación del sistema

```bash
# Desde servidor Linux — verificar TTS
curl -X POST http://<IP_WINDOWS>:8002/synthesize \
  -H "Content-Type: application/json" \
  -d '{"text":"Hola, soy ALMA.","language":"es"}' \
  --output /tmp/test.wav && ls -lh /tmp/test.wav

# Verificar Ollama
curl http://<IP_WINDOWS>:11434/api/tags

# Verificar servidor ALMA
curl http://localhost:3000/test
curl http://localhost:3000/stats
```

### Crear paciente de prueba

```bash
curl -X POST http://localhost:3000/patients \
  -H "Content-Type: application/json" \
  -d '{"id":"PAC-001","name":"María González","age":72,"clinical_notes":"Hipertensión controlada"}'
```

---

## API REST

| Método | Endpoint | Descripción |
|---|---|---|
| POST | `/patients` | Crear paciente |
| GET | `/patients` | Listar pacientes |
| GET | `/patients/:id` | Perfil + sesiones |
| PUT | `/patients/:id` | Actualizar paciente |
| DELETE | `/patients/:id` | Eliminar paciente |
| GET | `/patients/:id/sessions` | Sesiones del paciente |
| GET | `/sessions/:id/messages` | Mensajes de sesión |
| GET | `/stats` | Estado del servidor |
| GET | `/test` | Health check |

---

## Notas importantes

- **Vosk** requiere `npm install --ignore-scripts` — no compila con Bun ni con node-gyp en Node v24
- **sql.js** en lugar de better-sqlite3 — better-sqlite3 no compila con Node v24 (arquitectura sm_120 incompatible)
- **PyTorch nightly cu128** — necesario para RTX 5000 series (Blackwell, sm_120); las versiones estables no soportan esta GPU
- **IP WSL2 dinámica** — el port proxy debe reconfigurarse tras cada reinicio de Windows
- **coqui-tts 0.24.2** requiere exactamente `transformers>=4.42.0,<4.43.0`
- **Ollama sistema vs usuario** — el servicio del sistema instala Ollama en `127.0.0.1`; hay que deshabilitarlo y correr Ollama manualmente con `OLLAMA_HOST=0.0.0.0`