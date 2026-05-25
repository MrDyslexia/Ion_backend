/**
 * analizar_sistema.js
 * ALMA — Reporte integral de latencias y funcionamiento
 *
 * Uso: node src/analizar_sistema.js [--audio ../audio]
 *
 * Fuentes:
 *   conv_*.json  → latencia LLM por turno conversacional
 *   PAC-*.txt    → latencia STT (parsing de logs)
 *   alma.db      → scores 6CIT y detalle por pregunta
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);
const getArg  = f => { const i = args.indexOf(f); return i !== -1 ? args[i+1] : null; };
const AUDIO   = getArg('--audio') || path.join(__dirname, '..', 'audio');
const DB_PATH = path.join(__dirname, '..', 'data', 'alma.db');

// ── Utilidades estadísticas ────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a,b) => a-b);
  return s[Math.max(0, Math.ceil(p/100 * s.length) - 1)];
};
const avg = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null;
const fmt = v => v == null ? '  N/A' : String(Math.round(v)).padStart(5);

// ── Leer conv_*.json (latencias LLM conversacionales) ──────────────────────
const convFiles = fs.readdirSync(AUDIO)
  .filter(f => f.startsWith('conv_') && f.endsWith('.json'));

const llmAll = [];
const llmByPat = {};

for (const f of convFiles) {
  const d = JSON.parse(fs.readFileSync(path.join(AUDIO, f), 'utf8'));
  const pid = d.patientId || 'UNKNOWN';
  const lats = (d.turns || [])
    .map(t => t.L_llm_ms)
    .filter(v => v != null && v > 0 && v < 30000);
  llmAll.push(...lats);
  if (!llmByPat[pid]) llmByPat[pid] = [];
  llmByPat[pid].push(...lats);
}

// ── Parsear PAC-*.txt (latencias STT de logs) ──────────────────────────────
const STT_RE = /⏱️\s+\[STT\s*\]\s+"[^"]+"\s+→\s+(\d+)ms/g;
const LLM_RE = /⏱️\s+\[LLM\s*\]\s+primer token → (\d+)ms/g;

const txtFiles = fs.readdirSync(AUDIO).filter(f => /^PAC-.*\.txt$/.test(f));

const sttAll = [];
const llmLogAll = [];

for (const f of txtFiles) {
  const txt = fs.readFileSync(path.join(AUDIO, f), 'utf8');
  for (const m of txt.matchAll(STT_RE)) sttAll.push(Number(m[1]));
  for (const m of txt.matchAll(LLM_RE)) llmLogAll.push(Number(m[1]));
}

// ── Leer DB (evaluaciones 6CIT) ────────────────────────────────────────────
let evalRows = [];
try {
  const { initDB, patientOps, evaluationOps } = require('./db');
  // Nota: initDB() es async pero expone DB via closure sincróna tras await
  // Usamos child_process sync para evitar complicación de promises en script
  evalRows = '__DB_LOADED__'; // marcador
} catch(e) {
  evalRows = [];
}

// Separar la lectura DB en función async para poder usar await
async function loadDB() {
  try {
    const { initDB, patientOps, evaluationOps } = require('./db');
    await initDB();
    const pats = patientOps.getAll();
    const rows = [];
    for (const p of pats) {
      const evals = evaluationOps.getForPatient(p.id);
      for (const e of (evals || [])) {
        rows.push({ pid: p.id, name: p.name, age: p.age, ...e });
      }
    }
    return rows;
  } catch(e) {
    return [];
  }
}

// ── Imprimir reporte ───────────────────────────────────────────────────────
function printSection(title) {
  const bar = '═'.repeat(65);
  console.log(`\n${bar}`);
  console.log(`  ${title}`);
  console.log(bar);
}

function printLatTable(label, arr) {
  if (!arr.length) { console.log(`  ${label}: sin datos`); return; }
  const clean = arr.filter(v => v < 30000);
  const outliers = arr.length - clean.length;
  console.log(`  ${label}`);
  console.log(`    n=${clean.length}${outliers ? ` (+${outliers} outliers >30s excluidos)` : ''}`);
  console.log(`    min=${fmt(Math.min(...clean))}ms  p50=${fmt(pct(clean,50))}ms  p95=${fmt(pct(clean,95))}ms  max=${fmt(Math.max(...clean))}ms  avg=${fmt(avg(clean))}ms`);
}

async function main() {
  const dbRows = await loadDB();

  // ── SECCIÓN 1: Resumen general ─────────────────────────────────────────
  printSection('ALMA — REPORTE INTEGRAL DE LATENCIAS Y FUNCIONAMIENTO');
  console.log(`\n  Fecha:         ${new Date().toLocaleString('es-CL')}`);
  console.log(`  Sesiones:      ${convFiles.length} archivos conv_*.json`);
  console.log(`  Logs de texto: ${txtFiles.length} archivos PAC-*.txt`);
  console.log(`  Evaluaciones:  ${dbRows.length} en DB`);

  // ── SECCIÓN 2: Latencias STT ───────────────────────────────────────────
  printSection('LATENCIA STT  (ASR: tiempo reconocimiento de voz)');
  printLatTable('STT global (todos los turnos)', sttAll);
  const sttSorted = [...sttAll].sort((a,b)=>a-b);
  if (sttSorted.length) {
    const META_STT = 500;
    const cumple = sttSorted.filter(v => v < META_STT).length;
    console.log(`\n  Meta <${META_STT}ms: ${cumple}/${sttSorted.length} muestras (${(cumple/sttSorted.length*100).toFixed(1)}%)`);
    console.log(`  p95 STT = ${Math.round(pct(sttSorted,95))}ms → ${pct(sttSorted,95) < META_STT ? '✅ CUMPLE' : '❌ NO CUMPLE'} meta`);
  }

  // ── SECCIÓN 3: Latencias LLM ───────────────────────────────────────────
  printSection('LATENCIA LLM  (ASR_final → primer token LLM)');
  console.log('  [Fuente: conv_*.json turns — turnos conversacionales post-test]\n');
  printLatTable('LLM global (todos los turnos)', llmAll);
  console.log();
  console.log('  Por paciente:');
  console.log('  Paciente  │  N  │  p50   │  p95   │  Max');
  console.log('  ──────────┼─────┼────────┼────────┼────────');
  for (const [pid, lats] of Object.entries(llmByPat).sort()) {
    if (!lats.length) continue;
    const clean = lats.filter(v=>v<30000);
    console.log(`  ${pid.padEnd(10)}│ ${String(clean.length).padStart(3)} │${fmt(pct(clean,50))}ms │${fmt(pct(clean,95))}ms │${fmt(Math.max(...clean))}ms`);
  }

  if (llmLogAll.length) {
    console.log('\n  [Fuente: PAC-*.txt — latencia LLM registrada en logs]\n');
    const clean = llmLogAll.filter(v=>v<30000);
    const outliers = llmLogAll.length - clean.length;
    printLatTable('LLM desde logs', clean);
    if (outliers) console.log(`  (${outliers} valores ≥30s excluidos como timeouts de Ollama)`);
  }

  // ── SECCIÓN 4: Funcionamiento 6CIT ────────────────────────────────────
  printSection('FUNCIONAMIENTO 6CIT  (Resultados por paciente)');

  // Deduplicar: una evaluación por paciente (más reciente)
  const byPat = {};
  for (const r of dbRows) {
    if (!byPat[r.pid] || r.started_at > byPat[r.pid].started_at) byPat[r.pid] = r;
  }

  const QUESTIONS = ['year','month','time','countdown','months_reverse','address_recall'];
  const QLABELS   = { year:'Año', month:'Mes', time:'Hora', countdown:'Cuenta atrás', months_reverse:'Meses inv.', address_recall:'Dir. recuerdo' };

  console.log('\n  Paciente   │ Nombre      │ Edad │ Score  │ Nivel           │ Completado');
  console.log('  ───────────┼─────────────┼──────┼────────┼─────────────────┼───────────');

  const allOk = [];
  for (const [pid, r] of Object.entries(byPat).sort()) {
    const score = `${r.total_score}/${r.max_score}`;
    const nivel = (r.interpretation_label || r.interpretation_level || '?').padEnd(15);
    const completed = r.status === 'completed' ? '✅' : '⚠️  ' + r.status;
    console.log(`  ${pid.padEnd(11)}│ ${(r.name||'?').padEnd(11)} │ ${String(r.age||'?').padStart(4)} │ ${score.padStart(6)} │ ${nivel} │ ${completed}`);
    allOk.push(r.status === 'completed');
  }

  const completed = allOk.filter(Boolean).length;
  console.log(`\n  Completadas: ${completed}/${allOk.length} evaluaciones`);

  // ── SECCIÓN 5: Detalle de errores por pregunta ─────────────────────────
  printSection('DETALLE DE RESPUESTAS POR PREGUNTA');
  console.log('\n  Pregunta         │ Correctas │ Incorrectas │ Tasa acierto');
  console.log('  ─────────────────┼───────────┼─────────────┼─────────────');

  for (const q of QUESTIONS) {
    let ok = 0, fail = 0;
    for (const r of Object.values(byPat)) {
      const ans = r.answers?.[q];
      if (!ans) continue;
      if (ans.score === 0) ok++;
      else fail++;
    }
    const total = ok + fail;
    const tasa = total ? `${(ok/total*100).toFixed(0)}%` : 'N/A';
    const label = (QLABELS[q] || q).padEnd(16);
    console.log(`  ${label} │ ${String(ok).padStart(9)} │ ${String(fail).padStart(11)} │ ${tasa.padStart(12)}`);
  }

  // ── SECCIÓN 6: Resumen ejecutivo ──────────────────────────────────────
  printSection('RESUMEN EJECUTIVO');

  const sttP95 = Math.round(pct(sttAll, 95) || 0);
  const llmP95 = Math.round(pct(llmAll.filter(v=>v<30000), 95) || 0);
  const sttOk  = sttP95 < 500;
  const llmNote = llmP95 < 2000 ? '✅ bueno' : llmP95 < 4000 ? '⚠️  aceptable (LLM local)' : '❌ alto';

  console.log(`
  STT  p95: ${sttP95}ms   ${sttOk ? '✅ CUMPLE meta <500ms' : '❌ supera meta <500ms'}
  LLM  p95: ${llmP95}ms  ${llmNote}

  6CIT: ${completed}/${allOk.length} sesiones completadas exitosamente`);

  // Preguntas problema
  const problemQ = [];
  for (const q of QUESTIONS) {
    let ok = 0, fail = 0;
    for (const r of Object.values(byPat)) {
      const ans = r.answers?.[q];
      if (!ans) continue;
      if (ans.score === 0) ok++; else fail++;
    }
    if (fail > 0) problemQ.push(`${QLABELS[q]} (${fail} error${fail>1?'es':''})`);
  }
  if (problemQ.length) {
    console.log(`  Preguntas con errores: ${problemQ.join(', ')}`);
  } else {
    console.log('  Todas las preguntas: sin errores en muestra');
  }

  console.log('\n' + '═'.repeat(65) + '\n');
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
