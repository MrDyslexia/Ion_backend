// download-model.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const modelsDir = path.join(__dirname, 'models');
const modelUrl = 'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip';
const modelPath = path.join(modelsDir, 'vosk-model-small-es-0.42.zip');
const extractPath = path.join(modelsDir);

function downloadModel() {
  console.log('📥 Descargando modelo de Vosk (español)...');
  console.log('🔗 URL:', modelUrl);

  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  if (fs.existsSync(path.join(extractPath, 'vosk-model-small-es-0.42'))) {
    console.log('✅ Modelo ya existe, omitiendo descarga');
    return;
  }

  const file = fs.createWriteStream(modelPath);
  
  https.get(modelUrl, (response) => {
    if (response.statusCode !== 200) {
      console.error('❌ Error en la descarga:', response.statusCode);
      return;
    }

    const totalSize = parseInt(response.headers['content-length'], 10);
    let downloaded = 0;

    response.on('data', (chunk) => {
      downloaded += chunk.length;
      const percent = ((downloaded / totalSize) * 100).toFixed(1);
      process.stdout.write(`\r📥 Descargando: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
    });

    response.pipe(file);
    
    file.on('finish', () => {
      file.close();
      console.log('\n✅ Modelo descargado. Extrayendo...');
      extractModel();
    });
  }).on('error', (err) => {
    console.error('\n❌ Error descargando el modelo:', err.message);
    manualDownloadInstructions();
  });
}

function extractModel() {
  try {
    if (process.platform === 'win32') {
      // Windows
      execSync(`powershell -command "Expand-Archive -Path '${modelPath}' -DestinationPath '${extractPath}' -Force"`);
    } else {
      // Linux/Mac
      execSync(`unzip -q -o ${modelPath} -d ${extractPath}`);
    }
    
    // Verificar extracción
    if (fs.existsSync(path.join(extractPath, 'vosk-model-small-es-0.42'))) {
      // Eliminar archivo zip
      fs.unlinkSync(modelPath);
      console.log('✅ Modelo extraído y listo para usar');
      console.log(`📁 Ruta del modelo: ${path.join(extractPath, 'vosk-model-small-es-0.42')}`);
    } else {
      throw new Error('La extracción falló');
    }
  } catch (error) {
    console.error('❌ Error extrayendo el modelo:', error);
    manualDownloadInstructions();
  }
}

function manualDownloadInstructions() {
  console.log('\n💡 Instrucciones para descarga manual:');
  console.log('1. Ve a: https://alphacephei.com/vosk/models');
  console.log('2. Descarga: vosk-model-small-es-0.42.zip');
  console.log('3. Extrae el contenido en:', path.join(modelsDir, 'vosk-model-small-es-0.42'));
  console.log('4. La estructura debe ser: models/vosk-model-small-es-0.42/am/final.mdl etc.');
}

downloadModel();