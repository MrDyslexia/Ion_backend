/**
 * scorer.js — Puntuación determinista del 6CIT
 *
 * Escala inversa: puntaje MENOR = MEJOR rendimiento.
 * Total 0–28.
 *   0–7   → Normal
 *   8–9   → Deterioro leve
 *   10–28 → Deterioro significativo
 */

const MONTHS_ES = [
  'enero','febrero','marzo','abril','mayo','junio',
  'julio','agosto','septiembre','octubre','noviembre','diciembre'
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function numberToWords(n) {
  const map = {
    1:'uno',2:'dos',3:'tres',4:'cuatro',5:'cinco',6:'seis',7:'siete',
    8:'ocho',9:'nueve',10:'diez',11:'once',12:'doce',13:'trece',
    14:'catorce',15:'quince',16:'dieciseis',17:'diecisiete',18:'dieciocho',
    19:'diecinueve',20:'veinte'
  };
  return map[n] || null;
}

/** Convierte texto en español a número (para años como "veinte veintiséis" → 2026) */
function wordsToNumber(text) {
  const WORD_NUM = {
    'cero':0,'uno':1,'dos':2,'tres':3,'cuatro':4,'cinco':5,'seis':6,'siete':7,
    'ocho':8,'nueve':9,'diez':10,'once':11,'doce':12,'trece':13,'catorce':14,
    'quince':15,'dieciseis':16,'diecisiete':17,'dieciocho':18,'diecinueve':19,
    'veinte':20,'veintiuno':21,'veintidos':22,'veintitres':23,'veinticuatro':24,
    'veinticinco':25,'veintiseis':26,'veintisiete':27,'veintiocho':28,'veintinueve':29,
    'treinta':30,'cuarenta':40,'cincuenta':50,'sesenta':60,'setenta':70,'ochenta':80,
    'noventa':90,'cien':100,'ciento':100,'doscientos':200,'trescientos':300,'mil':1000
  };
  const nums = text.split(/\s+/).map(w => WORD_NUM[w]).filter(n => n !== undefined);
  if (!nums.length) return null;
  // "veinte veintiséis" → [20,26] → concat como string → "2026"
  const concat = nums.join('');
  if (!isNaN(concat) && concat.length === 4) return parseInt(concat, 10);
  // suma estándar para "dos mil veintiséis" → [2,1000,26] → 2026
  let total = 0, cur = 0;
  for (const n of nums) {
    if (n === 1000) { total += (cur || 1) * 1000; cur = 0; }
    else cur += n;
  }
  return total + cur;
}

// ── Scorers por modo ──────────────────────────────────────────────────────────

function scoreBinary(question, answer) {
  if (answer.status !== 'answered' || !answer.text) {
    return { score: question.maxScore, detail: 'sin_respuesta' };
  }

  const text = normalize(answer.text);
  let correct = false;

  if (question.id === 'year') {
    const currentYear = new Date().getFullYear();
    // Aceptar dígitos directos: "2025"
    if (text.includes(String(currentYear))) { correct = true; }
    // Aceptar últimas dos cifras: "25", "veinticinco"
    const lastTwo      = currentYear % 100;
    const lastTwoStr   = String(lastTwo);
    const lastTwoWords = numberToWords(lastTwo) || '';
    if (!correct && (text.includes(lastTwoStr) || (lastTwoWords && text.includes(lastTwoWords)))) {
      correct = true;
    }
    // Aceptar dígitos combinados: "20 26" → "2026"
    const digits = text.match(/\d+/g);
    if (!correct && digits) {
      const combined = digits.join('');
      if (combined === String(currentYear)) correct = true;
    }
    // Aceptar palabras numéricas: "veinte veintiséis" → 2026, "dos mil veintiséis" → 2026
    if (!correct) {
      const fromWords = wordsToNumber(text);
      if (fromWords === currentYear) correct = true;
    }
  }

  if (question.id === 'month') {
    const idx      = new Date().getMonth();
    const name     = normalize(MONTHS_ES[idx]);
    const num      = String(idx + 1);
    const numRegex = new RegExp(`\\b${num}\\b`);
    correct = text.includes(name) || numRegex.test(text);
  }

  console.log(`📍 [Scorer] ${question.id} — texto: "${answer.text?.slice(0,40)}" → ${correct ? '✅ correcto' : '❌ incorrecto'}`);
  return { score: correct ? 0 : question.maxScore, detail: correct ? 'correcto' : 'incorrecto' };
}

function scoreTime(question, answer) {
  if (answer.status !== 'answered' || !answer.text) {
    return { score: question.maxScore, detail: 'sin_respuesta' };
  }

  const text = normalize(answer.text);
  const now  = new Date();
  let mentionedHour = null, mentionedMinute = 0;

  const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?/);
  if (timeMatch) {
    mentionedHour   = parseInt(timeMatch[1], 10);
    mentionedMinute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    if (text.includes('media'))                               mentionedMinute = 30;
    if (text.includes('cuarto') || text.includes('quince'))   mentionedMinute = 15;
  } else {
    ['una','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce']
      .forEach((w, i) => { if (text.includes(w)) mentionedHour = i + 1; });
  }

  if (mentionedHour === null) return { score: question.maxScore, detail: 'no_se_pudo_interpretar' };

  const mentionedTotal = mentionedHour * 60 + mentionedMinute;
  const nowTotal       = now.getHours() * 60 + now.getMinutes();
  const candidates     = [mentionedTotal, mentionedTotal + 12 * 60];
  const diff           = Math.min(...candidates.map(c => Math.abs(c - nowTotal)));
  const correct        = diff <= question.meta.toleranceMinutes;

  console.log(`📍 [Scorer] time — texto: "${answer.text?.slice(0,40)}" → hora mencionada: ${mentionedHour}:${String(mentionedMinute).padStart(2,'0')}, diff: ${diff}min, ${correct ? '✅ correcto' : '❌ incorrecto'}`);
  return { score: correct ? 0 : question.maxScore, detail: correct ? 'correcto' : `diferencia_${diff}min` };
}

function scorePartial(question, answer) {
  if (answer.status === 'no_response') return { score: question.maxScore, detail: 'sin_respuesta' };
  if (answer.status === 'unclear')     return { score: question.maxScore, detail: 'no_se_entendio' };

  const q = answer.quality || 'failed';
  if (q === 'perfect')   return { score: 0,                         detail: 'perfecto' };
  if (q === 'one_error') return { score: Math.round(question.maxScore / 2), detail: 'un_error' };
  return                        { score: question.maxScore,         detail: 'fallido' };
}

/**
 * Genera todas las variantes orales posibles de una cadena de dígitos.
 * "1373" → ["1373", "trece setenta y tres", "mil trescientos setenta y tres",
 *            "trece setenta tres", ...]
 */
function numericVariants(str) {
  const n = parseInt(str, 10);
  if (isNaN(n)) return [normalize(str)];

  const variants = [str]; // dígitos literales

  // Variante "cifras compuestas" (como se lee una dirección en Chile):
  // 1373 → "trece setenta y tres"
  const hundreds = Math.floor(n / 100);   // 13
  const tens     = n % 100;               // 73

  const tensWords = {
    1:'uno',2:'dos',3:'tres',4:'cuatro',5:'cinco',6:'seis',7:'siete',
    8:'ocho',9:'nueve',10:'diez',11:'once',12:'doce',13:'trece',14:'catorce',
    15:'quince',16:'dieciseis',17:'diecisiete',18:'dieciocho',19:'diecinueve',
    20:'veinte',21:'veintiuno',22:'veintidos',23:'veintitres',24:'veinticuatro',
    25:'veinticinco',26:'veintiseis',27:'veintisiete',28:'veintiocho',29:'veintinueve',
    30:'treinta',40:'cuarenta',50:'cincuenta',60:'sesenta',70:'setenta',
    73:'setenta y tres',80:'ochenta',90:'noventa'
  };

  function tensToWord(t) {
    if (tensWords[t]) return tensWords[t];
    const dec = Math.floor(t / 10) * 10;
    const uni = t % 10;
    const decW = tensWords[dec];
    const uniW = tensWords[uni];
    if (decW && uniW) return `${decW} y ${uniW}`;
    return null;
  }

  // "trece setenta y tres" (leer en pares de dígitos)
  const hundW = tensToWord(hundreds);
  const tenW  = tensToWord(tens);
  if (hundW && tenW) {
    variants.push(`${hundW} ${tenW}`);
    // con "y" entre ellos también por si acaso
  }
  if (hundW)           variants.push(hundW);
  if (tenW)            variants.push(tenW);

  // Variante estándar en palabras: "mil trescientos setenta y tres"
  const centenas = {
    100:'cien',200:'doscientos',300:'trescientos',400:'cuatrocientos',500:'quinientos',
    600:'seiscientos',700:'setecientos',800:'ochocientos',900:'novecientos'
  };
  if (n >= 1000) {
    const miles = Math.floor(n / 1000);
    const resto = n % 1000;
    const milesW = miles === 1 ? 'mil' : `${tensToWord(miles) || miles} mil`;
    const centena = Math.floor(resto / 100) * 100;
    const tensResto = resto % 100;
    const parts = [milesW];
    if (centena && centenas[centena]) parts.push(centenas[centena]);
    const tensRestoW = tensToWord(tensResto);
    if (tensRestoW) parts.push(tensRestoW);
    variants.push(parts.join(' '));
  }

  return variants.map(v => normalize(String(v)));
}

function scoreAddress(question, answer) {
  if (answer.status !== 'answered' || !answer.text) {
    return { score: question.maxScore, detail: 'sin_respuesta', componentScores: {} };
  }

  const text            = normalize(answer.text);
  const components      = question.meta.address.components;
  const componentScores = {};
  let errors = 0;

  for (const comp of components) {
    // Para componentes numéricos, probar todas las variantes orales
    const isNumeric = /^\d+$/.test(comp.trim());
    let found;
    if (isNumeric) {
      const variants = numericVariants(comp);
      found = variants.some(v => text.includes(v));
      if (!found) {
        // Fallback: buscar cada variante como subsecuencia de palabras
        const words = text.split(/\s+/);
        found = variants.some(v => {
          const vWords = v.split(/\s+/);
          // Sliding window
          for (let i = 0; i <= words.length - vWords.length; i++) {
            if (vWords.every((w, j) => words[i + j] === w)) return true;
          }
          return false;
        });
      }
    } else {
      found = text.includes(normalize(comp));
    }

    componentScores[comp] = found ? 'correcto' : 'incorrecto';
    if (!found) errors++;
  }

  const detail = errors === 0 ? 'correcto' : `${errors}_errores`;

  // Log detallado por componente
  const lines = Object.entries(componentScores)
    .map(([comp, r]) => `    "${comp}": ${r === 'correcto' ? '✅' : '❌'}`)
    .join('\n');
  console.log(`📍 [Scorer] address_recall — texto: "${answer.text?.slice(0,60)}"\n${lines}`);

  return { score: errors * 2, detail, componentScores };
}

function scoreNone() {
  return { score: 0, detail: 'no_puntua' };
}

// ── API pública ───────────────────────────────────────────────────────────────

function scoreAnswer(question, answer) {
  switch (question.scoreMode) {
    case 'binary':  return scoreBinary(question, answer);
    case 'time':    return scoreTime(question, answer);
    case 'partial': return scorePartial(question, answer);
    case 'address': return scoreAddress(question, answer);
    case 'none':    return scoreNone();
    default:        return { score: question.maxScore, detail: 'modo_desconocido' };
  }
}

function interpretScore(totalScore) {
  if (totalScore <= 7)  return { level: 'normal',      label: 'Normal',                 color: 'green'  };
  if (totalScore <= 9)  return { level: 'mild',         label: 'Deterioro leve',          color: 'yellow' };
  return                       { level: 'significant',  label: 'Deterioro significativo', color: 'red'    };
}

module.exports = { scoreAnswer, interpretScore, normalize, MONTHS_ES };