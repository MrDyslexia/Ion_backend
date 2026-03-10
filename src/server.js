require('dotenv').config();
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const wav      = require('wav');
const fs       = require('fs');
const path     = require('path');

const {
  initDB, patientOps, sessionOps, messageOps,
  evaluationOps, buildDialog, COMPRESS_THRESHOLD
} = require('./db');

const { TestRunner, CancelledError } = require('./engine/TestRunner');
const { getTest }                    = require('./engine/tests/registry');

const app    = express();
const server = http.createServer(app);
const io     = socketIo(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(express.json());
app.use(express.static('public'));

/** ======================= Directorios ======================= */
const audioDir  = path.join(__dirname, '../audio');
const modelsDir = path.join(__dirname, 'models');
[audioDir, modelsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/** ======================= Config ======================= */
const SAVE_AUDIO   = process.env.SAVE_AUDIO === 'true';
const LLM_BASE_URL = process.env.LLM_BASE_URL  || 'http://localhost:11434';
const LLM_MODEL    = process.env.LLM_MODEL     || 'qwen2.5:7b';
const LLM_MAX_TOK  = parseInt(process.env.LLM_MAX_TOKENS || '512', 10);
const TTS_URL      = process.env.TTS_URL        || 'http://localhost:8002';
const PORT         = parseInt(process.env.PORT  || '3000', 10);

// Paciente por defecto para sesiones de prueba
const DEFAULT_PATIENT_ID   = process.env.DEFAULT_PATIENT_ID   || 'DEV-001';
const DEFAULT_PATIENT_NAME = process.env.DEFAULT_PATIENT_NAME || 'Paciente de Prueba';
const DEFAULT_PATIENT_AGE  = parseInt(process.env.DEFAULT_PATIENT_AGE || '70', 10);

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

/** ======================= TTS ======================= */
async function synthesizeSpeech(text) {
  const _t0tts = Date.now();
  try {
    const resp = await fetch(`${TTS_URL}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, language: 'es' })
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    console.log(`⏱️  [TTS ] ${buf.length} bytes → ${Date.now() - _t0tts}ms`);
    return buf;
  } catch (e) {
    console.error(`❌ TTS error (${Date.now() - _t0tts}ms):`, e.message);
    return null;
  }
}

// Exponer synthesizeSpeech para que TestRunner lo use via ttsHelper
// ttsHelper.js lee TTS_URL del env directamente, así que no necesita importar esto.

/** ======================= System prompt ======================= */
function buildSystemPrompt(patient) {
  const now = new Date();
  const ts  = now.toLocaleString('es-CL', {
    weekday: 'short', day: 'numeric', month: 'short',
    year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const notas = patient.clinical_notes ? ` Notas clínicas: ${patient.clinical_notes}.` : '';

  return `Eres ALMA, asistente de salud cognitiva. Responde siempre en español. Sé breve, cálido y empático.
Fecha y hora actual: ${ts}.
Paciente: ${patient.name}, ${patient.age} años.${notas}

Al inicio de la conversación, saluda al paciente y pregunta cómo se siente hoy.
Cuando el paciente esté dispuesto y lo pida o lo acepte, ofrécele una evaluación breve de memoria.
Si acepta, usa la herramienta conduct_test con testId "sixcit".
NO administres el test manualmente. NO hagas preguntas de evaluación tú mismo.
La evaluación la conduce el sistema de forma estructurada.`;
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
      description: 'Busca información en la web usando DuckDuckGo.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Consulta de búsqueda en español' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'conduct_test',
      description: 'Conduce una evaluación cognitiva estructurada con el paciente. Úsala cuando el paciente acepte realizar una evaluación.',
      parameters: {
        type: 'object',
        properties: {
          testId: {
            type: 'string',
            enum: ['sixcit'],
            description: 'Identificador del test a realizar'
          }
        },
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
    try {
      const q   = encodeURIComponent(args.query || '');
      const r   = await fetch(`https://api.duckduckgo.com/?q=${q}&format=json&no_redirect=1&no_html=1`);
      const d   = await r.json();
      const ans = d.AbstractText || d.Answer || d.RelatedTopics?.[0]?.Text || '';
      return ans || 'Sin resultados disponibles.';
    } catch (e) { return `Error en búsqueda: ${e.message}`; }
  }

  if (name === 'conduct_test') {
    const { testId } = args;
    if (!testId) return 'Error: se requiere testId.';
    if (!ctx)    return 'Error: contexto de sesión no disponible.';

    if (ctx.activeRunner) return 'Ya hay una evaluación en curso.';

    if (evaluationOps.hasTestToday(ctx.patient.id)) {
      return 'El paciente ya realizó una evaluación hoy. No es necesario repetirla.';
    }

    // Lanzar el test de forma asíncrona, sin bloquear el tool call del LLM
    setImmediate(async () => {
      const runner = new TestRunner(ctx);
      ctx.activeRunner = runner;
      try {
        const test   = getTest(testId);
        const result = await test.run(ctx, runner);
        evaluationOps.save(ctx.sessionId, ctx.patient.id, result);
        console.log(`✅ [Test] ${testId} → ${result.status}, score: ${result.totalScore}/${result.maxScore}`);

        // Informar al LLM del resultado — pasar ctx para que conduct_test no se llame de nuevo
        // Post-test: limpiar el diálogo de entradas del test para que el LLM
        // no tenga acceso a puntajes ni resultados en la próxima interacción.
        // Se eliminan tool_calls, tool results y mensajes de sistema del test.
        ctx.dialog = ctx.dialog.filter(m => {
          if (m.role === 'tool')      return false;  // tool results con puntajes
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) return false;
          if (m.role === 'system'    && m.content?.includes('conduct_test'))    return false;
          if (m.role === 'system'    && m.content?.includes('evaluación'))      return false;
          if (m.role === 'system'    && m.content?.includes('Evaluación'))      return false;
          return true;
        });
        // Agregar nota de sistema mínima: solo instrucción de comportamiento, sin datos del test
        ctx.dialog.push({ role: 'system', content: 'No invoques conduct_test en esta sesión.' });
        ctx.conversationActive = false;
        console.log(`🔕 [Test] Post-test: diálogo limpiado, ALMA en espera pasiva.`);
      } catch (e) {
        if (e instanceof CancelledError) {
          console.log(`⚠️  [Test] ${testId} cancelado por el paciente`);
        } else {
          console.error(`❌ [Test] ${testId} error inesperado:`, e.message);
        }
      } finally {
        ctx.activeRunner = null;
      }
    });

    // Marcar que el test está iniciando — askLLM suprimirá su TTS
    ctx._testJustStarted = true;
    return `Iniciando evaluación ${testId}. El sistema tomará control del flujo de voz.`;
  }

  return 'Herramienta desconocida.';
}

/** ======================= LLM streaming + tool use ======================= */
async function askLLM(socket, dialog, sessionId, patient, ctx = null) {
  socket.emit('assistant_status', { status: 'thinking' });
  const _t0llm = Date.now();
  let _firstTokenLogged = false;

  const MAX_ITER = 3;
  let iter = 0;
  let fullResponse = '';

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

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', streamText = '', toolCall = null;

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
          if (!_firstTokenLogged) {
            console.log(`⏱️  [LLM ] primer token → ${Date.now() - _t0llm}ms`);
            _firstTokenLogged = true;
          }
          streamText += delta;
          socket.emit('assistant_text', { delta });
        }
        if (data.message?.tool_calls?.length) toolCall = data.message.tool_calls[0];
      }
    }

    if (toolCall) {
      const fnName = toolCall.function?.name;
      const fnArgs = toolCall.function?.arguments || {};
      console.log(`🔧 Tool: ${fnName}`, fnArgs);
      // Pasar ctx solo para conduct_test
      const result = await executeTool(fnName, fnArgs, ctx);
      console.log(`🔧 Result: ${result}`);
      dialog.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
      dialog.push({ role: 'tool',      content: result });
      continue;
    }

    fullResponse = streamText;
    console.log(`⏱️  [LLM ] respuesta completa (${fullResponse.length} chars) → ${Date.now() - _t0llm}ms`);
    break;
  }

  if (fullResponse.trim() && sessionId) {
    messageOps.add(sessionId, 'assistant', fullResponse);
    dialog.push({ role: 'assistant', content: fullResponse });
  }

  socket.emit('assistant_text_done', { text: fullResponse });
  socket.emit('assistant_status',    { status: 'idle' });

  if (sessionId && messageOps.countForSession(sessionId) > COMPRESS_THRESHOLD) {
    compressContext(sessionId, dialog, patient).catch(console.error);
  }

  // Suprimir TTS si el runner acaba de tomar el control de voz
  const suppressTTS = ctx?._testJustStarted || ctx?.activeRunner;
  if (ctx) ctx._testJustStarted = false;

  if (fullResponse.trim() && !suppressTTS) {
    synthesizeSpeech(fullResponse).then(audioBuf => {
      if (audioBuf) socket.emit('tts_audio', { audio: audioBuf.toString('base64'), mimeType: 'audio/wav' });
    }).catch(e => console.error('❌ TTS pipeline:', e.message));
  } else if (suppressTTS && fullResponse.trim()) {
    console.log('🔇 [LLM ] TTS suprimido — runner activo');
  }

  return fullResponse;
}

/** ======================= Compresión de contexto ======================= */
async function compressContext(sessionId, dialog, patient) {
  const allMsgs = dialog.filter(m => m.role !== 'system');
  if (allMsgs.length < 10) return;
  const toCompress = allMsgs.slice(0, allMsgs.length - 10);
  const prompt = `Resume brevemente esta conversación entre ALMA y el paciente ${patient.name}. Máximo 3 oraciones.\n\n${toCompress.map(m => `${m.role === 'user' ? 'Paciente' : 'ALMA'}: ${m.content}`).join('\n')}`;
  try {
    const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 200, temperature: 0.3 } })
    });
    const d = await resp.json();
    const summary = d.message?.content?.trim();
    if (summary) { sessionOps.saveSummary(sessionId, summary); console.log(`🗜️  Contexto comprimido: ${sessionId}`); }
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
    this.wavWriter          = null;
    this.lastPartial        = '';
    this.chunksReceived     = 0;
    this.firstChunkTime     = null;
    this.activeRunner       = null;   // TestRunner activo, null si no hay test en curso
    this._testJustStarted   = false;  // flag para suprimir TTS del LLM al iniciar test
    // VAD state (solo activo durante test)
    this.vadEnabled         = false;
    this.vadIsSpeaking      = false;
    this.vadSilenceTimer    = null;
    this.vadSilenceMs       = 1800;   // ms de silencio para declarar fin de habla
    this.vadSpeechThreshold = 300;    // RMS mínimo para considerar habla (0–32767)
  }

  createVoskRec() {
    if (!isVoskReady || !voskModel) return;
    try { this.voskRec = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 }); this.voskRec.setWords(true); }
    catch (e) { console.error('❌ Vosk recognizer:', e); }
  }

  freeVoskRec() {
    if (this.voskRec) { try { this.voskRec.free(); } catch {} this.voskRec = null; }
  }

  startWavWriter() {
    if (!SAVE_AUDIO) return;
    const filename = path.join(audioDir, `audio_${this.socket.id}_${Date.now()}.wav`);
    this.wavWriter = new wav.FileWriter(filename, { sampleRate: 16000, channels: 1, bitDepth: 16 });
    this.wavWriter.on('error', e => console.error('❌ WAV writer:', e.message));
  }

  endWavWriter() {
    if (this.wavWriter) { try { this.wavWriter.end(); } catch {} this.wavWriter = null; }
  }

  writeAudioChunk(buf) {
    if (SAVE_AUDIO && this.wavWriter && this.isRecording) {
      try { this.wavWriter.write(buf); } catch (e) { console.error('❌ Write chunk:', e.message); }
    }
  }

  /**
   * Procesa un chunk PCM16 para detección de actividad de voz (VAD).
   * Solo opera cuando vadEnabled=true (durante espera de respuesta larga en test).
   * Llama a activeRunner.onVadSpeech() / onVadSilence() según corresponda.
   */
  processVAD(int16Array) {
    if (!this.vadEnabled || !this.activeRunner) return;

    // Calcular RMS del chunk
    let sum = 0;
    for (let i = 0; i < int16Array.length; i++) sum += int16Array[i] * int16Array[i];
    const rms = Math.sqrt(sum / int16Array.length);

    if (rms >= this.vadSpeechThreshold) {
      // Hay habla
      if (!this.vadIsSpeaking) {
        this.vadIsSpeaking = true;
        this.activeRunner.onVadSpeech?.();
      }
      // Resetear timer de silencio
      clearTimeout(this.vadSilenceTimer);
      this.vadSilenceTimer = setTimeout(() => {
        if (this.vadEnabled && this.vadIsSpeaking) {
          this.vadIsSpeaking = false;
          this.activeRunner?.onVadSilence?.();
        }
      }, this.vadSilenceMs);
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
function processVoiceCommands(text, ctx) {
  const t = text.toLowerCase().trim();

  if (t.includes('hola alma') && !ctx.conversationActive) {
    const question = t.split('hola alma')[1]?.trim() || '';
    ctx.conversationActive = true;
    if (question) { ctx.dialog.push({ role: 'user', content: question }); messageOps.add(ctx.sessionId, 'user', question); }
    return { isCommand: true, action: 'start_conversation', question, greet: !question };
  }

  const stopCmds = ['gracias alma', 'detente alma', 'adiós alma', 'hasta luego alma', 'para alma'];
  if (stopCmds.some(c => t.includes(c)) && ctx.conversationActive) {
    ctx.conversationActive = false;
    ctx.userBuffer = '';
    return { isCommand: true, action: 'stop_conversation', farewell: true };
  }

  if (ctx.conversationActive && t) {
    ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + t;
    return { isCommand: false, action: 'continue_conversation' };
  }

  if (!ctx.conversationActive && t) ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + t;

  return { isCommand: false, action: null };
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
    const int16 = new Int16Array(data.chunk);
    const audioBuf = Buffer.from(int16.buffer);
    ctx.writeAudioChunk(audioBuf);
    ctx.processVAD(int16);   // VAD solo activo cuando runner lo habilita
    if (!isVoskReady || !ctx.voskRec) return;

    const _t0stt = Date.now();
    if (ctx.voskRec.acceptWaveform(audioBuf)) {
      const r   = ctx.voskRec.result();
      const txt = (r.text || '').trim();
      if (!txt) return;
      console.log(`⏱️  [STT ] "${txt.slice(0, 40)}" → ${Date.now() - _t0stt}ms`);
      socket.emit('transcription', { text: txt, isFinal: true, confidence: r.confidence || 0 });

      // ── Si hay un test activo, redirigir al runner ──
      if (ctx.activeRunner) {
        ctx.activeRunner.resolveSTT(txt);
        return; // no procesar como conversación normal
      }

      // ── Flujo normal de conversación ──
      const cmd = processVoiceCommands(txt, ctx);
      if (cmd.isCommand) {
        socket.emit('voice_command_detected', { action: cmd.action, text: txt });
        if (cmd.action === 'stop_conversation' && cmd.farewell) {
          const byeMsg = 'El paciente se despidió. Responde SOLO con una frase corta de despedida. Nada más.';
          ctx.dialog.push({ role: 'system', content: byeMsg });
          setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
        }
        if (cmd.action === 'start_conversation') {
          if (cmd.question) {
            setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
          } else {
            // Sin pregunta adicional → inyectar saludo para que ALMA responda
            const greetMsg = 'El paciente te saludó. Responde SOLO con un saludo breve (máximo una oración). No hagas preguntas, no ofrezcas ayuda, no agregues nada más.';
            ctx.dialog.push({ role: 'system', content: greetMsg });
            setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
          }
        }
      } else if (ctx.conversationActive && txt.trim()) {
        ctx.dialog.push({ role: 'user', content: txt });
        messageOps.add(ctx.sessionId, 'user', txt);
        setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
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

    // Si hay un test activo, redirigir
    if (ctx.activeRunner) {
      ctx.activeRunner.resolveSTT(txt);
      return;
    }

    if (ctx.conversationActive) {
      ctx.dialog.push({ role: 'user', content: txt });
      messageOps.add(ctx.sessionId, 'user', txt);
      setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error), 300);
    } else {
      ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + txt;
    }
  });

  socket.on('start_recording', () => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx) { socket.emit('audio_error', { error: 'Identifícate primero.' }); return; }
    ctx.isRecording = true;
    ctx.startWavWriter();
    socket.emit('assistant_status', { status: 'idle' });
    console.log(`🎙️  Recording start: ${ctx.patient.name}`);
  });

  socket.on('stop_recording', async () => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx) return;
    ctx.isRecording = false;
    ctx.endWavWriter();
    try {
      fs.writeFileSync(
        path.join(audioDir, `transcript_${socket.id}_${Date.now()}.json`),
        JSON.stringify({ patientId: ctx.patient.id, sessionId: ctx.sessionId, endedAt: Date.now(), dialog: ctx.dialog }, null, 2)
      );
    } catch {}
    const question = ctx.userBuffer.trim();
    if (question && !ctx.conversationActive && !ctx.activeRunner) {
      ctx.dialog.push({ role: 'user', content: question });
      messageOps.add(ctx.sessionId, 'user', question);
      ctx.userBuffer = '';
      await askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient, ctx).catch(console.error);
    }
    sessionOps.end(ctx.sessionId);
    console.log(`⏹️  Recording stop: ${ctx.patient.name}`);
  });

  const statsInterval = setInterval(() => {
    const ctx = activeSessions.get(socket.id);
    try {
      socket.emit('server_stats', {
        activeConnections:  activeSessions.size,
        chunksReceived:     ctx?.chunksReceived   || 0,
        duration:           ctx?.firstChunkTime   ? Date.now() - ctx.firstChunkTime : 0,
        isRecording:        ctx?.isRecording      || false,
        conversationActive: ctx?.conversationActive || false,
        testActive:         !!(ctx?.activeRunner),
        patientName:        ctx?.patient?.name    || null
      });
    } catch {}
  }, 2000);

  socket.on('disconnect', reason => {
    clearInterval(statsInterval);
    const ctx = activeSessions.get(socket.id);
    if (ctx) {
      ctx.endWavWriter();
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
  try {
    patientOps.update(req.params.id, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

/** ======================= Debug (solo desarrollo) ======================= */
// DELETE /debug/evals/:patientId/today  → borra evaluaciones de hoy
app.delete('/debug/evals/:patientId/today', (req, res) => {
  try {
    evaluationOps.deleteForPatientToday(req.params.patientId);
    res.json({ ok: true, message: `Evaluaciones de hoy borradas para ${req.params.patientId}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /debug/evals/:patientId/all  → borra TODAS las evaluaciones del paciente
app.delete('/debug/evals/:patientId/all', (req, res) => {
  try {
    evaluationOps.deleteAllForPatient(req.params.patientId);
    res.json({ ok: true, message: `Todas las evaluaciones borradas para ${req.params.patientId}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /debug/evals/id/:evalId  → borra una evaluación específica por id
app.delete('/debug/evals/id/:evalId', (req, res) => {
  try {
    evaluationOps.deleteById(req.params.evalId);
    res.json({ ok: true, message: `Evaluación ${req.params.evalId} borrada` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /debug/evals/:patientId  → lista todas las evaluaciones (cualquier estado)
app.get('/debug/evals/:patientId', (req, res) => {
  try {
    const rows = evaluationOps.getForPatient(req.params.patientId, 50);
    res.json({ count: rows.length, evals: rows.map(e => ({
      id:         e.id,
      test_id:    e.test_id,
      status:     e.status,
      total_score: e.total_score,
      max_score:  e.max_score,
      started_at: new Date(e.started_at).toISOString()
    }))});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** ======================= Arranque ======================= */
(async () => {
  await initDB();

  // Seed: asegurar que el paciente por defecto existe
  if (!patientOps.getById(DEFAULT_PATIENT_ID)) {
    patientOps.create(DEFAULT_PATIENT_ID, DEFAULT_PATIENT_NAME, DEFAULT_PATIENT_AGE,
      'Paciente de prueba generado automáticamente para desarrollo.');
    console.log(`🌱 Paciente por defecto creado: ${DEFAULT_PATIENT_ID} (${DEFAULT_PATIENT_NAME})`);
  } else {
    console.log(`✅ Paciente por defecto: ${DEFAULT_PATIENT_ID} (${DEFAULT_PATIENT_NAME})`);
  }

  const voskOk = await initVosk();
  console.log(voskOk ? '🎤 Vosk listo' : '⚠️  Vosk no disponible');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ALMA en http://localhost:${PORT}`);
    console.log(`   SAVE_AUDIO: ${SAVE_AUDIO} | LLM: ${LLM_MODEL} | TTS: ${TTS_URL}`);
    console.log(`   Paciente default: ${DEFAULT_PATIENT_ID}\n`);
  });
})();
