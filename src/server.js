require('dotenv').config();
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const wav      = require('wav');
const fs       = require('fs');
const path     = require('path');
const { initDB, patientOps, sessionOps, messageOps, buildDialog, COMPRESS_THRESHOLD } = require('./db');

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
      body:    JSON.stringify({ text, language: "es" })
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    const arrayBuf = await resp.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    console.log(`⏱️  [TTS ] ${buf.length} bytes → ${Date.now()-_t0tts}ms`);
    return buf;
  } catch (e) {
    console.error(`❌ TTS error (${Date.now()-_t0tts}ms):`, e.message);
    return null;
  }
}

/** ======================= System prompt ======================= */
function buildSystemPrompt(patient) {
  const now  = new Date();
  const ts   = now.toLocaleString('es-CL', { weekday:'short', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const notas = patient.clinical_notes ? ` Notas: ${patient.clinical_notes}.` : '';
  return `Eres ALMA, asistente de salud. respond only in Spanish, never use Chinese or any other language, sé breve y empático.
${ts}. Paciente: ${patient.name}, ${patient.age} años.${notas}
Tras tu primera respuesta pregunta si acepta evaluación breve. Si acepta, haz UNA a la vez en orden:
1)año actual 2)mes actual 3)pide repetir "Manuel Rodrigues 1373 Santiago" 4)hora aprox 5)contar atrás 20→1 6)meses inverso desde diciembre 7)repetir dirección.
Normas: una pregunta por turno, no corrijas respuestas, sé paciente.`;
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
  }
];

async function executeTool(name, args) {
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
  return 'Herramienta desconocida.';
}

/** ======================= LLM streaming + tool use ======================= */
async function askLLM(socket, dialog, sessionId, patient) {
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
            console.log(`⏱️  [LLM ] primer token → ${Date.now()-_t0llm}ms`);
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
      const result = await executeTool(fnName, fnArgs);
      console.log(`🔧 Result: ${result}`);
      dialog.push({ role: 'assistant', content: '', tool_calls: [toolCall] });
      dialog.push({ role: 'tool', content: result });
      continue;
    }

    fullResponse = streamText;
    console.log(`⏱️  [LLM ] respuesta completa (${fullResponse.length} chars) → ${Date.now()-_t0llm}ms`);
    break;
  }

  if (fullResponse.trim() && sessionId) {
    messageOps.add(sessionId, 'assistant', fullResponse);
    dialog.push({ role: 'assistant', content: fullResponse });
  }

  socket.emit('assistant_text_done', { text: fullResponse });
  socket.emit('assistant_status', { status: 'idle' });

  // Comprimir contexto si es necesario
  if (sessionId && messageOps.countForSession(sessionId) > COMPRESS_THRESHOLD) {
    compressContext(sessionId, dialog, patient).catch(console.error);
  }

  // TTS
  if (fullResponse.trim()) {
    synthesizeSpeech(fullResponse).then(audioBuf => {
      if (audioBuf) socket.emit('tts_audio', { audio: audioBuf.toString('base64'), mimeType: 'audio/wav' });
    }).catch(e => console.error('❌ TTS pipeline:', e.message));
  }

  return fullResponse;
}

/** ======================= Compresión de contexto ======================= */
async function compressContext(sessionId, dialog, patient) {
  const allMsgs = dialog.filter(m => m.role !== 'system');
  if (allMsgs.length < 10) return;
  const toCompress = allMsgs.slice(0, allMsgs.length - 10);
  const prompt = `Resume brevemente esta conversación entre ALMA y el paciente ${patient.name}. Incluye respuestas a preguntas de evaluación. Máximo 3 oraciones.\n\n${toCompress.map(m => `${m.role === 'user' ? 'Paciente' : 'ALMA'}: ${m.content}`).join('\n')}`;
  try {
    const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: LLM_MODEL, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 200, temperature: 0.3 } })
    });
    const d = await resp.json();
    const summary = d.message?.content?.trim();
    if (summary) { sessionOps.saveSummary(sessionId, summary); console.log(`🗜️ Contexto comprimido para sesión ${sessionId}`); }
  } catch (e) { console.error('❌ Compresión:', e.message); }
}

/** ======================= SessionContext ======================= */
const activeSessions = new Map();

class SessionContext {
  constructor(socket, patient, sessionId, dialog) {
    this.socket              = socket;
    this.patient             = patient;
    this.sessionId           = sessionId;
    this.dialog              = dialog;
    this.voskRec             = null;
    this.isRecording         = false;
    this.conversationActive  = false;
    this.userBuffer          = '';
    this.wavWriter           = null;
    this.lastPartial         = '';
    this.chunksReceived      = 0;
    this.firstChunkTime      = null;
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
}

/** ======================= Comandos de voz ======================= */
function processVoiceCommands(text, ctx) {
  const t = text.toLowerCase().trim();

  if (t.includes('hola alma') && !ctx.conversationActive) {
    const question = t.split('hola alma')[1]?.trim() || '';
    ctx.conversationActive = true;
    if (question) { ctx.dialog.push({ role: 'user', content: question }); messageOps.add(ctx.sessionId, 'user', question); }
    return { isCommand: true, action: 'start_conversation', question };
  }

  const stopCmds = ['gracias alma', 'detente alma', 'adiós alma', 'hasta luego alma', 'para alma'];
  if (stopCmds.some(c => t.includes(c)) && ctx.conversationActive) {
    ctx.conversationActive = false;
    ctx.userBuffer = '';
    return { isCommand: true, action: 'stop_conversation' };
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
    message:              'Conectado a ALMA',
    sampleRate:           16000,
    supportsTranscription: isVoskReady,
    tts:                  { enabled: true, engine: 'XTTS-v2' }
  });

  socket.on('identify', ({ patientId }) => {
    if (!patientId) { socket.emit('identify_error', { error: 'Código requerido.' }); return; }
    const patient = patientOps.getById(patientId);
    if (!patient) { socket.emit('identify_error', { error: `Paciente "${patientId}" no encontrado.` }); return; }

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

    socket.emit('identified', { patientId, patientName: patient.name, sessionId, isNewSession, messageCount: messageOps.countForSession(sessionId) });
    console.log(`👤 ${patient.name} (${patientId}) — sesión ${sessionId}`);
  });

  socket.on('audio_chunk', data => {
    const ctx = activeSessions.get(socket.id);
    if (!ctx) return;
    if (!ctx.firstChunkTime) ctx.firstChunkTime = Date.now();
    ctx.chunksReceived++;
    const audioBuf = Buffer.from(new Int16Array(data.chunk).buffer);
    ctx.writeAudioChunk(audioBuf);
    if (!isVoskReady || !ctx.voskRec) return;

    const _t0stt = Date.now();
    if (ctx.voskRec.acceptWaveform(audioBuf)) {
      const r   = ctx.voskRec.result();
      const txt = (r.text || '').trim();
      if (!txt) return;
      console.log(`⏱️  [STT ] "${txt.slice(0,40)}" → ${Date.now()-_t0stt}ms`);
      socket.emit('transcription', { text: txt, isFinal: true, confidence: r.confidence || 0 });
      const cmd = processVoiceCommands(txt, ctx);
      if (cmd.isCommand) {
        socket.emit('voice_command_detected', { action: cmd.action, text: txt });
        if (cmd.action === 'start_conversation' && cmd.question)
          setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient).catch(console.error), 300);
      } else if (ctx.conversationActive && txt.trim()) {
        ctx.dialog.push({ role: 'user', content: txt });
        messageOps.add(ctx.sessionId, 'user', txt);
        setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient).catch(console.error), 300);
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
    if (ctx.conversationActive) {
      ctx.dialog.push({ role: 'user', content: txt });
      messageOps.add(ctx.sessionId, 'user', txt);
      setTimeout(() => askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient).catch(console.error), 300);
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
    console.log(`🎙️ Recording start: ${ctx.patient.name}`);
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
    if (question && !ctx.conversationActive) {
      ctx.dialog.push({ role: 'user', content: question });
      messageOps.add(ctx.sessionId, 'user', question);
      ctx.userBuffer = '';
      await askLLM(socket, ctx.dialog, ctx.sessionId, ctx.patient).catch(console.error);
    }
    sessionOps.end(ctx.sessionId);
    console.log(`⏹️ Recording stop: ${ctx.patient.name}`);
  });

  const statsInterval = setInterval(() => {
    const ctx = activeSessions.get(socket.id);
    try {
      socket.emit('server_stats', {
        activeConnections:  activeSessions.size,
        chunksReceived:     ctx?.chunksReceived  || 0,
        duration:           ctx?.firstChunkTime  ? Date.now() - ctx.firstChunkTime : 0,
        isRecording:        ctx?.isRecording     || false,
        conversationActive: ctx?.conversationActive || false,
        patientName:        ctx?.patient?.name   || null
      });
    } catch {}
  }, 2000);

  socket.on('disconnect', reason => {
    clearInterval(statsInterval);
    const ctx = activeSessions.get(socket.id);
    if (ctx) { ctx.endWavWriter(); ctx.freeVoskRec(); if (ctx.sessionId) sessionOps.end(ctx.sessionId); activeSessions.delete(socket.id); }
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
    const r = patientOps.update(req.params.id, req.body);
    if (!r?.changes) return res.status(404).json({ error: 'No encontrado.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/patients/:id', (req, res) => {
  try { patientOps.delete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/patients/:id/sessions',    (req, res) => { try { res.json(sessionOps.getAllForPatient(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/sessions/:id/messages',    (req, res) => { try { res.json(messageOps.getForSession(req.params.id)); }   catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/stats', (_req, res) => res.json({ activeSockets: activeSessions.size, voskReady: isVoskReady, saveAudio: SAVE_AUDIO, llmModel: LLM_MODEL, ttsUrl: TTS_URL, uptime: process.uptime() }));
app.get('/test',  (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

/** ======================= Arranque ======================= */
(async () => {
  await initDB();
  const voskOk = await initVosk();
  console.log(voskOk ? '🎤 Vosk listo' : '⚠️  Vosk no disponible');
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ALMA en http://localhost:${PORT}`);
    console.log(`   SAVE_AUDIO: ${SAVE_AUDIO} | LLM: ${LLM_MODEL} | TTS: ${TTS_URL}\n`);
  });
})();