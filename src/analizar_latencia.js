/**
 * analizar_latencia.js
 * ALMA — Análisis de latencia fin-de-turno
 *
 * Lee todos los archivos transcript_*.json del directorio /audio
 * y calcula p50/p95 de L = llm_first_char - asr_final por caso de estudio.
 *
 * Uso:
 *   node analizar_latencia.js [--dir ../audio] [--caso CS1]
 *
 * Los archivos JSON deben tener el campo:
 *   marks: { asr_final, llm_first_char, tts_start, ws_first_chunk }
 * y opcionalmente un campo:
 *   caso: "CS1" | "CS2" | "CS3" | "CS5"
 *
 * Si no tiene campo "caso", puedes pasarlo como argumento:
 *   node analizar_latencia.js --caso CS1
 * (asignará el caso a todos los archivos sin campo caso)
 */

const fs = require('fs');
const path = require('path');

// ── Configuración ──────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const AUDIO_DIR = getArg('--dir') || path.join(__dirname, '..', 'src', 'audio');
const CASO_DEFAULT = getArg('--caso') || null;

// ── Utilidades estadísticas ────────────────────────────────────
function percentil(arr, p) {
  if (arr.length === 0) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function media(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function desviacion(arr) {
  if (arr.length < 2) return null;
  const m = media(arr);
  const varianza = arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1);
  return Math.sqrt(varianza);
}

// ── Leer archivos ──────────────────────────────────────────────
if (!fs.existsSync(AUDIO_DIR)) {
  console.error(`❌ Directorio no encontrado: ${AUDIO_DIR}`);
  console.error('   Usa: node analizar_latencia.js --dir <ruta/a/audio>');
  process.exit(1);
}

const files = fs.readdirSync(AUDIO_DIR)
  .filter(f => f.startsWith('transcript_') && f.endsWith('.json'));

if (files.length === 0) {
  console.error(`❌ No se encontraron archivos transcript_*.json en ${AUDIO_DIR}`);
  process.exit(1);
}

console.log(`\n📁 Directorio: ${AUDIO_DIR}`);
console.log(`📄 Archivos encontrados: ${files.length}\n`);

// ── Procesar archivos ──────────────────────────────────────────
const datos = {}; // { caso: [latencias_ms] }
const errores = [];
let sinMarks = 0;

for (const file of files) {
  try {
    const raw = fs.readFileSync(path.join(AUDIO_DIR, file), 'utf8');
    const data = JSON.parse(raw);

    const caso = data.caso || CASO_DEFAULT || 'SIN_CASO';
    const marks = data.marks;

    if (!marks) {
      sinMarks++;
      continue;
    }

    // Latencia principal: ASR final → primer carácter LLM
    const L_llm = (marks.llm_first_char && marks.asr_final)
      ? marks.llm_first_char - marks.asr_final
      : null;

    // Latencia secundaria: ASR final → inicio TTS
    const L_tts = (marks.tts_start && marks.asr_final)
      ? marks.tts_start - marks.asr_final
      : null;

    if (L_llm === null) {
      errores.push(`${file}: falta llm_first_char o asr_final`);
      continue;
    }

    if (L_llm < 0 || L_llm > 30000) {
      errores.push(`${file}: latencia fuera de rango (${L_llm} ms) — posible error de reloj`);
      continue;
    }

    if (!datos[caso]) datos[caso] = { llm: [], tts: [] };
    datos[caso].llm.push(L_llm);
    if (L_tts !== null) datos[caso].tts.push(L_tts);

  } catch (e) {
    errores.push(`${file}: ${e.message}`);
  }
}

// ── Mostrar resultados ─────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════');
console.log('  ALMA — RESULTADOS DE LATENCIA FIN-DE-TURNO');
console.log('  L = t_llm_first_char − t_asr_final');
console.log('═══════════════════════════════════════════════════════════════\n');

const META_MS = 300;

// Tabla de resultados
console.log('Caso   │ N  │  Min  │  p50  │  p95  │  Max  │  σ    │ Meta<300ms');
console.log('───────┼────┼───────┼───────┼───────┼───────┼───────┼──────────');

const resultadosExport = [];

for (const [caso, values] of Object.entries(datos)) {
  const arr = values.llm;
  if (arr.length === 0) continue;

  const p50 = Math.round(percentil(arr, 50));
  const p95 = Math.round(percentil(arr, 95));
  const min = Math.round(Math.min(...arr));
  const max = Math.round(Math.max(...arr));
  const sd  = Math.round(desviacion(arr) || 0);
  const cumple = p95 < META_MS ? '✅ SÍ' : '❌ NO';

  const row = `${caso.padEnd(6)} │ ${String(arr.length).padStart(2)} │ ${String(min).padStart(5)} │ ${String(p50).padStart(5)} │ ${String(p95).padStart(5)} │ ${String(max).padStart(5)} │ ${String(sd).padStart(5)} │ ${cumple}`;
  console.log(row);

  resultadosExport.push({ caso, n: arr.length, min, p50, p95, max, sd, cumple: p95 < META_MS });
}

console.log();

// Detalle individual de latencias (para gráfico boxplot)
console.log('\n── LATENCIAS INDIVIDUALES (para boxplot) ─────────────────────');
for (const [caso, values] of Object.entries(datos)) {
  if (values.llm.length === 0) continue;
  console.log(`\n${caso}:`);
  values.llm.forEach((v, i) => {
    console.log(`  ${String(i + 1).padStart(2)}. ${Math.round(v)} ms`);
  });
}

// Exportar CSV
const csvLines = ['caso,n,min_ms,p50_ms,p95_ms,max_ms,sd_ms,cumple_meta'];
resultadosExport.forEach(r => {
  csvLines.push(`${r.caso},${r.n},${r.min},${r.p50},${r.p95},${r.max},${r.sd},${r.cumple}`);
});
fs.writeFileSync('resultados_latencia.csv', csvLines.join('\n'));
console.log('\n📊 Exportado: resultados_latencia.csv');

// Exportar CSV de valores individuales para boxplot
const csvRaw = ['caso,latencia_ms'];
for (const [caso, values] of Object.entries(datos)) {
  values.llm.forEach(v => csvRaw.push(`${caso},${Math.round(v)}`));
}
fs.writeFileSync('latencias_individuales.csv', csvRaw.join('\n'));
console.log('📊 Exportado: latencias_individuales.csv');

// Advertencias
if (sinMarks > 0) {
  console.log(`\n⚠️  ${sinMarks} archivos sin campo "marks" (sesiones sin respuesta LLM)`);
}
if (errores.length > 0) {
  console.log('\n⚠️  Errores encontrados:');
  errores.forEach(e => console.log(`   • ${e}`));
}

// Instrucciones si no hay campo "caso"
const sinCaso = Object.keys(datos).includes('SIN_CASO');
if (sinCaso) {
  console.log('\n💡 TIP: Los archivos no tienen campo "caso".');
  console.log('   Opciones:');
  console.log('   1. Agregar manualmente "caso":"CS1" a cada JSON de traza, o');
  console.log('   2. Ejecutar por lotes renombrando el directorio:');
  console.log('      node analizar_latencia.js --dir audio/cs1 --caso CS1');
  console.log('      node analizar_latencia.js --dir audio/cs2 --caso CS2');
}

console.log('\n═══════════════════════════════════════════════════════════════\n');
