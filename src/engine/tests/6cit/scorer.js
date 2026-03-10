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
    // Aceptar "dos mil veinticinco", "veinte veinticinco" como año completo en palabras
    // Extraer todos los números del texto y combinarlos
    const digits = text.match(/\d+/g);
    if (!correct && digits) {
      const combined = digits.join('');
      if (combined === String(currentYear)) correct = true;
    }
  }

  if (question.id === 'month') {
    const idx   = new Date().getMonth();
    const name  = normalize(MONTHS_ES[idx]);
    const num   = String(idx + 1);
    correct = text.includes(name) || text.includes(num);
  }

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

function scoreAddress(question, answer) {
  if (answer.status !== 'answered' || !answer.text) {
    return { score: question.maxScore, detail: 'sin_respuesta', componentScores: {} };
  }

  const text           = normalize(answer.text);
  const components     = question.meta.address.components;
  const componentScores = {};
  let errors = 0;

  for (const comp of components) {
    const found = text.includes(normalize(comp));
    componentScores[comp] = found ? 'correcto' : 'incorrecto';
    if (!found) errors++;
  }

  return { score: errors * 2, detail: `${errors}_errores`, componentScores };
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
