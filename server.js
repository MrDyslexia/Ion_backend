// Cargar variables de entorno desde .env
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const wav = require('wav');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware para servir archivos estáticos
app.use(express.static('public'));

// Ruta de prueba
app.get('/test', (req, res) => {
  res.json({ status: 'Server running', timestamp: new Date().toISOString() });
});

// Almacenar estadísticas y streams activos
const stats = {
  totalConnections: 0,
  activeConnections: 0,
  totalAudioChunks: 0,
  totalTranscriptions: 0
};

const audioDir = path.join(__dirname, 'audio');
const modelsDir = path.join(__dirname, 'models');

if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
  console.log(`📁 Created directory: ${audioDir}`);
}

if (!fs.existsSync(modelsDir)) {
  fs.mkdirSync(modelsDir, { recursive: true });
  console.log(`📁 Created directory: ${modelsDir}`);
}

// Configuración de Vosk
let vosk = null;
let voskModel = null;
let isVoskReady = false;

// Función para inicializar Vosk
const initializeVosk = async () => {
  try {
    console.log('🔄 Inicializando Vosk...');
    
    // Importar Vosk
    vosk = await import('vosk');
    
    // Verificar si el modelo existe
    const modelPath = path.join(modelsDir, 'vosk-model-small-es-0.42');
    if (!fs.existsSync(modelPath)) {
      console.log('📥 Modelo de Vosk no encontrado.');
      console.log('⚠️  Por favor descarga el modelo manualmente:');
      console.log('🔗 https://alphacephei.com/vosk/models');
      console.log('📁 Colócalo en:', modelPath);
      return false;
    }

    console.log('📖 Cargando modelo Vosk...');
    voskModel = new vosk.Model(modelPath);
    isVoskReady = true;
    console.log('✅ Vosk inicializado correctamente');
    console.log('🎤 Listo para transcripciones en tiempo real');
    console.log('=' .repeat(50));
    return true;
  } catch (error) {
    console.error('❌ Error inicializando Vosk:', error);
    return false;
  }
};

// Almacenar reconocedores por socket
const recognizers = new Map();

// Función para mostrar transcripción en consola con colores
function displayTranscription(socketId, text, isFinal = false, confidence = 0) {
  const timestamp = new Date().toLocaleTimeString();
  const socketShort = socketId.substring(0, 8);
  const status = isFinal ? 'FINAL' : 'PARCIAL';
  const color = isFinal ? '\x1b[32m' : '\x1b[33m'; // Verde para final, Amarillo para parcial
  const reset = '\x1b[0m';
  
  console.log(`${color}[${timestamp}] ${socketShort} [${status}]${reset}: ${text}`);
  
  if (isFinal && confidence > 0) {
    console.log(`${color}   Confianza: ${(confidence * 100).toFixed(1)}%${reset}`);
  }
}

io.on('connection', (socket) => {
  stats.totalConnections++;
  stats.activeConnections++;
  
  console.log(`\n✅ Cliente conectado: ${socket.id}`);
  console.log(`📊 Conexiones activas: ${stats.activeConnections}`);

  // Crear archivo único para este stream
  const filename = path.join(audioDir, `audio_${socket.id}_${Date.now()}.wav`);
  const writer = new wav.FileWriter(filename, {
    sampleRate: 16000,
    channels: 1,
    bitDepth: 16
  });

  let chunksReceived = 0;
  let firstChunkTime = null;
  let transcriptionBuffer = [];
  let lastPartialText = '';

  // Configurar reconocedor Vosk para este socket
  const setupVoskRecognizer = () => {
    if (!isVoskReady || !voskModel) {
      console.warn('⚠️ Vosk no está listo, ignorando transcripción');
      return null;
    }

    try {
      // Crear reconocedor con la API correcta
      const rec = new vosk.Recognizer({
        model: voskModel,
        sampleRate: 16000
      });

      recognizers.set(socket.id, rec);
      console.log(`🎤 Reconocedor Vosk creado para: ${socket.id}`);
      return rec;
    } catch (error) {
      console.error('❌ Error creando reconocedor Vosk:', error);
      return null;
    }
  };

  const recognizer = setupVoskRecognizer();

  // Enviar estadísticas periódicamente
  const statsInterval = setInterval(() => {
    socket.emit('server_stats', {
      activeConnections: stats.activeConnections,
      chunksReceived: chunksReceived,
      duration: firstChunkTime ? Date.now() - firstChunkTime : 0,
      totalTranscriptions: stats.totalTranscriptions,
      voskReady: isVoskReady
    });
  }, 2000);

  socket.on('audio_chunk', (data) => {
    try {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
        console.log(`\n🎙️  Iniciando captura de audio de: ${socket.id}`);
      }

      chunksReceived++;
      stats.totalAudioChunks++;

      // Convertir a Buffer (asumiendo que viene como array de números)
      const audioData = new Int16Array(data.chunk);
      const audioChunk = Buffer.from(audioData.buffer);

      // Escribir chunk al archivo WAV
      writer.write(audioChunk);

      // Procesar transcripción en tiempo real
      if (isVoskReady && recognizer) {
        try {
          // Procesar el audio chunk por chunk para mejor tiempo real
          const result = recognizer.acceptWaveform(audioChunk);
          
          if (result) {
            // Resultado final
            const transcription = recognizer.result();
            if (transcription.text && transcription.text.trim() !== '') {
              const transcriptionData = {
                text: transcription.text,
                isFinal: true,
                confidence: transcription.confidence || 0,
                result: transcription
              };

              // Mostrar en consola
              displayTranscription(socket.id, transcription.text, true, transcription.confidence);

              socket.emit('transcription', transcriptionData);

              stats.totalTranscriptions++;
              transcriptionBuffer.push({
                text: transcription.text,
                timestamp: new Date().toISOString(),
                confidence: transcription.confidence || 0
              });

              // Limpiar texto parcial anterior
              lastPartialText = '';
            }
          }
          
          // Siempre obtener resultado parcial para tiempo real
          const partial = recognizer.partialResult();
          if (partial.partial && partial.partial.trim() !== '' && partial.partial !== lastPartialText) {
            const partialData = {
              text: partial.partial,
              isFinal: false,
              confidence: 0
            };

            // Mostrar en consola (solo si cambió)
            displayTranscription(socket.id, partial.partial, false);
            
            socket.emit('transcription', partialData);
            lastPartialText = partial.partial;
          }

        } catch (transcribeError) {
          console.error('❌ Error en transcripción Vosk:', transcribeError);
        }
      }

      // Mostrar progreso cada 20 chunks
      if (chunksReceived % 20 === 0) {
        const duration = firstChunkTime ? Date.now() - firstChunkTime : 0;
        console.log(`📊 ${socket.id}: ${chunksReceived} chunks, ${Math.round(duration/1000)}s`);
      }

      // Enviar confirmación cada 10 chunks
      if (chunksReceived % 10 === 0) {
        socket.emit('audio_ack', {
          chunksReceived: chunksReceived,
          totalBytes: writer.bytesWritten,
          timestamp: Date.now()
        });
      }

    } catch (error) {
      console.error('❌ Error procesando audio:', error);
      socket.emit('audio_error', { error: error.message });
    }
  });

  // Evento para forzar transcripción final
  socket.on('get_final_transcription', () => {
    if (recognizer) {
      try {
        const finalResult = recognizer.finalResult();
        if (finalResult.text && finalResult.text.trim() !== '') {
          displayTranscription(socket.id, finalResult.text, true, finalResult.confidence);
          socket.emit('transcription', {
            text: finalResult.text,
            isFinal: true,
            confidence: finalResult.confidence || 0,
            result: finalResult
          });
        }
      } catch (error) {
        console.error('❌ Error obteniendo transcripción final:', error);
      }
    }
  });

  // Evento cuando el cliente inicia la grabación
  socket.on('start_recording', () => {
    console.log(`\n🎙️  Cliente ${socket.id} inició grabación`);
  });

  // Evento cuando el cliente detiene la grabación
  socket.on('stop_recording', () => {
    console.log(`⏹️  Cliente ${socket.id} detuvo grabación`);
  });

  socket.on('disconnect', (reason) => {
    stats.activeConnections--;
    console.log(`\n🔴 Cliente desconectado: ${socket.id} - Razón: ${reason}`);
    console.log(`📊 Conexiones activas: ${stats.activeConnections}`);

    // Finalizar reconocedor Vosk
    if (recognizer) {
      try {
        // Obtener resultado final
        const finalResult = recognizer.finalResult();
        if (finalResult.text && finalResult.text.trim() !== '') {
          const finalTranscription = {
            text: finalResult.text,
            isFinal: true,
            confidence: finalResult.confidence || 0,
            result: finalResult
          };

          // Mostrar transcripción final en consola
          displayTranscription(socket.id, finalResult.text, true, finalResult.confidence);

          socket.emit('transcription', finalTranscription);

          transcriptionBuffer.push({
            text: finalResult.text,
            timestamp: new Date().toISOString(),
            confidence: finalResult.confidence || 0
          });
        }

        // Liberar recursos
        recognizer.free();
      } catch (error) {
        console.error('❌ Error finalizando reconocedor:', error);
      }
      recognizers.delete(socket.id);
    }

    writer.end();
    clearInterval(statsInterval);

    // Guardar transcripción completa
    if (transcriptionBuffer.length > 0) {
      const transcriptFile = path.join(audioDir, `transcript_${socket.id}_${Date.now()}.json`);
      fs.writeFileSync(transcriptFile, JSON.stringify({
        socketId: socket.id,
        startTime: firstChunkTime,
        endTime: Date.now(),
        duration: firstChunkTime ? Date.now() - firstChunkTime : 0,
        chunksReceived: chunksReceived,
        transcriptions: transcriptionBuffer
      }, null, 2));
      console.log(`\n📄 Transcripción guardada: ${transcriptFile}`);
    }

    // Mostrar resumen final
    const duration = firstChunkTime ? Date.now() - firstChunkTime : 0;
    console.log(`\n📊 RESUMEN FINAL ${socket.id}:`);
    console.log(`   Chunks procesados: ${chunksReceived}`);
    console.log(`   Duración total: ${Math.round(duration/1000)} segundos`);
    console.log(`   Transcripciones: ${transcriptionBuffer.length}`);
    console.log(`   Archivo de audio: ${filename}`);
  });

  socket.on('error', (error) => {
    console.error(`\n💥 Error en socket ${socket.id}:`, error);
  });

  // Enviar configuración al cliente
  socket.emit('connected', {
    message: 'Conectado al servidor de audio',
    sampleRate: 16000,
    expectedChunkSize: 4096,
    supportsTranscription: isVoskReady,
    transcriptionEngine: 'Vosk (Offline)'
  });

  console.log(`🎯 Esperando audio de: ${socket.id}`);
});

// Endpoints adicionales
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
      .filter(file => file.startsWith('transcript_') && file.endsWith('.json'))
      .map(file => {
        const filePath = path.join(audioDir, file);
        const stats = fs.statSync(filePath);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          filename: file,
          created: stats.birthtime,
          size: stats.size,
          transcriptions: content.transcriptions.length,
          duration: content.duration,
          chunks: content.chunksReceived
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 10);

    res.json(transcriptFiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para ver una transcripción específica
app.get('/transcription/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(audioDir, filename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Transcripción no encontrada' });
    }

    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    res.json(content);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint para ver el estado de Vosk
app.get('/vosk-status', (req, res) => {
  res.json({
    ready: isVoskReady,
    modelLoaded: !!voskModel,
    activeRecognizers: recognizers.size
  });
});

// Inicializar Vosk al arrancar
initializeVosk().then(success => {
  if (success) {
    console.log('🎤 Vosk listo para transcripciones');
  } else {
    console.log('⚠️  Transcripción desactivada - Vosk no disponible');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`📊 Endpoint de stats: http://localhost:${PORT}/stats`);
  console.log(`📝 Endpoint de transcripciones: http://localhost:${PORT}/transcriptions`);
  console.log(`🎤 Estado de Vosk: http://localhost:${PORT}/vosk-status`);
  console.log(`🧪 Endpoint de test: http://localhost:${PORT}/test`);
  console.log('\n🎯 Esperando conexiones de clientes...');
});