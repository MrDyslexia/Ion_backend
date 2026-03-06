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
