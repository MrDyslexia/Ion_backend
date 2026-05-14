require('dotenv').config();
const express  = require('express');
const http     = require('node:http');
const socketIo = require('socket.io');
const wav      = require('wav');
const fs       = require('node:fs');
const path     = require('node:path');

const {
  initDB, patientOps, sessionOps, messageOps,
  evaluationOps, buildDialog, COMPRESS_THRESHOLD
} = require('./db');

const { TestRunner, CancelledError } = require('./engine/TestRunner');
const { getTest }                    = require('./engine/tests/registry');
const { synthesizeSpeech }           = require('./engine/ttsHelper');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static('public'));

/** ======================= Directorios ======================= */
const audioDir  = path.join(__dirname, '../audio');
const modelsDir = path.join(__dirname, 'models');
[audioDir, modelsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/** ======================= Config ======================= */
const SAVE_AUDIO      = process.env.SAVE_AUDIO !== 'false'; // default true ahora
const LLM_BASE_URL    = process.env.LLM_BASE_URL    || 'http://localhost:11434';
const LLM_MODEL       = process.env.LLM_MODEL       || 'qwen2.5:7b';
const LLM_MAX_TOK     = Number.parseInt(process.env.LLM_MAX_TOKENS || '512', 10);
const TTS_URL         = process.env.TTS_URL         || 'http://localhost:8002';
const PORT            = Number.parseInt(process.env.PORT   || '3000', 10);
const SEARXNG_URL     = process.env.SEARXNG_URL     || 'http://localhost:8080';

const DEFAULT_PATIENT_ID   = process.env.DEFAULT_PATIENT_ID   || 'DEV-001';
const DEFAULT_PATIENT_NAME = process.env.DEFAULT_PATIENT_NAME || 'Paciente de Prueba';
const DEFAULT_PATIENT_AGE  = Number.parseInt(process.env.DEFAULT_PATIENT_AGE || '70', 10);

// ── Audio / ASR ────────────────────────────────────────────────────────────
// Umbral RMS por debajo del cual el chunk se considera silencio (0–32767).
// Subir si hay mucho ruido ambiental; bajar si se corta voz legítima.
const NOISE_GATE_THRESHOLD  = Number.parseInt(process.env.NOISE_GATE_THRESHOLD  || '400',  10);
// Umbral RMS para que el VAD declare que hay habla (durante el 6CIT).
const VAD_SPEECH_THRESHOLD  = Number.parseInt(process.env.VAD_SPEECH_THRESHOLD  || '800',  10);
// Ms de silencio continuo para que el VAD cierre el turno (durante el 6CIT).
const VAD_SILENCE_MS        = Number.parseInt(process.env.VAD_SILENCE_MS        || '1800', 10);
// Longitud mínima de transcripción (chars) para considerarla válida.
const MIN_TRANSCRIPT_LENGTH = Number.parseInt(process.env.MIN_TRANSCRIPT_LENGTH || '4',    10);

/** ======================= Vosk ======================= */
let vosk        = null;
let voskModel   = null;
let isVoskReady = false;

const initVosk = async () => {
  try {
    console.log('🔄 Inicializando Vosk...');
    vosk = await import('vosk');
    const modelPath = path.join(modelsDir, 'vosk-model-es-0.42');
    if (!fs.existsSync(modelPath)) { console.log('⚠️  Modelo Vosk no encontrado en', modelPath); return false; }
    voskModel   = new vosk.Model(modelPath);
    isVoskReady = true;
    console.log('✅ Vosk listo');
    return true;
  } catch (e) { console.error('❌ Vosk:', e); return false; }
};

/** ======================= Búsqueda web (SearXNG) ======================= */
async function searchWeb(query) {
  const url = new URL(`${SEARXNG_URL}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'es');
  const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}`);
  const data = await resp.json();
  const hits  = (data.results || []).slice(0, 3);
  if (!hits.length) return 'No se encontraron resultados para esa búsqueda.';
  return hits.map((r, i) =>
    `[${i + 1}] ${r.title}\n${(r.content || r.description || '').slice(0, 200)}`
  ).join('\n\n');
}

/** ======================= System prompt ======================= */
function buildSystemPrompt(patient) {
  const now = new Date();
  const ts  = now.toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  const notas = patient.clinical_notes ? ` Notas clínicas: ${patient.clinical_notes}.` : '';
  return `Eres ALMA, asistente de salud cognitiva. Responde siempre en español. Sé breve, cálido y empático.
Fecha actual: ${ts}.
Paciente: ${patient.name}, ${patient.age} años.${notas}

Cuando el paciente te salude, responde con un saludo breve y pregunta cómo se siente.
Cuando el paciente esté dispuesto, ofrécele una evaluación breve de memoria.
USA conduct_test ÚNICAMENTE si: (1) tú mismo le ofreciste la evaluación en el turno anterior Y (2) el paciente respondió con una aceptación clara como "sí", "de acuerdo", "adelante", "quiero", "vamos". Ninguna otra situación justifica llamar conduct_test.
NUNCA administres el test tú mismo. NUNCA preguntes por el año, mes, hora, dirección, ni pidas repetir palabras o frases. NUNCA inventes ni adaptes tests cognitivos. Si el paciente acepta, llama conduct_test y el sistema toma el control.
Cuando el paciente se despida, el sistema maneja la despedida automáticamente — tú NO debes despedirte.
Puedes buscar información actual en internet usando la herramienta search_web. Úsala cuando el paciente pida noticias, precios, declaraciones u otros datos recientes. Sintetiza los resultados en máximo 3 oraciones claras; no leas URLs en voz alta.`;
}

/** ======================= Function calling ======================= */
const LLM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_datetime',
      description: 'Obtiene la fecha y hora actual del sistema.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Busca información actual en internet.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Términos de búsqueda en español' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'conduct_test',
      description: 'Inicia la evaluación cognitiva 6CIT. Úsala ÚNICAMENTE cuando el paciente haya aceptado EXPLÍCITAMENTE.',
      parameters: {
        type: 'object',
        properties: { testId: { type: 'string', enum: ['sixcit'] } },
        required: ['testId']
      }
    }
  }
];

async function executeTool(name, args, ctx) {
  if (name === 'get_datetime') {
    return new Date().toLocaleString('es-CL', {
      weekday: 'long', year: 'numeric', month: 'long',
      day: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  if (name === 'search_web') {
    const { query } = args;
    if (!query) return 'Error: se requiere un término de búsqueda.';
    console.log(`🔍 [Search] "${query}"`);
    try {
      const results = await searchWeb(query);
      return results;
    } catch (e) {
      console.error('❌ [Search] Error:', e.message);
      return 'No pude realizar la búsqueda en este momento.';
    }
  }

  if (name === 'conduct_test') {
    const { testId } = args;
    if (!testId) return 'Error: se requiere testId.';
    if (!ctx)    return 'Error: contexto de sesión no disponible.';
    if (ctx.activeRunner)        return 'Ya hay una evaluación en curso.';
    if (ctx.testDoneThisSession) return 'Ya se realizó una evaluación en esta sesión. No la repitas.';
    if (evaluationOps.hasTestToday(ctx.patient.id)) {
      return 'El paciente ya realizó una evaluación hoy.';
    }

    const lastUserMsg = [...ctx.dialog].reverse().find(m => m.role === 'user');
    ctx._testTriggerContent = lastUserMsg?.content || null;

    setImmediate(async () => {
      const runner = new TestRunner(ctx);
      ctx.activeRunner = runner;
      try {
        const test   = getTest(testId);
        const result = await test.run(ctx, runner);

        evaluationOps.save(ctx.sessionId, ctx.patient.id, result)
          .then(() => console.log(`✅ [Test] ${testId} guardado → ${result.status}, score: ${result.totalScore}/${result.maxScore}`))
          .catch(e => console.error('❌ [Test] Error guardando evaluación:', e.message));

        const triggerContent = ctx._testTriggerContent;
        ctx._testTriggerContent = null;
        let triggerRemoved = false;
        const mainSystemPrompt = ctx.dialog[0]; // preservar el system prompt principal
        ctx.dialog = ctx.dialog.filter(m => {
          if (m === mainSystemPrompt) return true; // nunca eliminar el system prompt principal
          if (m.role === 'tool')      return false;
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
          if (m.role === 'system'    && m.content?.includes('conduct_test'))    return false;
          if (m.role === 'system'    && m.content?.includes('evaluación'))      return false;
          if (m.role === 'system'    && m.content?.includes('Evaluación'))      return false;
          if (m.role === 'user' && !triggerRemoved && triggerContent && m.content === triggerContent) {
            triggerRemoved = true; return false;
          }
          if (m.role === 'assistant' && m.content && (
            m.content.includes('iniciando la evaluación') ||
            m.content.includes('Iniciando la evaluación') ||
            m.content.includes('conducirá la evaluación')
          )) return false;
          return true;
        });
        ctx.testDoneThisSession = true;
        ctx.activeRunner = null;
        ctx._testJustStarted = false;

        // "adiós alma" durante el test → despedida completa, no continuar conversación
        if (ctx._byeRequestedDuringTest) {
          ctx._byeRequestedDuringTest = false;
          ctx.conversationActive = false;
          ctx.isProcessingTurn   = false;
          ctx._byeCooldown       = true;
          const byeText = '¡Hasta pronto! Que tenga un buen día.';
          ctx.socket.emit('assistant_text',      { delta: byeText });
          ctx.socket.emit('assistant_text_done', { text: byeText });
          ctx.socket.emit('test_finished');
          synthesizeSpeech(byeText).then(buf => {
            if (buf) ctx.socket.emit('tts_audio', { audio: buf.toString('base64'), mimeType: 'audio/wav' });
          }).catch(console.error);
          setTimeout(() => {
            if (!ctx) return;
            const sp = ctx.dialog.find(m => m.role === 'system');
            if (sp) ctx.dialog = [{ role: 'system', content: sp.content }];
            ctx.testDoneThisSession = false;
            ctx._byeCooldown = false;
          }, 4000);
          return;
        }

        // Bloquear STT mientras el TTS post-test se sintetiza y reproduce
        ctx.isProcessingTurn = true;

        const noAnswers = Object.keys(result.answers || {}).length === 0;
        const resumeText = result.status === 'cancelled' && noAnswers
          ? 'No hay ningún problema. Estaré aquí cuando quiera. ¿Cómo se siente?'
          : result.status === 'cancelled'
            ? 'Hemos detenido la evaluación. No se preocupe en absoluto, hizo un gran esfuerzo. ¿Cómo se siente?'
            : 'Hemos terminado. Muchas gracias por su tiempo y su esfuerzo, lo hizo muy bien. ¿Cómo se siente?';

        ctx.dialog.push({ role: 'system', content: 'La evaluación cognitiva 6CIT acaba de completarse. Retoma la conversación normal.' });
        ctx.socket.emit('assistant_text',      { delta: resumeText });
        ctx.socket.emit('assistant_text_done', { text: resumeText });
        ctx.dialog.push({ role: 'assistant', content: resumeText });
        ctx.conversationActive = true;
        ctx.socket.emit('test_finished');
        if (ctx.conversationMode === 'wake_per_turn') {
          ctx.socket.emit('conversation_mode_state', { listeningForTurn: false, waitingForWakeWord: true });
        }
        synthesizeSpeech(resumeText).then(buf => {
          if (buf) {
            ctx.speakingUntil = Date.now() + estimateWavDurationMs(buf);
            ctx.socket.emit('tts_audio', { audio: buf.toString('base64'), mimeType: 'audio/wav' });
          }
        }).catch(e => console.error('❌ TTS post-test:', e.message))
          .finally(() => { if (ctx) ctx.isProcessingTurn = false; });

      } catch (e) {
        if (e instanceof CancelledError) {
          // run() atrapa CancelledError internamente — este path no debería alcanzarse,
          // pero se mantiene como red de seguridad para errores inesperados.
          ctx.activeRunner = null;
          ctx.testDoneThisSession = true;
          ctx._testJustStarted = false;
          ctx._byeRequestedDuringTest = false;
          ctx.conversationActive = true;
          ctx.isProcessingTurn   = false;
          ctx.socket.emit('test_finished');
        } else {
          console.error(`❌ [Test] ${testId} error inesperado:`, e.message);
          ctx.activeRunner = null;
        }
      }
    });

    ctx._testJustStarted = true;
    return `Iniciando evaluación ${testId}. El sistema tomará control del flujo de voz.`;
  }

  return 'Herramienta desconocida.';
}

/** ======================= Detección de test manual ======================= */
const MANUAL_TEST_RE = [
  /en qu[eé] a[nñ]o estamos/i,
  /en qu[eé] mes estamos/i,
  /qu[eé] hora (es|son) (aproximadamente|ahora)/i,
  /cuente.*hacia atr[aá]s/i,
  /contar.*hacia atr[aá]s/i,
  /meses.*orden inverso/i,
  /meses del a[nñ]o.*inverso/i,
  /recuerde (estas|las siguientes|esta) (palabras|frase|direcci[oó]n)/i,
  /repita (estas|las siguientes|esta) (palabras|frase|direcci[oó]n)/i,
  /memorice (estas|las siguientes)/i,
  /le voy a (decir|leer).*(palabras|frase)/i,
  /escuche (con atenci[oó]n|estas palabras)/i,
];

function looksLikeManualTest(text) {
  if (!text) return false;
  return MANUAL_TEST_RE.some(p => p.test(text));
}

/** ======================= Helpers de audio ======================= */
function estimateWavDurationMs(buf, paddingMs = 700) {
  if (!buf || buf.length < 44) return paddingMs;
  try {
    const sampleRate = buf.readUInt32LE(24);
    const channels   = buf.readUInt16LE(22);
    const bitDepth   = buf.readUInt16LE(34);
    const dataSize   = buf.readUInt32LE(40);
    if (sampleRate > 0 && channels > 0 && bitDepth > 0) {
      return Math.ceil((dataSize / (sampleRate * channels * (bitDepth / 8))) * 1000) + paddingMs;
    }
  } catch {}
  return paddingMs;
}

/** ======================= LLM streaming + tool use ======================= */
async function streamLLMResponse(resp, socket, logFirstToken, onFirstToken) {
  const reader  = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', streamText = '', toolCall = null, firstToken = true;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let data;
      try { data = JSON.parse(line); } catch { continue; }
      if (data.message?.content) {
        const delta = data.message.content;
        if (firstToken) {
          logFirstToken();
          firstToken = false;
          // ── MARCA: primer carácter del LLM ──
          if (typeof onFirstToken === 'function') onFirstToken(Date.now());
        }
        streamText += delta;
        socket.emit('assistant_text', { delta });
      }
      if (data.message?.tool_calls?.length) toolCall = data.message.tool_calls[0];
    }
  }
  return { streamText, toolCall };
}

async function dispatchToolCall(toolCall, dialog, sessionId, ctx) {
  const fnName = toolCall.function?.name;
  const fnArgs = toolCall.function?.arguments || {};
  console.log(`🔧 Tool: ${fnName}`, fnArgs);
  const result = await executeTool(fnName, fnArgs, ctx);
  console.log(`🔧 Result: ${result}`);
  dialog.push(
    { role: 'assistant', content: '', tool_calls: [toolCall] },
    { role: 'tool',      content: result }
  );
  if (sessionId) {
    messageOps.add(sessionId, 'assistant', '', [toolCall]);
    messageOps.add(sessionId, 'tool', result);
  }
}

async function askLLM(socket, dialog, sessionId, patient, ctx = null) {
  if (ctx?.isProcessingTurn) {
    console.log('⏸ [LLM ] Turno en proceso — STT descartado');
    return '';
  }
  if (ctx) ctx.isProcessingTurn = true;
  socket.emit('assistant_status', { status: 'thinking' });
  const _t0llm = Date.now();

  const MAX_ITER = 3;
  let iter = 0, fullResponse = '';

  while (iter < MAX_ITER) {
    iter++;
    const body = {
      model:    LLM_MODEL,
      messages: dialog,
      stream:   true,
      tools:    LLM_TOOLS,
      options:  { num_predict: LLM_MAX_TOK, temperature: 0.3, top_p: 0.9 }
    };

    const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body)
    });
    if (!resp.ok || !resp.body) throw new Error(`LLM HTTP ${resp.status}`);

    const logFirstToken = () => console.log(`⏱️  [LLM ] primer token → ${Date.now() - _t0llm}ms`);

    // Callback para marcar el primer token en el turno actual
    const onFirstToken = (ts) => {
      if (ctx?.currentTurnMarks && !ctx.currentTurnMarks.llm_first_char) {
        ctx.currentTurnMarks.llm_first_char = ts;
      }
    };

    const { streamText, toolCall } = await streamLLMResponse(resp, socket, logFirstToken, onFirstToken);

    if (toolCall) {
      await dispatchToolCall(toolCall, dialog, sessionId, ctx);
      // Si el tool inició un test, no llamar LLM de nuevo — el runner toma control
      if (ctx?._testJustStarted) {
        socket.emit('assistant_text_done', { text: '' });
        socket.emit('assistant_status',    { status: 'idle' });
        if (ctx) ctx.isProcessingTurn = false;
        return '';
      }
      continue;
    }

    fullResponse = streamText;
    console.log(`⏱️  [LLM ] respuesta completa (${fullResponse.length} chars) → ${Date.now() - _t0llm}ms`);

    if (ctx && !ctx.testDoneThisSession && !ctx.activeRunner && looksLikeManualTest(fullResponse)) {
      console.warn('⚠️  [LLM ] Test manual detectado — interceptando');
      fullResponse = '';
      socket.emit('assistant_text_done', { text: '' });
      socket.emit('assistant_status', { status: 'idle' });
      await executeTool('conduct_test', { testId: 'sixcit' }, ctx);
      return '';
    }

    break;
  }

  if (fullResponse.trim() && sessionId) {
    messageOps.add(sessionId, 'assistant', fullResponse);
    dialog.push({ role: 'assistant', content: fullResponse });
  }

  socket.emit('assistant_text_done', { text: fullResponse });

  // ── Comprimir contexto si supera umbral ──
  const now60 = Date.now();
  if (ctx && sessionId && messageOps.countForSession(sessionId) > COMPRESS_THRESHOLD
      && now60 - ctx._lastCompressed > 60000) {
    ctx._lastCompressed = now60;
    compressContext(sessionId, dialog, patient).catch(console.error);
  }

  // ── TTS ──
  const suppressTTS = ctx?._testJustStarted || ctx?.activeRunner;
  if (ctx) ctx._testJustStarted = false;

  if (fullResponse.trim() && !suppressTTS) {
    // ── MARCA: inicio TTS ──
    if (ctx?.currentTurnMarks) {
      ctx.currentTurnMarks.tts_start = Date.now();
    }
    console.log(`🔊 [TTS ] Síntesis iniciada (${fullResponse.length} chars)`);
    synthesizeSpeech(fullResponse).then(audioBuf => {
      // ── CIERRE del turno actual: guardar marks ──
      if (ctx?.currentTurnMarks?.asr_final && ctx?.currentTurnMarks?.llm_first_char) {
        const m = ctx.currentTurnMarks;
        ctx.convTurns.push({
          turno:          ctx.convTurns.length + 1,
          text:           m.text,
          asr_final:      m.asr_final,
          llm_first_char: m.llm_first_char,
          tts_start:      m.tts_start,
          L_llm_ms:       m.llm_first_char - m.asr_final,
          L_tts_ms:       m.tts_start ? m.tts_start - m.asr_final : null,
        });
        ctx.currentTurnMarks = null;
      }
      if (audioBuf) {
        console.log(`🔊 [TTS ] Audio emitido: ${audioBuf.length} bytes`);
        if (ctx) ctx.speakingUntil = Date.now() + estimateWavDurationMs(audioBuf);
        socket.emit('tts_audio', { audio: audioBuf.toString('base64'), mimeType: 'audio/wav' });
      } else {
        console.warn('⚠️  [TTS ] Síntesis devolvió null — sin audio');
      }
    }).catch(e => {
      ctx.currentTurnMarks = null;
      console.error('❌ TTS pipeline:', e.message);
    }).finally(() => {
      if (ctx) ctx.isProcessingTurn = false;
      socket.emit('assistant_status', { status: 'idle' });
    });
  } else {
    ctx.currentTurnMarks = null;
    if (ctx) ctx.isProcessingTurn = false;
    socket.emit('assistant_status', { status: 'idle' });
  }

  return fullResponse;
}

/** ======================= Compresión de contexto ======================= */
async function compressContext(sessionId, dialog, patient) {
  const allMsgs = dialog.filter(m => m.role !== 'system');
  if (allMsgs.length < 10) return;
  const toCompress = allMsgs.slice(0, -10);
  const msgLine = m => `${m.role === 'user' ? 'Paciente' : 'ALMA'}: ${m.content}`;
  const prompt = `Resume brevemente esta conversación entre ALMA y el paciente ${patient.name}. Máximo 3 oraciones.\n\n${toCompress.map(msgLine).join('\n')}`;
  try {
    const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 200, temperature: 0.3 } })
    });
    const d = await resp.json();
    const summary = d.message?.content?.trim();
    if (summary) {
      sessionOps.saveSummary(sessionId, summary);
      const systemMsg  = dialog[0];
      const recent     = dialog.slice(-10);
      const summaryMsg = { role: 'system', content: `[Resumen de la conversación anterior]: ${summary}` };
      dialog.splice(0, dialog.length, systemMsg, summaryMsg, ...recent);
    }
  } catch (e) { console.error('❌ Compresión:', e.message); }
}

/** ======================= SessionContext ======================= */
const activeSessions = new Map();

class SessionContext {
  constructor(socket, patient, sessionId, dialog) {
    this.socket             = socket;
    this.patient            = patient;
    this.sessionId          = sessionId;
    this.dialog             = dialog;
    this.voskRec            = null;
    this.isRecording        = false;
    this.conversationActive = false;
    this.userBuffer         = '';
    this.lastPartial        = '';
    this.chunksReceived     = 0;
    this.firstChunkTime     = null;
    this.activeRunner       = null;
    this._testJustStarted   = false;
    this.testDoneThisSession  = false;
    this._byeCooldown               = false;
    this._byeRequestedDuringTest    = false;
    this._lastCompressed      = 0;
    this.conversationMode  = 'always_on';
    this.listeningForTurn  = false;
    this.turnBuffer        = '';
    this._turnTimer        = null;
    this.vadEnabled         = false;
    this.vadIsSpeaking      = false;
    this.vadSilenceTimer    = null;
    this.vadSilenceMs       = VAD_SILENCE_MS;
    this.vadSpeechThreshold = VAD_SPEECH_THRESHOLD;

    // ── Anti-solapamiento ───────────────────────────────────────────────────
    this.isProcessingTurn = false; // true mientras LLM+TTS pipeline está activo
    this.speakingUntil    = 0;     // timestamp hasta el que el STT queda silenciado (TTS sonando)

    // ── Grabación por conversación ──────────────────────────────────────────
    this.convWavWriter    = null;   // wav.FileWriter activo solo entre hola/adiós
    this.convStartedAt    = null;   // timestamp de "hola alma"
    this.convTurns        = [];     // array de marks por turno
    this.currentTurnMarks = null;   // marks del turno en curso
    this._convWavPath     = null;   // ruta del WAV actual (para el JSON)
  }

  createVoskRec() {
    if (!isVoskReady || !voskModel) return;
    try { this.voskRec = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 }); this.voskRec.setWords(true); }
    catch (e) { console.error('❌ Vosk recognizer:', e); }
  }

  freeVoskRec() {
    if (this.voskRec) { try { this.voskRec.free(); } catch {} this.voskRec = null; }
  }

  // ── Inicia grabación al detectar "hola alma" ────────────────────────────
  startConversationRecording() {
    this.convStartedAt    = Date.now();
    this.convTurns        = [];
    this.currentTurnMarks = null;

    if (SAVE_AUDIO) {
      const ts       = this.convStartedAt;
      const pid      = this.patient.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const wavName  = `conv_${pid}_${ts}.wav`;
      this._convWavPath = path.join(audioDir, wavName);
      this.convWavWriter = new wav.FileWriter(this._convWavPath, {
        sampleRate: 16000, channels: 1, bitDepth: 16
      });
      this.convWavWriter.on('error', e => console.error('❌ Conv WAV:', e.message));
      console.log(`🎙️  [Conv] Grabación iniciada: ${wavName}`);
    }
  }

  // ── Cierra grabación y guarda JSON al detectar "adiós alma" ────────────
  endConversationRecording() {
    if (!this.convStartedAt) return; // no había conversación activa

    const endedAt = Date.now();

    // Cerrar WAV
    if (this.convWavWriter) {
      try { this.convWavWriter.end(); } catch {}
      this.convWavWriter = null;
    }

    // Construir JSON de traza
    const validTurns = this.convTurns.filter(t => t.asr_final && t.llm_first_char);
    const lastTurn   = validTurns.at(-1);

    const trace = {
      socketId:   this.socket.id,
      patientId:  this.patient.id,
      patientName: this.patient.name,
      sessionId:  this.sessionId,
      startedAt:  this.convStartedAt,
      endedAt,
      durationMs: endedAt - this.convStartedAt,
      audioFile:  this._convWavPath ? path.basename(this._convWavPath) : null,
      turns:      validTurns,
      // Compatibilidad con analizar_latencia.js (último turno)
      marks: lastTurn ? {
        asr_final:      lastTurn.asr_final,
        llm_first_char: lastTurn.llm_first_char,
        tts_start:      lastTurn.tts_start,
      } : null,
    };

    // Guardar JSON (siempre, independiente de SAVE_AUDIO)
    const pid     = this.patient.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const jsonName = `conv_${pid}_${this.convStartedAt}.json`;
    const jsonPath = path.join(audioDir, jsonName);
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(trace, null, 2));
      console.log(`📄 [Conv] Traza guardada: ${jsonName} (${validTurns.length} turnos)`);
      if (validTurns.length > 0) {
        const llmLats = validTurns.map(t => t.L_llm_ms).filter(Boolean);
        const p95 = llmLats.sort((a,b)=>a-b)[Math.ceil(0.95*llmLats.length)-1];
        console.log(`⏱️  [Conv] Latencia LLM — p95: ${Math.round(p95)}ms (${llmLats.length} turnos)`);
      }
    } catch(e) {
      console.error('❌ [Conv] Error guardando traza:', e.message);
    }

    // Limpiar estado
    this.convStartedAt    = null;
    this.convTurns        = [];
    this.currentTurnMarks = null;
    this._convWavPath     = null;
  }

  // ── Escribe audio PCM al WAV de conversación (si está activa) ──────────
  writeConvAudio(buf) {
    if (this.convWavWriter && this.conversationActive) {
      try { this.convWavWriter.write(buf); } catch {}
    }
  }

  // Arma (o rearma) el timer de silencio VAD. Cualquier fuente puede llamarlo:
  // energía de audio detectada en processVAD, o nuevo fragmento STT desde el runner.
  _armVadSilenceTimer() {
    clearTimeout(this.vadSilenceTimer);
    this.vadSilenceTimer = setTimeout(() => {
      if (!this.vadEnabled) return;
      this.vadIsSpeaking = false;
      this.activeRunner?.onVadSilence?.();
    }, this.vadSilenceMs);
  }

  // Llamado desde TestRunner cuando llega un nuevo fragmento STT en modo VAD.
  resetVadSilenceTimer() {
    if (!this.vadEnabled) return;
    this._armVadSilenceTimer();
  }

  processVAD(int16Array) {
    if (!this.vadEnabled || !this.activeRunner) return;
    let sum = 0;
    for (const sample of int16Array) sum += sample * sample;
    const rms = Math.sqrt(sum / int16Array.length);
    if (rms >= this.vadSpeechThreshold) {
      if (!this.vadIsSpeaking) {
        this.vadIsSpeaking = true;
        this.activeRunner.onVadSpeech?.();
      }
      this._armVadSilenceTimer();
    }
  }

  resetVAD() {
    this.vadEnabled    = false;
    this.vadIsSpeaking = false;
    clearTimeout(this.vadSilenceTimer);
    this.vadSilenceTimer = null;
  }
}

/** ======================= Comandos de voz ======================= */
function handleWakePerTurn(t, ctx) {
  if (t.includes('ok alma') || t.includes('oye alma')) {
    const rest = t.split(/ok alma|oye alma/).pop()?.trim() ?? '';
    ctx.listeningForTurn = true;
    ctx.turnBuffer = rest;
    clearTimeout(ctx._turnTimer);
    if (rest) ctx._turnTimer = setTimeout(() => flushTurn(ctx), 2000);
    return { isCommand: true, action: 'turn_start', text: rest };
  }
  if (ctx.listeningForTurn) {
    ctx.turnBuffer += (ctx.turnBuffer ? ' ' : '') + t;
    clearTimeout(ctx._turnTimer);
    ctx._turnTimer = setTimeout(() => flushTurn(ctx), 2000);
    return { isCommand: false, action: 'turn_accumulate' };
  }
  return { isCommand: false, action: null };
}

function processVoiceCommands(text, ctx) {
  const t = text.toLowerCase().trim();

  if (t.includes('hola alma')) {
    if (!ctx.conversationActive) {
      const question = ctx.conversationMode === 'always_on'
        ? (t.split('hola alma')[1]?.trim() || '')
        : '';
      ctx.conversationActive = true;
      if (question) { ctx.dialog.push({ role: 'user', content: question }); messageOps.add(ctx.sessionId, 'user', question); }
      return { isCommand: true, action: 'start_conversation', question, greet: !question };
    }
    const rest = t.split('hola alma').pop()?.trim() || '';
    if (!rest) return { isCommand: false, action: null };
    ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + rest;
    return { isCommand: false, action: 'continue_conversation' };
  }

  const stopCmds = ['gracias alma', 'detente alma', 'adiós alma', 'adios alma', 'hasta luego alma', 'para alma', 'chao alma', 'hasta pronto alma'];
  if (stopCmds.some(c => t.includes(c)) && ctx.conversationActive) {
    ctx.conversationActive = false;
    ctx.userBuffer = '';
    clearTimeout(ctx._turnTimer);
    ctx.listeningForTurn = false;
    ctx.turnBuffer = '';
    return { isCommand: true, action: 'stop_conversation', farewell: true };
  }

  if (ctx.conversationMode === 'wake_per_turn' && ctx.conversationActive) {
    return handleWakePerTurn(t, ctx);
  }

  if (ctx.conversationActive && t) {
    ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + t;
    return { isCommand: false, action: 'continue_conversation' };
  }

  if (!ctx.conversationActive && t) ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + t;
  return { isCommand: false, action: null };
}

/** ======================= Flush de turno (wake_per_turn) ======================= */
async function flushTurn(ctx) {
  const text   = ctx.turnBuffer.trim();
  const socket = ctx.socket;
  ctx.listeningForTurn = false;
  ctx.turnBuffer       = '';
  ctx._turnTimer       = null;
  socket.emit('conversation_mode_state', { listeningForTurn: false });
  if (!text) return;
  ctx.dialog.push({ role: 'user', content: text });
  messageOps.add(ctx.sessionId, 'user', text);
  await askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error);
  if (ctx.conversationActive && ctx.conversationMode === 'wake_per_turn') {
    socket.emit('conversation_mode_state', { listeningForTurn: false, waitingForWakeWord: true });
  }
}

/** ======================= Audio chunk helpers ======================= */
function parseAudioChunk(raw) {
  if (Buffer.isBuffer(raw)) {
    const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    return new Int16Array(ab);
  }
  return new Int16Array(raw);
}

function applyNoiseGate(int16, audioBuf, threshold = NOISE_GATE_THRESHOLD) {
  let sum = 0;
  for (const sample of int16) sum += sample * sample;
  return Math.sqrt(sum / int16.length) < threshold ? Buffer.alloc(audioBuf.length) : audioBuf;
}

const ENGLISH_NOISE_RE = /\b(want|try|the\b|and\b|with|have|from|they|what|when|where|would|should|could|their|there|here|just|like|that|this|then|than|been|some|more|also|only|back|come|look|make|know|good|much|need|many|well|very|after|said|even|most|made|take|work|call|thing|place|case|week|year|time|your|our\b|his\b|her\b|him\b|its\b)\b/gi;

const CONV_AFFIRMATIVE_RE = /^(sí|si|no)\s*$/i;

function isConversationNoise(text) {
  const t = (text || '').trim();
  if (!t) return true;

  // "sí"/"si"/"no" siempre son válidas — bypass antes del filtro de longitud
  if (CONV_AFFIRMATIVE_RE.test(t)) return false;

  // Demasiado corto para ser una frase real
  if (t.length < MIN_TRANSCRIPT_LENGTH) return true;

  // Una sola palabra muy corta: probable ruido o sílaba suelta de Vosk
  const words = t.split(/\s+/);
  if (words.length === 1 && t.length <= 3) return true;

  // Vocales sueltas que Vosk genera con ruido de fondo (ej: "a", "ee", "uu")
  if (/^[aeiouáéíóúü]{1,3}$/i.test(t)) return true;

  // Sonidos puros / interjecciones sin contenido semántico
  if (/^(e+m+|a+h+|u+h+|hm+|mm+|eh+|ah+|uh+|oh+|aa+|ee+|oo+)\s*$/i.test(t)) return true;

  // Repetición de la misma sílaba (artefacto de Vosk con ruido continuo)
  if (/^(\w{1,3})\s+\1(\s+\1)*$/i.test(t)) return true;

  // ≥2 palabras claramente inglesas en una frase corta → transcripción basura
  if (words.length <= 7) {
    const hits = t.match(ENGLISH_NOISE_RE);
    if (hits && hits.length >= 2) return true;
  }

  return false;
}

function handleVoiceCommand(cmd, txt, ctx, socket) {
  socket.emit('voice_command_detected', { action: cmd.action, text: txt });

  // ── INICIO de conversación ──────────────────────────────────────────────
  if (cmd.action === 'start_conversation') {
    // Iniciar grabación WAV + traza JSON
    ctx.startConversationRecording();

    if (cmd.question) {
      setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
    } else {
      const greetMsg = 'El paciente te saludó. Responde SOLO con un saludo breve (máximo una oración). No hagas preguntas, no ofrezcas ayuda, no agregues nada más.';
      ctx.dialog.push({ role: 'system', content: greetMsg });
      setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
    }
  }

  // ── FIN de conversación ─────────────────────────────────────────────────
  if (cmd.action === 'stop_conversation' && cmd.farewell) {
    ctx._byeCooldown = true;
    const byeText = '¡Hasta pronto! Que tenga un buen día.';
    socket.emit('assistant_text',      { delta: byeText });
    socket.emit('assistant_text_done', { text: byeText });

    synthesizeSpeech(byeText).then(buf => {
      if (buf) socket.emit('tts_audio', { audio: buf.toString('base64'), mimeType: 'audio/wav' });
    }).catch(console.error);

    // Cerrar grabación y guardar archivos (con pequeño delay para capturar audio de despedida)
    setTimeout(() => {
      ctx.endConversationRecording();
    }, 2000);

    // Resetear contexto conversacional para la próxima sesión.
    // Conservar solo el system prompt para que el próximo "hola alma" empiece limpio.
    setTimeout(() => {
      if (!ctx) return;
      const systemPrompt = ctx.dialog.find(m => m.role === 'system');
      if (systemPrompt) {
        ctx.dialog = [{ role: 'system', content: systemPrompt.content }];
      }
      ctx.testDoneThisSession = false;
      ctx._byeCooldown = false;
      console.log(`🔄 [Conv] Contexto reseteado — ${ctx.patient?.name}`);
    }, 4000);
  }

  if (cmd.action === 'turn_start') {
    socket.emit('conversation_mode_state', { listeningForTurn: true });
  }
}

/** ======================= Socket.IO ======================= */
io.on('connection', socket => {
  console.log(`✅ Socket: ${socket.id}`);

  socket.emit('connected', {
    message:               'Conectado a ALMA',
    sampleRate:            16000,
    supportsTranscription: isVoskReady,
    tts:                   { enabled: true, engine: 'XTTS-v2' }
  });

  socket.on('identify', ({ patientId }) => {
    if (!patientId) { socket.emit('identify_error', { error: 'Código requerido.' }); return; }
    const patient = patientOps.getById(patientId);
    if (!patient)  { socket.emit('identify_error', { error: `Paciente "${patientId}" no encontrado.` }); return; }

    const dbSession    = sessionOps.getLatestForPatient(patientId);
    const isNewSession = !dbSession || dbSession.ended_at !== null;
    let sessionId;
    if (isNewSession) { sessionId = sessionOps.create(patientId, socket.id); }
    else              { sessionId = dbSession.id; sessionOps.updateSocket(sessionId, socket.id); }

    const systemPrompt = buildSystemPrompt(patient);
    const { dialog }   = buildDialog(systemPrompt, sessionOps.getById(sessionId));

    const ctx = new SessionContext(socket, patient, sessionId, dialog);
    ctx.createVoskRec();
    activeSessions.set(socket.id, ctx);

    socket.emit('identified', {
      patientId,
      patientName:  patient.name,
      sessionId,
      isNewSession,
      messageCount: messageOps.countForSession(sessionId)
    });
    console.log(`👤 ${patient.name} (${patientId}) — sesión ${sessionId}`);
  });

  socket.on('audio_chunk', data => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx) return;
    if (!ctx.firstChunkTime) ctx.firstChunkTime = Date.now();
    ctx.chunksReceived++;

    const int16    = parseAudioChunk(data.chunk);
    const audioBuf = Buffer.from(int16.buffer);

    // ── Escribir al WAV de conversación (solo si la conversación está activa) ──
    ctx.writeConvAudio(audioBuf);

    ctx.processVAD(int16);
    if (!isVoskReady || !ctx.voskRec) return;

    const bufToFeed = applyNoiseGate(int16, audioBuf);
    const _t0stt    = Date.now();

    if (ctx.voskRec.acceptWaveform(bufToFeed)) {
      const r   = ctx.voskRec.result();
      const txt = (r.text || '').trim();
      if (!txt) return;
      console.log(`⏱️  [STT ] "${txt.slice(0, 40)}" → ${Date.now() - _t0stt}ms`);
      socket.emit('transcription', { text: txt, isFinal: true, confidence: r.confidence || 0 });

      // Stop commands ("adiós alma", etc.) bypass TTS gate and test runner
      const STOP_CMDS_BYPASS = ['gracias alma','detente alma','adiós alma','adios alma',
                                 'hasta luego alma','para alma','chao alma','hasta pronto alma'];
      const isHardStop = ctx.conversationActive &&
        STOP_CMDS_BYPASS.some(c => txt.toLowerCase().includes(c));

      if (ctx.activeRunner) {
        if (isHardStop) {
          console.log(`🛑 [Conv] Stop command durante test: "${txt.slice(0,30)}"`);
          ctx._byeRequestedDuringTest = true;
          ctx.activeRunner.destroy();
          return;
        }
        ctx.activeRunner.resolveSTT(txt); return;
      }
      if (ctx._byeCooldown) {
        console.log(`🔇 [Conv] STT bloqueado (bye cooldown): "${txt.slice(0,30)}"`);
        return;
      }
      if (!isHardStop && (ctx.isProcessingTurn || Date.now() < ctx.speakingUntil)) {
        console.log(`🔇 [Conv] STT bloqueado (${ctx.isProcessingTurn ? 'LLM activo' : 'TTS sonando'}): "${txt.slice(0,30)}"`);
        return;
      }

      const cmd = processVoiceCommands(txt, ctx);

      if (cmd.isCommand) {
        handleVoiceCommand(cmd, txt, ctx, socket);
      } else if (cmd.action === 'continue_conversation' && txt.trim()) {
        if (isConversationNoise(txt)) {
          console.log(`🔇 [Conv] STT descartado (ruido): "${txt.slice(0, 40)}"`);
        } else {
          // ── MARCA: fin de turno ASR ──────────────────────────────────────
          ctx.currentTurnMarks = {
            text:           txt,
            asr_final:      Date.now(),
            llm_first_char: null,
            tts_start:      null,
          };
          ctx.dialog.push({ role: 'user', content: txt });
          messageOps.add(ctx.sessionId, 'user', txt);
          setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
        }
      }
    } else {
      const partial = (ctx.voskRec.partialResult().partial || '').trim();
      if (partial && partial !== ctx.lastPartial) {
        ctx.lastPartial = partial;
        socket.emit('transcription', { text: partial, isFinal: false });
      }
    }
  });

  socket.on('get_final_transcription', () => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx?.voskRec) return;
    const txt = (ctx.voskRec.finalResult().text || '').trim();
    if (!txt) return;
    socket.emit('transcription', { text: txt, isFinal: true });
    const STOP_CMDS_BYPASS_F = ['gracias alma','detente alma','adiós alma','adios alma',
                                  'hasta luego alma','para alma','chao alma','hasta pronto alma'];
    const isHardStopF = ctx.conversationActive &&
      STOP_CMDS_BYPASS_F.some(c => txt.toLowerCase().includes(c));

    if (ctx.activeRunner) {
      if (isHardStopF) {
        console.log(`🛑 [Conv] Stop command (final) durante test: "${txt.slice(0,30)}"`);
        ctx._byeRequestedDuringTest = true;
        ctx.activeRunner.destroy();
        return;
      }
      ctx.activeRunner.resolveSTT(txt); return;
    }
    if (!isHardStopF && (ctx.isProcessingTurn || Date.now() < ctx.speakingUntil)) {
      console.log(`🔇 [Conv] Final STT bloqueado (${ctx.isProcessingTurn ? 'LLM activo' : 'TTS sonando'}): "${txt.slice(0,30)}"`);
      return;
    }
    if (ctx.conversationActive) {
      if (ctx.conversationMode === 'wake_per_turn') {
        if (ctx.listeningForTurn && ctx.turnBuffer.trim()) {
          clearTimeout(ctx._turnTimer);
          flushTurn(ctx);
        }
      } else {
        // ── MARCA: fin de turno ASR ──────────────────────────────────────
        ctx.currentTurnMarks = {
          text:           txt,
          asr_final:      Date.now(),
          llm_first_char: null,
          tts_start:      null,
        };
        ctx.dialog.push({ role: 'user', content: txt });
        messageOps.add(ctx.sessionId, 'user', txt);
        setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
      }
    } else {
      ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + txt;
    }
  });

  socket.on('start_recording', () => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx) { socket.emit('audio_error', { error: 'Identifícate primero.' }); return; }
    ctx.isRecording = true;
    socket.emit('assistant_status', { status: 'idle' });
    console.log(`🎙️  Micrófono abierto: ${ctx.patient.name}`);
  });

  socket.on('stop_recording', () => {
    const ctx = activeSessions.get(socket.id);
    if (ctx) {
      ctx.isRecording = false;
      // Si la conversación seguía activa cuando se detuvo el micrófono, cerrar también la traza
      if (ctx.conversationActive) {
        ctx.conversationActive = false;
        ctx.endConversationRecording();
      }
      console.log(`⏹️  Micrófono cerrado: ${ctx.patient.name}`);
    }
  });

  socket.on('set_conversation_mode', ({ mode }) => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx || !['always_on', 'wake_per_turn'].includes(mode)) return;
    clearTimeout(ctx._turnTimer);
    ctx.listeningForTurn = false;
    ctx.turnBuffer       = '';
    ctx.conversationMode = mode;
    socket.emit('conversation_mode_changed', { mode });
    console.log(`🔀 [Mode] ${mode} — ${ctx.patient?.name}`);
  });

  // Cliente notifica que terminó de reproducir el audio TTS → liberar gate inmediatamente
  socket.on('tts_playback_ended', () => {
    const ctx = activeSessions.get(socket.id);
    if (ctx) ctx.speakingUntil = 0;
  });

  const statsInterval = setInterval(() => {
    const ctx = activeSessions.get(socket.id);
    try {
      socket.emit('server_stats', {
        activeConnections:  activeSessions.size,
        chunksReceived:     ctx?.chunksReceived    || 0,
        duration:           ctx?.firstChunkTime    ? Date.now() - ctx.firstChunkTime : 0,
        isRecording:        ctx?.isRecording       || false,
        conversationActive: ctx?.conversationActive || false,
        testActive:         !!(ctx?.activeRunner),
        patientName:        ctx?.patient?.name     || null,
        conversationMode:   ctx?.conversationMode  || 'always_on',
        listeningForTurn:   ctx?.listeningForTurn  || false,
      });
    } catch {}
  }, 2000);

  socket.on('disconnect', reason => {
    clearInterval(statsInterval);
    const ctx = activeSessions.get(socket.id);
    if (ctx) {
      // Guardar traza si la conversación quedó abierta al desconectar
      if (ctx.conversationActive || ctx.convStartedAt) {
        ctx.conversationActive = false;
        ctx.endConversationRecording();
      }
      ctx.freeVoskRec();
      if (ctx.activeRunner) ctx.activeRunner.destroy();
      if (ctx.sessionId) sessionOps.end(ctx.sessionId);
      activeSessions.delete(socket.id);
    }
    console.log(`🔴 ${socket.id} (${reason})`);
  });

  socket.on('error', e => console.error(`💥 Socket ${socket.id}:`, e.message));
});

/** ======================= REST ======================= */
app.post('/patients', (req, res) => {
  try {
    const { id, name, age, clinical_notes } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'id y name son requeridos.' });
    if (patientOps.getById(id)) return res.status(409).json({ error: 'Paciente ya existe.' });
    patientOps.create(id, name, age, clinical_notes);
    res.status(201).json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/patients',     (_req, res) => { try { res.json(patientOps.getAll()); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/patients/:id', (req,  res) => {
  try {
    const p = patientOps.getById(req.params.id);
    if (!p) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ...p, sessions: sessionOps.getAllForPatient(p.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/patients/:id', (req, res) => {
  try { patientOps.update(req.params.id, req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/patients/:id', (req, res) => {
  try { patientOps.delete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/patients/:id/sessions',  (req, res) => { try { res.json(sessionOps.getAllForPatient(req.params.id)); }   catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/patients/:id/evals',     (req, res) => { try { res.json(evaluationOps.getForPatient(req.params.id)); }    catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/sessions/:id/messages',  (req, res) => { try { res.json(messageOps.getForSession(req.params.id)); }       catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/evals/:id',              (req, res) => { try { res.json(evaluationOps.getById(req.params.id)); }           catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/stats', (_req, res) => res.json({
  activeSockets:      activeSessions.size,
  voskReady:          isVoskReady,
  saveAudio:          SAVE_AUDIO,
  llmModel:           LLM_MODEL,
  ttsUrl:             TTS_URL,
  uptime:             process.uptime(),
  defaultPatientId:   DEFAULT_PATIENT_ID,
  defaultPatientName: DEFAULT_PATIENT_NAME
}));
app.get('/test', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── API: listar trazas de conversación ──────────────────────────────────────
app.get('/conversations', (_req, res) => {
  try {
    const files = fs.readdirSync(audioDir)
      .filter(f => f.startsWith('conv_') && f.endsWith('.json'))
      .sort().reverse().slice(0, 50);
    const list = files.map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(audioDir, f), 'utf8'));
        const turns = d.turns || [];
        const llmLats = turns.map(t => t.L_llm_ms).filter(Boolean);
        return {
          file:       f,
          patientId:  d.patientId,
          startedAt:  d.startedAt,
          durationMs: d.durationMs,
          turns:      turns.length,
          p50_llm:    llmLats.length ? Math.round(llmLats.sort((a,b)=>a-b)[Math.floor(llmLats.length*0.5)]) : null,
          p95_llm:    llmLats.length ? Math.round(llmLats.sort((a,b)=>a-b)[Math.ceil(llmLats.length*0.95)-1]) : null,
        };
      } catch { return { file: f, error: 'parse error' }; }
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/conversations/:filename', (req, res) => {
  try {
    const fpath = path.join(audioDir, path.basename(req.params.filename));
    if (!fs.existsSync(fpath)) return res.status(404).json({ error: 'No encontrado.' });
    res.json(JSON.parse(fs.readFileSync(fpath, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** ======================= Debug (solo desarrollo) ======================= */
if (process.env.NODE_ENV !== 'production') {
  app.delete('/debug/evals/:patientId/today', (req, res) => {
    try { evaluationOps.deleteForPatientToday(req.params.patientId); res.json({ ok: true, message: `Evaluaciones de hoy borradas para ${req.params.patientId}` }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/debug/evals/:patientId/all', (req, res) => {
    try { evaluationOps.deleteAllForPatient(req.params.patientId); res.json({ ok: true, message: `Todas las evaluaciones borradas para ${req.params.patientId}` }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.delete('/debug/evals/id/:evalId', (req, res) => {
    try { evaluationOps.deleteById(req.params.evalId); res.json({ ok: true, message: `Evaluación ${req.params.evalId} borrada` }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/debug/evals/:patientId', (req, res) => {
    try {
      const rows = evaluationOps.getForPatient(req.params.patientId, 50);
      res.json({ count: rows.length, evals: rows.map(e => ({
        id: e.id, test_id: e.test_id, status: e.status,
        total_score: e.total_score, max_score: e.max_score,
        started_at: new Date(e.started_at).toISOString()
      }))});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
} else {
  app.use('/debug', (_req, res) => res.status(404).json({ error: 'Not found' }));
}

/** ======================= Arranque ======================= */
async function main() {
  await initDB();
  if (patientOps.getById(DEFAULT_PATIENT_ID)) {
    console.log(`✅ Paciente por defecto: ${DEFAULT_PATIENT_ID} (${DEFAULT_PATIENT_NAME})`);
  } else {
    patientOps.create(DEFAULT_PATIENT_ID, DEFAULT_PATIENT_NAME, DEFAULT_PATIENT_AGE,
      'Paciente de prueba generado automáticamente para desarrollo.');
    console.log(`🌱 Paciente por defecto creado: ${DEFAULT_PATIENT_ID} (${DEFAULT_PATIENT_NAME})`);
  }
  const voskOk = await initVosk();
  console.log(voskOk ? '🎤 Vosk listo' : '⚠️  Vosk no disponible');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ALMA en http://localhost:${PORT}`);
    console.log(`   SAVE_AUDIO: ${SAVE_AUDIO} | LLM: ${LLM_MODEL} | TTS: ${TTS_URL}`);
    console.log(`   Paciente default: ${DEFAULT_PATIENT_ID}\n`);
  });
}
main().catch(console.error);