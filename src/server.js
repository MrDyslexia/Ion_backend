require('dotenv').config();
const express  = require('express');
const http     = require('http');
const socketIo = require('socket.io');
const wav      = require('wav');
const fs       = require('fs');
const path     = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET","POST"] } });

/** ======================= Estado ======================= */
const activeRecordings = new Map(); // socketId -> { writer, filename, session, completed, hadError }
const recognizers = new Map();      // socketId -> rec
const sessions = new Map();         // socketId -> { dialog:[], userBuffer:'', ... }

app.use(express.static('public'));
const stats = { totalConnections:0, activeConnections:0, totalAudioChunks:0, totalTranscriptions:0 };

const audioDir  = path.join(__dirname, '../audio');
const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(audioDir))  fs.mkdirSync(audioDir,  { recursive:true });
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive:true });

/** ======================= Vosk ======================= */
let vosk = null;
let voskModel = null;
let isVoskReady = false;

const initializeVosk = async () => {
  try {
    console.log('🔄 Inicializando Vosk...');
    vosk = await import('vosk');
    const modelPath = path.join(modelsDir, 'vosk-model-es-0.42');
    if (!fs.existsSync(modelPath)) {
      console.log('⚠️  Modelo Vosk no encontrado en', modelPath);
      return false;
    }
    console.log('📖 Cargando modelo Vosk...');
    voskModel = new vosk.Model(modelPath);
    isVoskReady = true;
    console.log('✅ Vosk inicializado');
    return true;
  } catch (e) {
    console.error('❌ Error inicializando Vosk:', e);
    return false;
  }
};

/** ======================= LLM ======================= */
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://localhost:11434';
const LLM_MODEL    = process.env.LLM_MODEL    || 'qwen2.5:7b-instruct';
const LLM_SYSTEM   = `Eres ALMA (Asistente Lingüístico de Monitoreo Amigable). Eres un asistente de inteligencia artificial que se comunica exclusivamente en español. Tu estilo debe ser breve, claro, empático y directo. Tu objetivo principal es guiar al usuario a través de una serie de preguntas y actividades de evaluación, una por una, dándole todo el tiempo necesario para responder.
DESPUÉS de responder a la PRIMERA pregunta que el usuario te haga (sobre cualquier tema), tu siguiente acción obligatoria es preguntarle: "¿Estaría dispuesto/a a contestar una breve serie de preguntas y actividades para evaluar su estado actual?"
Solo si acepta, procederás con la siguiente secuencia EN ORDEN y UNA POR UNA:
1. Pregunta: "¿Qué año es?" - Espera su respuesta
2. Pregunta: "¿Qué mes es?" - Espera su respuesta
3. Instrucción: "Ahora, necesito que recuerde la siguiente dirección para el futuro: 'Manuel Rodrigues 1373, Santiago'. Por favor, repítala para confirmar que la ha entendido correctamente." - Espera a que repita la dirección correctamente, sino, pídele que lo intente de nuevo
4. Pregunta: "¿Qué hora es aproximadamente?" - Espera su respuesta
5. Instrucción: "Ahora, por favor, cuente hacia atrás desde el 20 hasta el 1." - Espera a que complete la cuenta
6. Instrucción: "Ahora, diga los meses del año en orden inverso, empezando por diciembre." - Espera a que lo haga
7. Pregunta Final: "Para finalizar, por favor, repita la frase de dirección que le dije anteriormente." - Espera su respuesta
REGLAS CLAVE:
- No des opiniones: No comentes si sus respuestas son correctas o incorrectas, solo guía el proceso
- Una a la vez: Nunca hagas más de una pregunta o instrucción en un mismo mensaje
- Paciencia: Después de cada pregunta/instrucción, cede siempre el turno al usuario y espera por su respuesta completa
- Confirmación: Puede que el usuario tomar mas de un intento para responder correctamente, sé paciente y empático
- Claridad: Si el usuario parece confundido, reformula la pregunta de manera más sencilla
- Foco: Si el usuario se desvía, reconduce suavemente hacia la siguiente pregunta de la lista`;

const LLM_MAX_TOK  = parseInt(process.env.LLM_MAX_TOKENS || '512', 10);

async function askLocalLLM(socket, dialog) {
  socket.emit('assistant_status', { status: 'thinking' });
  const body = {
    model: LLM_MODEL,
    messages: dialog,
    stream: true,
    options: { num_predict: LLM_MAX_TOK, temperature: 0.7, top_p: 0.9 }
  };
  try {
    const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok || !resp.body) {
      const msg = `LLM error: ${resp.status} ${resp.statusText}`;
      socket.emit('assistant_error', { error: msg });
      throw new Error(msg);
    }

    const reader  = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });

      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;

        let data;
        try { data = JSON.parse(line); } catch { continue; }

        if (data.message?.content) {
          const delta = data.message.content;
          full += delta;
          socket.emit('assistant_text', { delta });
        }
        if (data.done) {
          const session = sessions.get(socket.id);
          if (session && session.conversationActive && full.trim()) {
            session.dialog.push({ role: 'assistant', content: full });
            session.messageCount = session.dialog.length - 1;
          }
          socket.emit('assistant_text_done', { text: full });
        }
      }
    }
    return full;
  } catch (error) {
    console.error('💥 Error en askLocalLLM:', error);
    try { socket.emit('assistant_error', { error: error.message }); } catch {}
    throw error;
  }
}

/** ======================= Utilidades ======================= */
function displayTranscription(socketId, text, isFinal=false, confidence=0) {
  const t = new Date().toLocaleTimeString();
  console.log(`${isFinal?'\x1b[32m':'\x1b[33m'}[${t}] ${socketId.slice(0,8)} ${isFinal?'[FINAL]':'[PARCIAL]'}: ${text}${isFinal && confidence?` (${(confidence*100).toFixed(1)}% conf)`:''}\x1b[0m`);
}

/** ======================= Conversación ======================= */
class ConversationManager {
  startConversation(session, initialQuestion = '') {
    session.conversationActive = true;
    session.conversationStart = Date.now();
    session.dialog = [ { role: 'system', content: LLM_SYSTEM } ];
    if (initialQuestion) session.dialog.push({ role: 'user', content: initialQuestion });
    session.messageCount = session.dialog.length - 1;
    console.log(`🎯 Nueva conversación iniciada: "${initialQuestion || '(sin pregunta inicial)'}"`);
  }
  addMessage(session, role, content) {
    session.dialog.push({ role, content });
    session.messageCount = session.dialog.length - 1;
    console.log(`💬 Mensaje agregado (${role}): ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`);
  }
  resetConversation(session) {
    console.log('🔄 Reiniciando contexto de conversación');
    session.conversationActive = false;
    session.conversationStart = null;
    session.userBuffer = '';
    session.dialog = [{ role: 'system', content: LLM_SYSTEM }];
    session.messageCount = 0;
  }
  getConversationState(session) {
    return {
      active: session.conversationActive,
      messageCount: session.messageCount,
      duration: session.conversationStart ? Date.now() - session.conversationStart : 0,
      hasHistory: session.messageCount > 0
    };
  }
}
const conversationManager = new ConversationManager();

/** ======================= Comandos por voz ======================= */
function processVoiceCommands(text, socketId) {
  const normalizedText = text.toLowerCase().trim();
  const session = sessions.get(socketId);
  if (!session) return { isCommand: false, action: null };

  if (normalizedText.includes('hola alma') && !session.conversationActive) {
    const question = normalizedText.split('hola alma')[1]?.trim() || '';
    conversationManager.startConversation(session, question);
    return { isCommand: true, action: 'start_conversation', question };
  }

  const stopCommands = ['gracias alma', 'detente alma', 'adiós alma', 'hasta luego alma', 'para alma'];
  for (const cmd of stopCommands) {
    if (normalizedText.includes(cmd) && session.conversationActive) {
      conversationManager.resetConversation(session);
      return { isCommand: true, action: 'stop_conversation', command: cmd };
    }
  }

  if ((normalizedText.includes('nueva conversación') || normalizedText.includes('empezar de nuevo')) && session.conversationActive) {
    conversationManager.resetConversation(session);
    return { isCommand: true, action: 'reset_conversation' };
  }

  if (session.conversationActive && normalizedText) {
    session.userBuffer += (session.userBuffer ? ' ' : '') + normalizedText;
    return { isCommand: false, action: 'continue_conversation' };
  }
  return { isCommand: false, action: null };
}

/** ======================= Socket.IO ======================= */
io.on('connection', (socket) => {
  stats.totalConnections++; stats.activeConnections++;
  console.log(`\n✅ Cliente conectado: ${socket.id} | Activos: ${stats.activeConnections}`);

  // Sesión
  const sess = {
    dialog: [{ role: 'system', content: LLM_SYSTEM }],
    userBuffer: '',
    conversationActive: false,
    conversationStart: null,
    messageCount: 0,
    startedAt: Date.now(),
    audioFilename: null,
    isRecording: false
  };
  sessions.set(socket.id, sess);

  // Reconocedor Vosk
  let rec = null;
  if (isVoskReady && voskModel) {
    try {
      rec = new vosk.Recognizer({ model: voskModel, sampleRate: 16000 });
      rec.setWords(true);
      recognizers.set(socket.id, rec);
      console.log(`🎤 Reconocedor Vosk creado para: ${socket.id}`);
    } catch (e) {
      console.error('❌ Error creando reconocedor Vosk:', e);
    }
  }

  // Stats
  let chunksReceived = 0;
  let firstChunkTime = null;
  let lastPartial = '';

  const statsInterval = setInterval(() => {
    try {
      socket.emit('server_stats', {
        activeConnections: stats.activeConnections,
        chunksReceived,
        duration: firstChunkTime ? Date.now()-firstChunkTime : 0,
        totalTranscriptions: stats.totalTranscriptions,
        voskReady: isVoskReady,
        conversationState: conversationManager.getConversationState(sess),
        isRecording: sess.isRecording
      });
    } catch {}
  }, 2000);

  /** ===== Helpers de grabación ===== */
  function attachWriter(socketId, filename) {
    const writer = new wav.FileWriter(filename, { sampleRate:16000, channels:1, bitDepth:16 });

    // Asegura que no crashee el proceso si hay error asíncrono (como ENOENT)
    writer.on('error', (err) => {
      const rec = activeRecordings.get(socketId);
      if (rec) rec.hadError = true;
      console.error(`💥 FileWriter error (${socketId}):`, err?.code || err?.message || err);
      try { io.to(socketId).emit('audio_error', { error: String(err?.message || err) }); } catch {}
    });

    writer.on('finish', () => {
      console.log(`✅ FileWriter finish: ${filename}`);
    });

    activeRecordings.set(socketId, {
      writer,
      filename,
      session: sess,
      completed: false,
      hadError: false
    });
    return writer;
  }

  /** ===== Audio entrante ===== */
  socket.on('audio_chunk', (data) => {
    try {
      if (!firstChunkTime) firstChunkTime = Date.now();
      chunksReceived++; stats.totalAudioChunks++;

      const audioData = new Int16Array(data.chunk);
      const audioChunk = Buffer.from(audioData.buffer);

      // Escribir sólo si hay grabación activa y writer existente
      const recInfo = activeRecordings.get(socket.id);
      if (sess.isRecording && recInfo && recInfo.writer && !recInfo.hadError) {
        try { recInfo.writer.write(audioChunk); } catch (e) {
          console.error('❌ Error escribiendo chunk:', e.message);
        }
      }

      // Transcripción
      if (isVoskReady && rec) {
        const isFinal = rec.acceptWaveform(audioChunk);

        if (isFinal) {
          const r = rec.result();
          const txt = (r.text || '').trim();
          if (txt) {
            displayTranscription(socket.id, txt, true, r.confidence || 0);
            socket.emit('transcription', { text: txt, isFinal: true, confidence: r.confidence || 0 });

            const commandResult = processVoiceCommands(txt, socket.id);

            if (commandResult.isCommand) {
              socket.emit('voice_command_detected', {
                action: commandResult.action,
                command: commandResult.command || 'hola alma',
                text: txt,
                conversationState: conversationManager.getConversationState(sess)
              });
              if (commandResult.action === 'start_conversation' && commandResult.question) {
                setTimeout(async () => {
                  try { await askLocalLLM(socket, sess.dialog); } catch (e) { console.error('💥 Error LLM inicio:', e); }
                }, 500);
              }
            } else if (sess.conversationActive && txt.trim()) {
              conversationManager.addMessage(sess, 'user', txt);
              setTimeout(async () => {
                try { await askLocalLLM(socket, sess.dialog); } catch (e) { console.error('💥 Error LLM conversacional:', e); }
              }, 500);
            } else if (!sess.conversationActive) {
              sess.userBuffer += (sess.userBuffer ? ' ' : '') + txt;
            }
          }
        } else {
          const p = rec.partialResult();
          const partial = (p.partial || '').trim();
          if (partial && partial !== lastPartial) {
            lastPartial = partial;
            displayTranscription(socket.id, partial, false);
            socket.emit('transcription', { text: partial, isFinal:false, confidence: 0 });
          }
        }
      }

      if (chunksReceived % 20 === 0) {
        const dur = firstChunkTime ? Date.now()-firstChunkTime : 0;
        console.log(`📊 ${socket.id}: ${chunksReceived} chunks, ${Math.round(dur/1000)}s, Grabación: ${sess.isRecording ? 'ACTIVA' : 'INACTIVA'}`);
      }
      if (chunksReceived % 10 === 0) {
        const totalBytes = recInfo?.writer?.bytesWritten ?? 0;
        socket.emit('audio_ack', {
          chunksReceived,
          totalBytes,
          timestamp: Date.now(),
          conversationState: conversationManager.getConversationState(sess),
          isRecording: sess.isRecording
        });
      }
    } catch (e) {
      console.error('❌ Error procesando audio:', e);
      socket.emit('audio_error', { error: e.message });
    }
  });

  /** ===== Final forzado ===== */
  socket.on('get_final_transcription', () => {
    if (!rec) return;
    try {
      const finalResult = rec.finalResult();
      const txt = (finalResult.text || '').trim();
      if (txt) {
        displayTranscription(socket.id, txt, true, finalResult.confidence || 0);
        socket.emit('transcription', { text: txt, isFinal:true, confidence: finalResult.confidence || 0 });

        if (sess.conversationActive && txt.trim()) {
          setTimeout(async () => {
            try {
              sess.dialog.push({ role: 'user', content: txt });
              await askLocalLLM(socket, sess.dialog);
            } catch (e) { console.error('💥 Error en respuesta final IA:', e); }
          }, 500);
        } else {
          sess.userBuffer += (sess.userBuffer ? ' ' : '') + txt;
        }
      }
    } catch (e) {
      console.error('❌ Error finalResult:', e);
    }
  });

  /** ===== Inicio / fin de grabación ===== */
  socket.on('start_recording', () => {
    console.log(`🎙️  start ${socket.id}`);
    try {
      // Crear writer SOLO aquí
      const filename = path.join(audioDir, `audio_${socket.id}_${Date.now()}.wav`);
      attachWriter(socket.id, filename);
      sess.audioFilename = filename;
      sess.isRecording = true;
      socket.emit('assistant_status', { status:'idle' });
    } catch (e) {
      console.error('❌ Error en start_recording:', e.message);
      socket.emit('audio_error', { error: e.message });
    }
  });

  socket.on('stop_recording', async () => {
    console.log(`⏹️  stop  ${socket.id}`);
    sess.isRecording = false;

    // Cerrar archivo WAV y guardar transcripción si hay writer
    try {
      const recording = activeRecordings.get(socket.id);
      if (recording?.writer && !recording.hadError) {
        recording.completed = true;
        try { recording.writer.end(); } catch (e) { console.error('❌ end writer:', e.message); }
        console.log(`💾 Archivo de audio guardado: ${recording.filename}`);

        // Guardar transcripción
        const transcriptFile = path.join(audioDir, `transcript_${socket.id}_${Date.now()}.json`);
        try {
          fs.writeFileSync(transcriptFile, JSON.stringify({
            socketId: socket.id,
            startedAt: sess.startedAt,
            endedAt: Date.now(),
            dialog: sess.dialog,
            chunksReceived,
            conversationActive: sess.conversationActive,
            audioFile: recording.filename,
            messageCount: sess.messageCount
          }, null, 2));
          console.log(`📄 Transcripción guardada: ${transcriptFile}`);
        } catch (e) {
          console.error('❌ Error guardando transcripción:', e.message);
        }
      }
      // No crear un nuevo writer aquí (evita la condición de carrera)
      activeRecordings.delete(socket.id);
      sess.audioFilename = null;
    } catch (e) {
      console.error('❌ Error guardando al detener:', e);
    }

    // Procesar con IA si hay texto acumulado y no hay conversación activa
    const question = (sess.userBuffer || '').trim();
    if (question && !sess.conversationActive) {
      try {
        sess.dialog.push({ role:'user', content: question });
        await askLocalLLM(socket, sess.dialog);
        socket.emit('assistant_status', { status:'idle' });
        stats.totalTranscriptions++;
        sess.userBuffer = '';
      } catch (e) {
        console.error('💥 LLM error:', e);
      }
    }
  });

  /** ===== Gestión de conversación ===== */
  socket.on('get_conversation_state', () => {
    socket.emit('conversation_state', conversationManager.getConversationState(sess));
  });

  socket.on('reset_conversation', () => {
    conversationManager.resetConversation(sess);
    socket.emit('conversation_reset', { message: 'Conversación reiniciada' });
    console.log(`🔄 Conversación reiniciada manualmente para: ${socket.id}`);
  });

  /** ===== Desconexión ===== */
  socket.on('disconnect', (reason) => {
    stats.activeConnections--;
    console.log(`\n🔴 Cliente desconectado: ${socket.id} (${reason})`);

    // Cerrar Vosk
    if (rec) {
      try {
        const fin = rec.finalResult();
        if (fin.text && fin.text.trim()) {
          try { socket.emit('transcription', { text: fin.text, isFinal:true, confidence: fin.confidence || 0 }); } catch {}
          sess.userBuffer += (sess.userBuffer ? ' ' : '') + fin.text.trim();
        }
        rec.free();
      } catch (e) {
        console.error('❌ Error liberando Vosk:', e);
      }
      recognizers.delete(socket.id);
    }

    // Cerrar writer si existe (sin recrear ni borrar archivo aquí)
    const recording = activeRecordings.get(socket.id);
    if (recording) {
      try {
        if (recording.writer) {
          try { recording.writer.end(); } catch (e) { /* writer ya destruido */ }
          console.log(`🔴 Writer cerrado para: ${socket.id}`);
        }
      } catch (e) {
        console.error('❌ Error en limpieza de grabación (no fatal):', e.message);
      }
      activeRecordings.delete(socket.id);
    }

    clearInterval(statsInterval);
    sessions.delete(socket.id);
    console.log(`✅ Limpieza completada para: ${socket.id}`);
  });

  /** ===== Errores de socket ===== */
  socket.on('error', (e) => {
    console.error(`💥 Error en socket ${socket.id}:`, e.message);
  });

  /** ===== Handshake ===== */
  socket.emit('connected', {
    message: 'Conectado al servidor de audio',
    sampleRate: 16000,
    expectedChunkSize: 4096,
    supportsTranscription: isVoskReady,
    transcriptionEngine: 'Vosk (Offline)',
    llm: { base: LLM_BASE_URL, model: LLM_MODEL },
    conversationFeatures: {
      enabled: true,
      unlimitedMessages: true,
      activationPhrase: 'hola alma'
    }
  });

  console.log(`🎯 Esperando audio de: ${socket.id}`);
});

/** ======================= Endpoints extra ======================= */
app.get('/test', (req, res) => {
  res.json({
    status: 'Server running',
    timestamp: new Date().toISOString(),
    features: {
      conversationManagement: true,
      voiceCommands: true,
      unlimitedMessages: true,
      activationPhrase: 'hola alma'
    }
  });
});

app.get('/stats', (req, res) => {
  const activeSessions = Array.from(sessions.values()).filter(s => s.conversationActive).length;
  res.json({
    ...stats,
    voskReady: isVoskReady,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    activeConversations: activeSessions,
    totalSessions: sessions.size
  });
});

app.get('/conversations/active', (req, res) => {
  try {
    const activeConversations = Array.from(sessions.entries())
      .filter(([id, session]) => session.conversationActive)
      .map(([id, session]) => ({
        socketId: id,
        messageCount: session.messageCount,
        duration: session.conversationStart ? Date.now() - session.conversationStart : 0,
        lastMessage: session.dialog[session.dialog.length - 1]?.content || 'N/A'
      }));
    res.json({ activeCount: activeConversations.length, conversations: activeConversations });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/transcriptions', (req, res) => {
  try {
    const transcriptFiles = fs.readdirSync(audioDir)
      .filter(f => f.startsWith('transcript_') && f.endsWith('.json'))
      .map(f => {
        const fp = path.join(audioDir, f);
        const st = fs.statSync(fp);
        const content = JSON.parse(fs.readFileSync(fp, 'utf8'));
        return {
          filename: f,
          created: st.birthtime,
          size: st.size,
          dialogTurns: content.dialog?.length || 0,
          chunks: content.chunksReceived || 0,
          conversationActive: content.conversationActive || false,
          messageCount: content.messageCount || 0,
          duration: (content.endedAt || st.mtimeMs) - (content.startedAt || st.birthtimeMs)
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 10);
    res.json(transcriptFiles);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/transcription/:filename', (req, res) => {
  try {
    const filePath = path.join(audioDir, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error:'Transcripción no encontrada' });
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/conversations/reset-all', (req, res) => {
  try {
    let resetCount = 0;
    sessions.forEach((session) => {
      if (session.conversationActive) {
        conversationManager.resetConversation(session);
        resetCount++;
      }
    });
    res.json({ message: `Se reiniciaron ${resetCount} conversaciones activas`, resetCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** ======================= Arranque ======================= */
initializeVosk().then(ok => {
  console.log(ok ? '🎤 Vosk listo para transcripciones' : '⚠️  Vosk no disponible (transcripción desactivada)');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📊 /stats  📝 /transcriptions  🧪 /test  💬 /conversations/active`);
  console.log(`🎯 Sistema de conversación ALMA activado:`);
  console.log(`   - Activación: "hola alma"`);
  console.log(`   - Desactivación: "gracias alma", "detente alma", etc.`);
  console.log(`   - Mensajes: ILIMITADOS`);
  console.log(`   - Contexto conversacional completo preservado`);
});
