// server.js (CommonJS, con IA local via Ollama)
// Cargar variables de entorno
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

app.use(express.static('public'));

// ------------------- Stats y carpetas -------------------
const stats = { totalConnections:0, activeConnections:0, totalAudioChunks:0, totalTranscriptions:0 };
const audioDir  = path.join(__dirname, 'audio');
const modelsDir = path.join(__dirname, 'models');
if (!fs.existsSync(audioDir))  fs.mkdirSync(audioDir,  { recursive:true });
if (!fs.existsSync(modelsDir)) fs.mkdirSync(modelsDir, { recursive:true });

// ------------------- Vosk -------------------
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

// ------------------- IA local (Ollama) -------------------
const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://localhost:11434';
const LLM_MODEL    = process.env.LLM_MODEL    || 'qwen2.5:7b-instruct';
const LLM_SYSTEM   = process.env.LLM_SYSTEM_PROMPT || 'Eres un asistente útil en español. Responde de forma conversacional y natural.';
const LLM_MAX_TOK  = parseInt(process.env.LLM_MAX_TOKENS || '512', 10);

// Llama a Ollama con /api/chat en modo streaming (NDJSON) y reenvía chunks al cliente
async function askLocalLLM(socket, dialog) {
  socket.emit('assistant_status', { status: 'thinking' });

  const body = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: LLM_SYSTEM }, ...dialog],
    stream: true,
    options: {
      num_predict: LLM_MAX_TOK,
      temperature: 0.7,
      top_p: 0.9
    }
  };

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

  // stream NDJSON → emitir chunks
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
        socket.emit('assistant_text_done', { text: full });
      }
    }
  }

  return; // el texto completo ya fue enviado en assistant_text_done
}

// ------------------- Ayudantes -------------------
const recognizers = new Map(); // socketId -> rec
const sessions = new Map();    // socketId -> { dialog:[], userBuffer:'', ... }

function displayTranscription(socketId, text, isFinal=false, confidence=0) {
  const t = new Date().toLocaleTimeString();
  console.log(`${isFinal?'\x1b[32m':'\x1b[33m'}[${t}] ${socketId.slice(0,8)} ${isFinal?'[FINAL]':'[PARCIAL]'}: ${text}${isFinal && confidence?` (${(confidence*100).toFixed(1)}% conf)`:''}\x1b[0m`);
}

// ------------------- Detección de Comandos por Voz -------------------
function processVoiceCommands(text, socketId) {
  const normalizedText = text.toLowerCase().trim();
  const session = sessions.get(socketId);
  
  if (!session) return { isCommand: false, action: null };
  
  // Comando de activación: "hola alma"
  if (normalizedText.includes('hola alma') && !session.conversationActive) {
    console.log(`🎯 Comando ACTIVACIÓN detectado: "hola alma" en sesión ${socketId}`);
    
    // Extraer la pregunta después del comando
    const question = normalizedText.replace('hola alma', '').trim();
    
    session.conversationActive = true;
    session.userBuffer = question || '';
    
    return { 
      isCommand: true, 
      action: 'start_conversation',
      question: question
    };
  }
  
  // Comandos de desactivación
  const stopCommands = ['gracias alma', 'detente alma', 'adiós alma', 'hasta luego alma'];
  for (const cmd of stopCommands) {
    if (normalizedText.includes(cmd) && session.conversationActive) {
      console.log(`🛑 Comando STOP detectado: "${cmd}" en sesión ${socketId}`);
      session.conversationActive = false;
      session.userBuffer = '';
      
      return { 
        isCommand: true, 
        action: 'stop_conversation',
        command: cmd
      };
    }
  }
  
  // Si la conversación está activa, acumular texto normal
  if (session.conversationActive && normalizedText) {
    session.userBuffer += (session.userBuffer ? ' ' : '') + normalizedText;
    return { isCommand: false, action: 'continue_conversation' };
  }
  
  return { isCommand: false, action: null };
}

// ------------------- Socket.IO -------------------
io.on('connection', (socket) => {
  stats.totalConnections++; stats.activeConnections++;
  console.log(`\n✅ Cliente conectado: ${socket.id} | Activos: ${stats.activeConnections}`);

  // WAV para esta conexión
  const filename = path.join(audioDir, `audio_${socket.id}_${Date.now()}.wav`);
  const writer = new wav.FileWriter(filename, { sampleRate:16000, channels:1, bitDepth:16 });

  // Sesión para diálogo
  const sess = { 
    dialog: [], 
    userBuffer: '', 
    conversationActive: false,  // Nueva propiedad para controlar estado conversacional
    startedAt: Date.now() 
  };
  sessions.set(socket.id, sess);

  // Vosk recognizer
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

  // Stats de sesión
  let chunksReceived = 0;
  let firstChunkTime = null;
  let lastPartial = '';

  const statsInterval = setInterval(() => {
    socket.emit('server_stats', {
      activeConnections: stats.activeConnections,
      chunksReceived,
      duration: firstChunkTime ? Date.now()-firstChunkTime : 0,
      totalTranscriptions: stats.totalTranscriptions,
      voskReady: isVoskReady,
      conversationActive: sess.conversationActive // Enviar estado de conversación
    });
  }, 2000);

  // ---- Audio entrante ----
  socket.on('audio_chunk', (data) => {
    try {
      if (!firstChunkTime) firstChunkTime = Date.now();
      chunksReceived++; stats.totalAudioChunks++;

      // array de int16 (como ya envías desde el front)
      const audioData = new Int16Array(data.chunk);
      const audioChunk = Buffer.from(audioData.buffer);

      // Guardar WAV completo
      writer.write(audioChunk);

      // Transcripción
      if (isVoskReady && rec) {
        const isFinal = rec.acceptWaveform(audioChunk);

        if (isFinal) {
          const r = rec.result();
          const txt = (r.text || '').trim();
          if (txt) {
            displayTranscription(socket.id, txt, true, r.confidence || 0);
            socket.emit('transcription', { 
              text: txt, 
              isFinal: true, 
              confidence: r.confidence || 0 
            });

            // 🆕 PROCESAMIENTO MEJORADO DE COMANDOS
            const commandResult = processVoiceCommands(txt, socket.id);
            
            if (commandResult.isCommand) {
              console.log(`🎯 Comando procesado: ${commandResult.action} para ${socket.id}`);
              
              // Emitir evento de comando detectado al frontend
              socket.emit('voice_command_detected', {
                action: commandResult.action,
                command: commandResult.command || 'hola alma',
                text: txt
              });
              
              // Si es comando de inicio y hay texto, procesar con IA
              if (commandResult.action === 'start_conversation' && sess.userBuffer.trim()) {
                setTimeout(async () => {
                  try {
                    console.log(`🤖 Iniciando conversación con: "${sess.userBuffer}"`);
                    sess.dialog.push({ role: 'user', content: sess.userBuffer });
                    await askLocalLLM(socket, sess.dialog);
                    // No limpiamos userBuffer aquí para continuar la conversación
                  } catch (e) {
                    console.error('💥 Error en respuesta automática IA:', e);
                  }
                }, 500);
              }
              // Si es comando de stop, limpiar buffer
              else if (commandResult.action === 'stop_conversation') {
                sess.userBuffer = '';
              }
            } 
            // Si no es comando pero la conversación está activa, procesar con IA
            else if (sess.conversationActive && txt.trim() && !commandResult.isCommand) {
              console.log(`💬 Continuando conversación: "${txt}"`);
              setTimeout(async () => {
                try {
                  sess.dialog.push({ role: 'user', content: txt });
                  await askLocalLLM(socket, sess.dialog);
                } catch (e) {
                  console.error('💥 Error en respuesta conversacional IA:', e);
                }
              }, 500);
            }
            // Comportamiento normal (sin conversación activa)
            else if (!sess.conversationActive) {
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

      // logs
      if (chunksReceived % 20 === 0) {
        const dur = firstChunkTime ? Date.now()-firstChunkTime : 0;
        console.log(`📊 ${socket.id}: ${chunksReceived} chunks, ${Math.round(dur/1000)}s, Conversación: ${sess.conversationActive ? 'ACTIVA' : 'INACTIVA'}`);
      }

      // acks
      if (chunksReceived % 10 === 0) {
        socket.emit('audio_ack', {
          chunksReceived, 
          totalBytes: writer.bytesWritten, 
          timestamp: Date.now(),
          conversationActive: sess.conversationActive
        });
      }

    } catch (e) {
      console.error('❌ Error procesando audio:', e);
      socket.emit('audio_error', { error: e.message });
    }
  });

  // Forzar final
  socket.on('get_final_transcription', () => {
    if (!rec) return;
    try {
      const finalResult = rec.finalResult();
      const txt = (finalResult.text || '').trim();
      if (txt) {
        displayTranscription(socket.id, txt, true, finalResult.confidence || 0);
        socket.emit('transcription', { text: txt, isFinal:true, confidence: finalResult.confidence || 0 });
        
        // Si la conversación está activa, procesar con IA
        if (sess.conversationActive && txt.trim()) {
          setTimeout(async () => {
            try {
              sess.dialog.push({ role: 'user', content: txt });
              await askLocalLLM(socket, sess.dialog);
            } catch (e) {
              console.error('💥 Error en respuesta final IA:', e);
            }
          }, 500);
        } else {
          sess.userBuffer += (sess.userBuffer ? ' ' : '') + txt;
        }
      }
    } catch (e) {
      console.error('❌ Error finalResult:', e);
    }
  });

  // Inicio / fin de grabación
  socket.on('start_recording', () => {
    console.log(`🎙️  start ${socket.id}`);
    socket.emit('assistant_status', { status:'idle' });
  });

  socket.on('stop_recording', async () => {
    console.log(`⏹️  stop  ${socket.id}`);
    // Al detener: si hay texto del usuario y no hay conversación activa, preguntamos al LLM
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

  // Desconexión
  socket.on('disconnect', (reason) => {
    stats.activeConnections--;
    console.log(`\n🔴 Cliente desconectado: ${socket.id} (${reason})`);

    // Cerrar Vosk
    if (rec) {
      try {
        const fin = rec.finalResult();
        if (fin.text && fin.text.trim()) {
          socket.emit('transcription', { text: fin.text, isFinal:true, confidence: fin.confidence || 0 });
          sess.userBuffer += (sess.userBuffer ? ' ' : '') + fin.text.trim();
        }
        rec.free();
      } catch (e) {
        console.error('❌ Error liberando Vosk:', e);
      }
      recognizers.delete(socket.id);
    }

    writer.end();
    clearInterval(statsInterval);

    // Persistir transcript (dialog con roles + métricas básicas)
    try {
      const transcriptFile = path.join(audioDir, `transcript_${socket.id}_${Date.now()}.json`);
      fs.writeFileSync(transcriptFile, JSON.stringify({
        socketId: socket.id,
        startedAt: sess.startedAt,
        endedAt: Date.now(),
        dialog: sess.dialog,
        chunksReceived,
        conversationActive: sess.conversationActive
      }, null, 2));
      console.log(`📄 Transcripción guardada: ${transcriptFile}`);
    } catch (e) {
      console.error('❌ Error guardando transcript:', e);
    }
  });

  socket.on('error', (e) => console.error(`💥 socket ${socket.id}:`, e));

  // Handshake
  socket.emit('connected', {
    message: 'Conectado al servidor de audio',
    sampleRate: 16000,
    expectedChunkSize: 4096,
    supportsTranscription: isVoskReady,
    transcriptionEngine: 'Vosk (Offline)',
    llm: { base: LLM_BASE_URL, model: LLM_MODEL }
  });

  console.log(`🎯 Esperando audio de: ${socket.id}`);
});

// ------------------- Endpoints extra -------------------
app.get('/test', (req, res) => {
  res.json({ status: 'Server running', timestamp: new Date().toISOString() });
});

app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    voskReady: isVoskReady,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
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
          conversationActive: content.conversationActive || false
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

// ------------------- Inicializar y arrancar -------------------
initializeVosk().then(ok => {
  console.log(ok ? '🎤 Vosk listo para transcripciones' : '⚠️  Vosk no disponible (transcripción desactivada)');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor en http://localhost:${PORT}`);
  console.log(`📊 /stats  📝 /transcriptions  🧪 /test`);
  console.log(`🎯 Comandos de voz activados:`);
  console.log(`   - Activación: "hola alma"`);
  console.log(`   - Desactivación: "gracias alma", "detente alma", "adiós alma", "hasta luego alma"`);
});