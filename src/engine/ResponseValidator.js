/**
 * ResponseValidator.js
 *
 * Clasificador LLM liviano para validar respuestas del paciente.
 * Usa max_tokens bajo y temperature 0 para ser rápido y determinista.
 */

const LLM_BASE_URL = process.env.LLM_BASE_URL || 'http://localhost:11434';
const LLM_MODEL    = process.env.LLM_MODEL    || 'qwen2.5:7b';

const { ADDRESS } = require('./tests/6cit/questions');

async function callLLM(systemPrompt, userContent) {
  const resp = await fetch(`${LLM_BASE_URL}/api/chat`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:    LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  }
      ],
      stream:  false,
      options: { num_predict: 10, temperature: 0 }
    })
  });
  if (!resp.ok) throw new Error(`Validator LLM HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.message?.content || '').trim().toLowerCase();
}

/**
 * Valida si un texto parece una dirección (para address_recall).
 * Evita llamar al LLM para este caso, ya que el STT puede transcribir
 * la dirección de forma diferente (números en palabras, fragmentos, etc.)
 */
function looksLikeAddress(text) {
  const t = (text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  // Derivar keywords desde la definición oficial de la dirección
  const keywords = ADDRESS.components.map(c =>
    c.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
  );
  const matches = keywords.filter(k => t.includes(k));
  return matches.length >= 2;  // al menos 2 componentes reconocibles
}

/**
 * ¿El texto es una respuesta válida a la pregunta?
 * Retorna: 'valid' | 'noise'
 */
async function isValidResponse(questionContext, transcribedText) {
  if (!transcribedText || transcribedText.trim().length < 2) return 'noise';

  // Bypass para address_recall: si contiene fragmentos de dirección, es válido
  if (questionContext && questionContext.toLowerCase().includes('direcci') && looksLikeAddress(transcribedText)) {
    return 'valid';
  }

  const system = `Eres un clasificador. Responde SOLO con una palabra: "valid" o "noise".
"valid" si el paciente intenta responder la pregunta, aunque sea incorrectamente.
"noise" si es una frase irrelevante, tos, silencio grabado, o texto incomprensible.`;

  const user = `Pregunta: "${questionContext}"\nRespuesta transcrita: "${transcribedText}"\n¿Es válida?`;

  try {
    const result = await callLLM(system, user);
    return result.includes('valid') ? 'valid' : 'noise';
  } catch (e) {
    console.error('❌ ResponseValidator.isValidResponse:', e.message);
    return 'valid'; // en caso de error, no bloquear el test
  }
}

/**
 * Para preguntas de tipo 'partial' (countdown, months_reverse).
 * Retorna: 'perfect' | 'one_error' | 'failed'
 *
 * Las transcripciones son fragmentos STT acumulados separados por espacios,
 * pueden contener interrupciones, repeticiones o fillers.
 */
async function evaluatePartialResponse(questionId, transcribedText) {
  if (!transcribedText) return 'failed';

  // ── Evaluación determinista rápida antes de llamar al LLM ────────────────────

  if (questionId === 'countdown') {
    const result = evaluateCountdownDeterministic(transcribedText);
    if (result) {
      console.log(`🔢 [Validator] countdown determinístico: ${result}`);
      return result;
    }
  }

  if (questionId === 'months_reverse') {
    const result = evaluateMonthsDeterministic(transcribedText);
    if (result) {
      console.log(`📅 [Validator] months_reverse determinístico: ${result}`);
      return result;
    }
  }

  // ── Fallback al LLM para casos ambiguos ──────────────────────────────────────
  let system, user;

  if (questionId === 'countdown') {
    system = `Eres un evaluador clínico. El paciente tenía que contar desde el 20 hasta el 1.
La transcripción puede tener fragmentos separados (pausas del STT), fillers como "emm", repeticiones,
o interrupciones. Evalúa la INTENCIÓN y CAPACIDAD, no la perfección fonética.
Responde SOLO una palabra: "perfect", "one_error" o "failed".
- perfect: logró contar del 20 al 1 sin errores o con pequeñas pausas
- one_error: un error numérico o un número saltado, pero continuó la secuencia
- failed: múltiples errores, se detuvo antes del 10, o no intentó contar`;
    user = `Transcripción acumulada del paciente: "${transcribedText}"\nResultado:`;

  } else if (questionId === 'months_reverse') {
    system = `Eres un evaluador clínico. El paciente tenía que decir los meses del año en orden inverso
(diciembre, noviembre, octubre, septiembre, agosto, julio, junio, mayo, abril, marzo, febrero, enero).
La transcripción puede tener fragmentos separados por pausas del STT y fillers.
Evalúa la INTENCIÓN y CAPACIDAD.
Responde SOLO una palabra: "perfect", "one_error" o "failed".
- perfect: todos los meses en orden inverso sin errores significativos
- one_error: un error de orden o un mes saltado, pero llegó hasta enero (o cerca)
- failed: múltiples errores, se detuvo antes de julio, o no intentó la secuencia inversa`;
    user = `Transcripción acumulada del paciente: "${transcribedText}"\nResultado:`;

  } else {
    return 'failed';
  }

  try {
    const result = await callLLM(system, user);
    if (result.includes('perfect'))                                   return 'perfect';
    if (result.includes('one_error') || result.includes('one error')) return 'one_error';
    return 'failed';
  } catch (e) {
    console.error('❌ ResponseValidator.evaluatePartialResponse:', e.message);
    return 'failed';
  }
}

// ── Evaluación determinista countdown ────────────────────────────────────────
function evaluateCountdownDeterministic(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ');

  // Extraer todos los números mencionados (dígitos o palabras)
  const wordMap = {
    'veinte':20,'diecinueve':19,'dieciocho':18,'diecisiete':17,'dieciseis':16,
    'quince':15,'catorce':14,'trece':13,'doce':12,'once':11,'diez':10,
    'nueve':9,'ocho':8,'siete':7,'seis':6,'cinco':5,'cuatro':4,'tres':3,'dos':2,'uno':1
  };

  const found = [];

  // Primero extraer dígitos en secuencia
  const digitMatches = [...normalized.matchAll(/\b(20|19|18|17|16|15|14|13|12|11|10|[1-9])\b/g)];
  digitMatches.forEach(m => found.push(parseInt(m[1])));

  // Si no hay suficientes dígitos, buscar palabras
  if (found.length < 5) {
    found.length = 0;
    const words = normalized.split(/\s+/);
    words.forEach(w => { if (wordMap[w]) found.push(wordMap[w]); });
  }

  if (found.length < 5) return null; // no suficiente data para evaluar

  // Verificar secuencia descendente
  const sequence = found.filter((v, i) => i === 0 || v < found[i-1]);
  const errors   = found.length - sequence.length;

  const hasStart = found[0] >= 18; // comenzó cerca del 20
  const hasEnd   = found[found.length - 1] <= 3; // llegó cerca del 1

  if (errors === 0 && hasStart && hasEnd)  return 'perfect';
  if (errors <= 1 && hasStart)             return 'one_error';
  if (errors >= 2 || !hasStart)            return 'failed';
  return null;
}

// ── Evaluación determinista meses inversos ────────────────────────────────────
function evaluateMonthsDeterministic(text) {
  const normalized = text.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  const MONTHS_ORDER = [
    'diciembre','noviembre','octubre','septiembre','agosto',
    'julio','junio','mayo','abril','marzo','febrero','enero'
  ];

  const mentioned = MONTHS_ORDER.filter(m => normalized.includes(m));

  if (mentioned.length < 4) return null; // no suficiente data

  // Verificar que los que aparecen estén en orden correcto relativo
  let errors = 0;
  let lastIdx = -1;
  for (const m of mentioned) {
    const idx = MONTHS_ORDER.indexOf(m);
    if (idx < lastIdx) errors++; // aparece antes de donde debería
    else lastIdx = idx;
  }

  const completed = mentioned.length >= 10; // mencionó al menos 10 de 12

  if (errors === 0 && completed)             return 'perfect';
  if (errors <= 1)                           return 'one_error';
  return 'failed';
}

/**
 * ¿El texto indica intención de cancelar el test?
 * Retorna: true | false
 */
const CANCEL_KEYWORDS = [
  'no quiero', 'no deseo', 'para', 'detente', 'basta', 'suficiente',
  'cancela', 'cancele', 'termina', 'termínalo', 'ya no', 'me cansé',
  'estoy cansado', 'no puedo', 'déjame', 'dejame', 'quieto', 'stop'
];

async function isCancelIntent(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Primero: keywords rápidas (sin LLM)
  if (CANCEL_KEYWORDS.some(k => lower.includes(k))) return true;

  // Segundo: LLM solo si no hubo match rápido
  try {
    const system = `Eres un clasificador. Responde SOLO "yes" o "no".
¿El paciente está pidiendo detener o cancelar una evaluación médica en curso?`;
    const user   = `Texto: "${text}"\n¿Quiere cancelar?`;
    const result = await callLLM(system, user);
    return result.includes('yes');
  } catch {
    return false;
  }
}

module.exports = { isValidResponse, evaluatePartialResponse, isCancelIntent };
