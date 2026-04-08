/**
 * test_scoring.js
 * ALMA — Pruebas unitarias: concordancia de puntajes del protocolo cognitivo
 *
 * Uso: node test_scoring.js
 */

const fs = require('fs');

const AÑO_ACTUAL = new Date().getFullYear();
const MES_ACTUAL = new Date().getMonth() + 1;
const HORA_ACTUAL = new Date().getHours();

const MESES_INVERSO_ESPERADOS = [
  'diciembre','noviembre','octubre','septiembre','agosto',
  'julio','junio','mayo','abril','marzo','febrero','enero'
];

// ── Normalización ──────────────────────────────────────────────
function normalizarTexto(txt) {
  return txt.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

// Mapa de palabras numéricas en español → valor
const PALABRAS_NUM = {
  'cero':0,'uno':1,'una':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,
  'seis':6,'siete':7,'ocho':8,'nueve':9,'diez':10,'once':11,'doce':12,
  'trece':13,'catorce':14,'quince':15,'dieciseis':16,'diecisiete':17,
  'dieciocho':18,'diecinueve':19,'veinte':20,'veintiuno':21,'veintidos':22,
  'treinta':30,'cuarenta':40,'cincuenta':50,'sesenta':60,'setenta':70,
  'ochenta':80,'noventa':90,'cien':100,'ciento':100,
  'doscientos':200,'trescientos':300,'cuatrocientos':400,'quinientos':500,
  'seiscientos':600,'setecientos':700,'setecientas':700,
  'ochocientos':800,'novecientos':900
};

/**
 * Extrae números de un texto: primero intenta dígitos directos,
 * luego convierte palabras numéricas.
 */
function extraerNumeros(texto) {
  const digitosDirectos = texto.match(/\d+/g)?.map(Number);
  if (digitosDirectos && digitosDirectos.length > 0) return digitosDirectos;

  // Convertir palabras a números
  const palabras = texto.split(/\s+/);
  const numeros = [];
  let acum = null;
  let centenas = 0;

  for (const p of palabras) {
    if (p === 'y') continue;
    const val = PALABRAS_NUM[p];
    if (val === undefined) {
      if (acum !== null) { numeros.push(centenas + acum); acum = null; centenas = 0; }
      continue;
    }
    if (val >= 100) {
      centenas += val;
    } else if (val >= 10) {
      acum = (acum || 0) + val;
    } else {
      acum = (acum || 0) + val;
    }
    // Emitir si es un número "completo" pequeño (1-20)
    if (val <= 20 && centenas === 0) {
      numeros.push(val);
      acum = null;
    } else if (centenas > 0 && val < 100) {
      // esperar más tokens
      acum = val;
    }
  }
  if (centenas > 0 || acum !== null) {
    numeros.push(centenas + (acum || 0));
  }
  return numeros;
}

// ── Evaluación por ítem ────────────────────────────────────────
function evaluarItem(itemId, respuestaRaw) {
  const resp = normalizarTexto(respuestaRaw);

  switch (itemId) {

    case 1: { // Año actual
      // Acepta dígitos directos
      const añoResp = parseInt(resp.replace(/\D/g, ''));
      return añoResp === AÑO_ACTUAL ? 0 : 1;
    }

    case 2: { // Mes actual
      const mesesEsp = {
        enero:1,febrero:2,marzo:3,abril:4,mayo:5,junio:6,
        julio:7,agosto:8,septiembre:9,octubre:10,noviembre:11,diciembre:12,
        '1':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'11':11,'12':12
      };
      const mesResp = mesesEsp[resp] || mesesEsp[resp.split(' ')[0]];
      return mesResp === MES_ACTUAL ? 0 : 1;
    }

    case 3: { // Memoria inmediata: "Avenida Los Pinos 742, departamento 5"
      const tienePinos = resp.includes('pinos');
      const tieneDepto = resp.includes('departamento') || resp.includes('depto') || resp.includes('dpto');
      // 742 en dígitos O en palabras (setecientos cuarenta y dos)
      const tiene742 = resp.includes('742') ||
        (resp.includes('setecientos') && (resp.includes('cuarenta') || resp.includes('42')));
      const aciertos = [tienePinos, tieneDepto, tiene742].filter(Boolean).length;
      return aciertos >= 3 ? 0 : 1;
    }

    case 4: { // Hora aproximada (±2 horas)
      const hora = parseInt(resp.replace(/\D/g, ''));
      if (isNaN(hora)) return 1;
      const dif = Math.abs(hora - HORA_ACTUAL);
      return (dif <= 2 || dif >= 22) ? 0 : 1;
    }

    case 5: { // Cuenta atrás 20→1 (acepta dígitos O palabras)
      const numeros = extraerNumeros(resp);
      if (numeros.length < 15) return 1;
      // Verificar orden descendente
      for (let i = 1; i < numeros.length; i++) {
        if (numeros[i] >= numeros[i - 1]) return 1;
      }
      return numeros[numeros.length - 1] === 1 ? 0 : 1;
    }

    case 6: { // Meses del año en orden inverso
      const mesesDetectados = MESES_INVERSO_ESPERADOS.filter(m => resp.includes(m));
      return mesesDetectados.length >= 10 ? 0 : 1;
    }

    case 7: { // Memoria diferida (misma lógica que ítem 3)
      const tienePinos = resp.includes('pinos');
      const tieneDepto = resp.includes('departamento') || resp.includes('depto') || resp.includes('dpto');
      const tiene742 = resp.includes('742') ||
        (resp.includes('setecientos') && (resp.includes('cuarenta') || resp.includes('42')));
      const aciertos = [tienePinos, tieneDepto, tiene742].filter(Boolean).length;
      return aciertos >= 3 ? 0 : 1;
    }

    default:
      throw new Error(`Item ID desconocido: ${itemId}`);
  }
}

function calcularPuntaje(respuestas) {
  let erroresTotal = 0;
  const detalle = [];
  for (const { itemId, respuesta } of respuestas) {
    const error = evaluarItem(itemId, respuesta);
    erroresTotal += error;
    detalle.push({ itemId, respuesta, error });
  }
  return { puntajeTotal: erroresTotal, detalle };
}

// ── Fixtures ───────────────────────────────────────────────────
const AÑO     = String(AÑO_ACTUAL);
const MESES   = ['enero','febrero','marzo','abril','mayo','junio',
                 'julio','agosto','septiembre','octubre','noviembre','diciembre'];
const MES_STR = MESES[MES_ACTUAL - 1];
const HORA_STR = String(HORA_ACTUAL);

const fixtures = [
  {
    id: 'F01',
    descripcion: 'Respuestas perfectas — puntaje esperado 0',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_STR },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'Avenida Los Pinos 742 departamento 5' },
    ],
    esperado: 0,
  },
  {
    id: 'F02',
    descripcion: 'Año incorrecto (año anterior)',
    respuestas: [
      { itemId:1, respuesta: String(AÑO_ACTUAL - 1) },
      { itemId:2, respuesta: MES_STR },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'Avenida Los Pinos 742 departamento 5' },
    ],
    esperado: 1,
  },
  {
    id: 'F03',
    descripcion: 'Mes incorrecto',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_ACTUAL === 1 ? 'febrero' : 'enero' },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'Avenida Los Pinos 742 departamento 5' },
    ],
    esperado: 1,
  },
  {
    id: 'F04',
    descripcion: 'Dirección sin número — falla ítem 3 y 7',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_STR },
      { itemId:3, respuesta: 'Avenida Los Pinos departamento cinco' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'Avenida Los Pinos departamento cinco' },
    ],
    esperado: 2,
  },
  {
    id: 'F05',
    descripcion: 'Cuenta atrás incompleta (se detiene en 10)',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_STR },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'Avenida Los Pinos 742 departamento 5' },
    ],
    esperado: 1,
  },
  {
    id: 'F06',
    descripcion: 'Meses incompletos en reverso (solo 8)',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_STR },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo' },
      { itemId:7, respuesta: 'Avenida Los Pinos 742 departamento 5' },
    ],
    esperado: 1,
  },
  {
    id: 'F07',
    descripcion: 'Múltiples errores: año, mes, memoria diferida — puntaje 3',
    respuestas: [
      { itemId:1, respuesta: '2020' },
      { itemId:2, respuesta: MES_ACTUAL === 1 ? 'agosto' : 'enero' },
      { itemId:3, respuesta: 'Avenida Los Pinos 742 departamento 5' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: '20 19 18 17 16 15 14 13 12 11 10 9 8 7 6 5 4 3 2 1' },
      { itemId:6, respuesta: 'diciembre noviembre octubre septiembre agosto julio junio mayo abril marzo febrero enero' },
      { itemId:7, respuesta: 'no recuerdo la dirección' },
    ],
    esperado: 3,
  },
  {
    id: 'F08',
    descripcion: 'Números en palabras: cuenta atrás y dirección verbal',
    respuestas: [
      { itemId:1, respuesta: AÑO },
      { itemId:2, respuesta: MES_STR.charAt(0).toUpperCase() + MES_STR.slice(1) },
      { itemId:3, respuesta: 'avenida los pinos setecientos cuarenta y dos departamento cinco' },
      { itemId:4, respuesta: HORA_STR },
      { itemId:5, respuesta: 'veinte diecinueve dieciocho diecisiete dieciseis quince catorce trece doce once diez nueve ocho siete seis cinco cuatro tres dos uno' },
      { itemId:6, respuesta: 'Diciembre, Noviembre, Octubre, Septiembre, Agosto, Julio, Junio, Mayo, Abril, Marzo, Febrero, Enero' },
      { itemId:7, respuesta: 'los pinos 742 departamento 5' },
    ],
    esperado: 0, // motor normaliza palabras → todo correcto
  },
];

// ── Ejecutar ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('  ALMA — PRUEBAS UNITARIAS: CONCORDANCIA DE PUNTAJES');
console.log('═══════════════════════════════════════════════════════════════\n');

let pasadas = 0, fallidas = 0;

for (const fixture of fixtures) {
  const { puntajeTotal, detalle } = calcularPuntaje(fixture.respuestas);
  const pasa = puntajeTotal === fixture.esperado;

  if (pasa) {
    pasadas++;
    console.log(`✅ ${fixture.id}: ${fixture.descripcion}`);
    console.log(`   Puntaje calculado: ${puntajeTotal} | Esperado: ${fixture.esperado}`);
  } else {
    fallidas++;
    console.log(`❌ ${fixture.id}: ${fixture.descripcion}`);
    console.log(`   Puntaje calculado: ${puntajeTotal} | Esperado: ${fixture.esperado}`);
    console.log('   Detalle por ítem:');
    detalle.forEach(d => {
      const est = d.error === 0 ? '✓' : '✗';
      console.log(`   ${est} Ítem ${d.itemId}: "${d.respuesta}" → error=${d.error}`);
    });
  }
  console.log();
}

console.log('───────────────────────────────────────────────────────────────');
console.log(`Resultado: ${pasadas}/${fixtures.length} pruebas pasadas`);
const concordancia = Math.round((pasadas / fixtures.length) * 100);
const cumpleMeta = concordancia === 100;
console.log(`Concordancia de puntajes: ${concordancia}% ${cumpleMeta ? '✅ (meta: 100%)' : '❌ (meta: 100%)'}`);
console.log('═══════════════════════════════════════════════════════════════\n');

const resultado = {
  fecha: new Date().toISOString(),
  totalFixtures: fixtures.length,
  pasadas, fallidas,
  concordanciaPct: concordancia,
  cumpleMeta,
};
fs.writeFileSync('resultados_scoring.json', JSON.stringify(resultado, null, 2));
console.log('📊 Exportado: resultados_scoring.json');
