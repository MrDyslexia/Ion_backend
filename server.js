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

// Almacenar estadísticas
const stats = {
  totalConnections: 0,
  activeConnections: 0,
  totalAudioChunks: 0
};
const audioDir = path.join(__dirname, 'audio');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
  console.log(`📁 Created directory: ${audioDir}`);
}
io.on('connection', (socket) => {
  stats.totalConnections++;
  stats.activeConnections++;
  
  console.log(`✅ Cliente conectado: ${socket.id}`);
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

  // Enviar estadísticas periódicamente
  const statsInterval = setInterval(() => {
    socket.emit('server_stats', {
      activeConnections: stats.activeConnections,
      chunksReceived: chunksReceived,
      duration: firstChunkTime ? Date.now() - firstChunkTime : 0
    });
  }, 2000);

  socket.on('audio_chunk', (data) => {
    try {
      if (!firstChunkTime) {
        firstChunkTime = Date.now();
      }

      chunksReceived++;
      stats.totalAudioChunks++;

      // Escribir chunk al archivo WAV
      writer.write(Buffer.from(data.chunk));

      // Enviar confirmación cada 10 chunks para no saturar
      if (chunksReceived % 10 === 0) {
        socket.emit('audio_ack', {
          chunksReceived: chunksReceived,
          totalBytes: writer.bytesWritten,
          timestamp: Date.now()
        });

        console.log(`🎵 ${socket.id}: ${chunksReceived} chunks, ${writer.bytesWritten} bytes`);
      }
    } catch (error) {
      console.error('❌ Error procesando audio:', error);
      socket.emit('audio_error', { error: error.message });
    }
  });

  socket.on('disconnect', (reason) => {
    stats.activeConnections--;
    console.log(`🔴 Cliente desconectado: ${socket.id} - Razón: ${reason}`);
    console.log(`📊 Conexiones activas: ${stats.activeConnections}`);

    // Finalizar archivo
    writer.end();
    clearInterval(statsInterval);

    // Mostrar resumen
    const duration = firstChunkTime ? Date.now() - firstChunkTime : 0;
    console.log(`📁 Archivo guardado: ${filename}`);
    console.log(`📊 Resumen: ${chunksReceived} chunks, ${duration}ms`);
  });

  socket.on('error', (error) => {
    console.error(`💥 Error en socket ${socket.id}:`, error);
  });

  // Enviar configuración al cliente
  socket.emit('connected', {
    message: 'Conectado al servidor de audio',
    sampleRate: 16000,
    expectedChunkSize: 4096
  });
});

// Endpoint para ver estadísticas
app.get('/stats', (req, res) => {
  res.json({
    ...stats,
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`📊 Endpoint de stats: http://localhost:${PORT}/stats`);
  console.log(`🧪 Endpoint de test: http://localhost:${PORT}/test`);
});