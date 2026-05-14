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

  // Suma estándar: "dos mil veintiséis" → [2,1000,26] → 2026
  let total = 0, cur = 0;
  for (const n of nums) {
    if (n === 1000) { total += (cur || 1) * 1000; cur = 0; }
    else cur += n;
  }
  const sumResult = total + cur;
  if (sumResult >= 1900 && sumResult <= 2200) return sumResult;

  // Fallback por concatenación: "veinte veintiséis" → [20,26] → "2026"
  const concat = nums.join('');
  if (concat.length === 4 && !Number.isNaN(Number(concat))) {
    const concatResult = Number.parseInt(concat, 10);
    if (concatResult >= 1900 && concatResult <= 2200) return concatResult;
  }

  return sumResult;
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
    const idx        = new Date().getMonth();
    const name       = normalize(MONTHS_ES[idx]);
    const num        = String(idx + 1);
    const numRegex   = new RegExp(`\\b${num}\\b`);
    const mentioned  = MONTHS_ES.filter(m => text.includes(normalize(m)));
    if (mentioned.length >= 3) {
      // Paciente lista meses esperando acertar → no puntúa
      correct = false;
      console.log(`📍 [Scorer] month — fishing detectado (${mentioned.length} meses) → ❌`);
    } else {
      correct = text.includes(name) || numRegex.test(text);
    }
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

  // Palabras para hora (1–12) y minutos (0–59 en palabras)
  const hourWords = ['una','dos','tres','cuatro','cinco','seis','siete','ocho','nueve','diez','once','doce'];
  const minuteWords = {
    'cinco':5,'diez':10,'once':11,'doce':12,'trece':13,'catorce':14,'quince':15,
    'dieciseis':16,'diecisiete':17,'dieciocho':18,'diecinueve':19,
    'veinte':20,'veintiuno':21,'veintidos':22,'veintitres':23,'veinticuatro':24,
    'veinticinco':25,'veintiseis':26,'veintisiete':27,'veintiocho':28,'veintinueve':29,
    'treinta':30,'cuarenta':40,'cincuenta':50
  };

  // Formato inverso: "20 para las 8" = 7:40, "cuarto para las 5" = 4:45
  const MINS_BEFORE = { 'cinco':5,'diez':10,'cuarto':15,'quince':15,'veinte':20,'veinticinco':25,'media':30,'treinta':30 };
  const paraRE = /\b(\d+|cinco|diez|cuarto|quince|veinte|veinticinco|media|treinta)\s+para\s+las?\s+(\d+)/;
  const paraWordsRE = /\b(\d+|cinco|diez|cuarto|quince|veinte|veinticinco|media|treinta)\s+para\s+las?\s+(una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce)/;
  const paraMatch = text.match(paraRE) || text.match(paraWordsRE);
  if (paraMatch) {
    const minBefore = parseInt(paraMatch[1]) || MINS_BEFORE[paraMatch[1]] || 0;
    const refHour   = parseInt(paraMatch[2]) || (hourWords.indexOf(paraMatch[2]) + 1) || 0;
    if (minBefore > 0 && minBefore < 60 && refHour >= 1 && refHour <= 12) {
      mentionedHour   = refHour > 1 ? refHour - 1 : 12;
      mentionedMinute = 60 - minBefore;
    }
  }

  if (mentionedHour === null) {
    const timeMatch = text.match(/(\d{1,2})(?::(\d{2}))?/);
    if (timeMatch) {
      mentionedHour   = parseInt(timeMatch[1], 10);
      mentionedMinute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      if (text.includes('media'))                              mentionedMinute = 30;
      if (/\bcuarto\b/.test(text) || /\bquince\b/.test(text)) mentionedMinute = 15;
    } else {
      hourWords.forEach((w, i) => {
        if (new RegExp(`\\b${w}\\b`).test(text)) mentionedHour = i + 1;
      });

      if (mentionedHour !== null) {
        const hourWord = hourWords[mentionedHour - 1];
        for (const [word, val] of Object.entries(minuteWords)) {
          if (word !== hourWord && new RegExp(`\\b${word}\\b`).test(text)) {
            mentionedMinute = val;
            break;
          }
        }
      }

      if (/\bmedia\b/.test(text))                              mentionedMinute = 30;
      if (/\bcuarto\b/.test(text) || /\bquince\b/.test(text)) mentionedMinute = 15;
    }
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

// ── Conversión número → palabras (español) ───────────────────────────────────

const DIGIT_WORDS = ['cero','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve'];

const _ONES = [
  '','uno','dos','tres','cuatro','cinco','seis','siete','ocho','nueve',
  'diez','once','doce','trece','catorce','quince',
  'dieciseis','diecisiete','dieciocho','diecinueve',
  'veinte','veintiuno','veintidos','veintitres','veinticuatro',
  'veinticinco','veintiseis','veintisiete','veintiocho','veintinueve'
];
const _TENS = ['','','veinte','treinta','cuarenta','cincuenta','sesenta','setenta','ochenta','noventa'];
const _HUND = ['','ciento','doscientos','trescientos','cuatrocientos','quinientos',
               'seiscientos','setecientos','ochocientos','novecientos'];

function numberToWordsFull(n) {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  if (n === 0) return 'cero';
  const parts = [];
  let rem = n;
  if (rem >= 1000) {
    const m = Math.floor(rem / 1000);
    parts.push(m === 1 ? 'mil' : `${_ONES[m]} mil`);
    rem %= 1000;
  }
  if (rem === 100) { parts.push('cien'); rem = 0; }
  else if (rem >= 100) { parts.push(_HUND[Math.floor(rem / 100)]); rem %= 100; }
  if (rem >= 30) {
    const dec = Math.floor(rem / 10), uni = rem % 10;
    parts.push(uni > 0 ? `${_TENS[dec]} y ${_ONES[uni]}` : _TENS[dec]);
  } else if (rem > 0) { parts.push(_ONES[rem]); }
  return parts.join(' ') || null;
}

/**
 * Genera todas las variantes orales posibles de una cadena de dígitos.
 * "1373":
 *   literal         → "1373"
 *   completo        → "mil trescientos setenta y tres"
 *   dígito a dígito → "uno tres siete tres"
 *   pares 2+2       → "trece setenta y tres" / "trece setenta tres"
 *   3+1             → "ciento treinta y siete tres"
 *   1+3             → "uno trescientos setenta y tres"
 */
function numericVariants(str) {
  const n = parseInt(str, 10);
  if (isNaN(n)) return [normalize(str)];

  const raw = new Set([str]);

  // Completo: "mil trescientos setenta y tres"
  const full = numberToWordsFull(n);
  if (full) raw.add(full);

  // Dígito a dígito: "uno tres siete tres"
  const digits = [...str].map(d => DIGIT_WORDS[parseInt(d)]);
  if (digits.every(Boolean)) raw.add(digits.join(' '));

  if (str.length === 4) {
    // 2+2: "trece setenta y tres" y sin "y": "trece setenta tres"
    const aW = numberToWordsFull(parseInt(str.slice(0, 2)));
    const bW = numberToWordsFull(parseInt(str.slice(2)));
    if (aW && bW) {
      raw.add(`${aW} ${bW}`);
      raw.add(`${aW} ${bW}`.replace(/ y /g, ' ')); // sin "y"
    }

    // 3+1: "ciento treinta y siete tres"
    const cW = numberToWordsFull(parseInt(str.slice(0, 3)));
    const dW = DIGIT_WORDS[parseInt(str[3])];
    if (cW && dW) raw.add(`${cW} ${dW}`);

    // 1+3: "uno trescientos setenta y tres"
    const eW = DIGIT_WORDS[parseInt(str[0])];
    const fW = numberToWordsFull(parseInt(str.slice(1)));
    if (eW && fW) raw.add(`${eW} ${fW}`);
  }

  return [...raw].map(v => normalize(String(v)));
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