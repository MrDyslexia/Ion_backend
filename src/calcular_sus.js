/**
 * calcular_sus.js
 * ALMA — Cálculo de puntaje SUS (System Usability Scale)
 *
 * Uso:
 *   node calcular_sus.js [p1] [p2] [p3] [p4] [p5] [p6] [p7] [p8] [p9] [p10]
 *
 * Ejemplo (un participante):
 *   node calcular_sus.js 5 4 5 2 5 1 5 2 5 1
 *
 * Sin argumentos: muestra el cuestionario y pide ingresar respuestas.
 */

const fs = require('fs');
const readline = require('readline');

const PREGUNTAS = [
  { id: 1, tipo: 'positiva', texto: 'Creo que me gustaría usar este sistema frecuentemente.' },
  { id: 2, tipo: 'negativa', texto: 'Encontré el sistema innecesariamente complejo.' },
  { id: 3, tipo: 'positiva', texto: 'Pensé que el sistema era fácil de usar.' },
  { id: 4, tipo: 'negativa', texto: 'Creo que necesitaría ayuda de alguien técnico para usar este sistema.' },
  { id: 5, tipo: 'positiva', texto: 'Las diferentes funciones de este sistema estaban bien integradas.' },
  { id: 6, tipo: 'negativa', texto: 'Pensé que había demasiada inconsistencia en este sistema.' },
  { id: 7, tipo: 'positiva', texto: 'Imagino que la mayoría de las personas aprenderían a usar este sistema muy rápidamente.' },
  { id: 8, tipo: 'negativa', texto: 'Encontré el sistema muy difícil de usar.' },
  { id: 9, tipo: 'positiva', texto: 'Me sentí muy confiado/a al usar el sistema.' },
  { id: 10, tipo: 'negativa', texto: 'Necesité aprender muchas cosas antes de poder usar este sistema.' },
];

function calcularSUS(respuestas) {
  // respuestas: array de 10 valores entre 1 y 5
  let suma = 0;
  for (let i = 0; i < 10; i++) {
    const r = parseInt(respuestas[i]);
    if (isNaN(r) || r < 1 || r > 5) throw new Error(`Respuesta inválida en pregunta ${i+1}: ${respuestas[i]} (debe ser 1-5)`);

    if (PREGUNTAS[i].tipo === 'positiva') {
      suma += (r - 1);
    } else {
      suma += (5 - r);
    }
  }
  return suma * 2.5; // escala 0-100
}

function interpretarSUS(puntaje) {
  if (puntaje >= 85) return { grado: 'A', etiqueta: 'Excelente', adjuntar: '✅ Supera la meta (≥70)' };
  if (puntaje >= 70) return { grado: 'B', etiqueta: 'Bueno', adjuntar: '✅ Supera la meta (≥70)' };
  if (puntaje >= 58) return { grado: 'C', etiqueta: 'Regular', adjuntar: '⚠️ Por debajo de la meta (≥70)' };
  if (puntaje >= 51) return { grado: 'D', etiqueta: 'Pobre', adjuntar: '❌ Por debajo de la meta (≥70)' };
  return { grado: 'F', etiqueta: 'Inaceptable', adjuntar: '❌ Por debajo de la meta (≥70)' };
}

// ── Modo línea de comandos ─────────────────────────────────────
const args = process.argv.slice(2);

if (args.length === 10) {
  // Calcular directamente
  try {
    const puntaje = calcularSUS(args);
    const interp = interpretarSUS(puntaje);
    console.log('\n═══════════════════════════════════════');
    console.log('  ALMA — RESULTADO SUS');
    console.log('═══════════════════════════════════════');
    console.log(`  Respuestas: [${args.join(', ')}]`);
    console.log(`  Puntaje:    ${puntaje.toFixed(1)} / 100`);
    console.log(`  Grado:      ${interp.grado} — ${interp.etiqueta}`);
    console.log(`  Meta:       ${interp.adjuntar}`);
    console.log('═══════════════════════════════════════\n');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
  process.exit(0);
}

// ── Modo interactivo (registrar múltiples participantes) ───────
console.log('\n════════════════════════════════════════════════════════════════');
console.log('  ALMA — CUESTIONARIO SUS (System Usability Scale)');
console.log('  Escala: 1 = Totalmente en desacuerdo  5 = Totalmente de acuerdo');
console.log('════════════════════════════════════════════════════════════════\n');
console.log('Cuestionario para administrar al participante:\n');

PREGUNTAS.forEach(p => {
  console.log(`  P${p.id}. ${p.texto}`);
  console.log(`      [ 1 ]  [ 2 ]  [ 3 ]  [ 4 ]  [ 5 ]`);
  console.log();
});

console.log('────────────────────────────────────────────────────────────────');
console.log('Ingresa las respuestas separadas por espacio (ej: 5 4 5 2 5 1 5 2 5 1):');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const participantes = [];

function preguntarParticipante(num) {
  rl.question(`\nParticipante ${num} (o "fin" para terminar): `, (input) => {
    if (input.trim().toLowerCase() === 'fin') {
      mostrarResumen();
      rl.close();
      return;
    }

    const resp = input.trim().split(/\s+/);
    if (resp.length !== 10) {
      console.log('⚠️ Necesitas exactamente 10 respuestas. Intenta de nuevo.');
      preguntarParticipante(num);
      return;
    }

    try {
      const puntaje = calcularSUS(resp);
      const interp = interpretarSUS(puntaje);
      participantes.push({ id: num, respuestas: resp.map(Number), puntaje, ...interp });
      console.log(`   → Puntaje: ${puntaje.toFixed(1)} (${interp.etiqueta}) ${interp.adjuntar}`);
      preguntarParticipante(num + 1);
    } catch (e) {
      console.log(`⚠️ ${e.message}. Intenta de nuevo.`);
      preguntarParticipante(num);
    }
  });
}

function mostrarResumen() {
  if (participantes.length === 0) {
    console.log('\nNo se registraron participantes.');
    return;
  }

  const puntajes = participantes.map(p => p.puntaje);
  const promedio = puntajes.reduce((a, b) => a + b, 0) / puntajes.length;
  const min = Math.min(...puntajes);
  const max = Math.max(...puntajes);

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  RESUMEN SUS — ALMA');
  console.log('════════════════════════════════════════════════════════════════');
  console.log(`  Participantes: ${participantes.length}`);
  participantes.forEach(p => {
    console.log(`  P${p.id}: ${p.puntaje.toFixed(1)} — ${p.etiqueta}`);
  });
  console.log('  ─────────────────────────────────────────────────────');
  console.log(`  Promedio:  ${promedio.toFixed(1)}`);
  console.log(`  Mínimo:    ${min.toFixed(1)}`);
  console.log(`  Máximo:    ${max.toFixed(1)}`);
  const cumple = promedio >= 70;
  console.log(`  Meta ≥70:  ${cumple ? '✅ CUMPLE' : '❌ NO CUMPLE'}`);
  console.log('════════════════════════════════════════════════════════════════\n');

  // Exportar CSV
  const csv = ['participante,p1,p2,p3,p4,p5,p6,p7,p8,p9,p10,puntaje_sus,etiqueta'];
  participantes.forEach(p => {
    csv.push(`${p.id},${p.respuestas.join(',')},${p.puntaje.toFixed(1)},${p.etiqueta}`);
  });
  csv.push(`PROMEDIO,,,,,,,,,,,${promedio.toFixed(1)},`);
  fs.writeFileSync('resultados_sus.csv', csv.join('\n'));
  console.log('📊 Exportado: resultados_sus.csv');
}

preguntarParticipante(1);
