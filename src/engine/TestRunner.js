/**
 * TestRunner.js
 *
 * Motor genérico TTS → espera STT/VAD → valida → retorna.
 *
 * ESTRATEGIA DE CAPTURA:
 *
 *  Preguntas cortas  (año, mes, hora, dirección)
 *    → Modo SINGLE: el primer fragmento STT final válido cierra la espera.
 *
 *  Preguntas largas  (contar 20→1, meses inversos)
 *    → Modo VAD: el VAD detecta habla y silencio a nivel de audio.
 *      Mientras hay habla, los fragmentos STT se acumulan.
 *      Cuando el VAD detecta silencio prolongado (ctx.vadSilenceMs),
 *      se cierra la espera y se entrega el texto acumulado.
 *
 * FILLERS ("emm", "pues", repetir la pregunta):
 *    → Ignorados silenciosamente. El runner sigue esperando sin ningún feedback.
 *
 * SOLICITUD DE REPETICIÓN:
 *    → Detectada síncronamente en resolveSTT con keywords.
 *      El runner repite la pregunta y vuelve a esperar (sin consumir intentos).
 *      Puede ocurrir ilimitadas veces mientras el paciente lo solicite.
 *
 * Estados:
 *   IDLE             → sin operación activa
 *   WAITING_RESPONSE → esperando respuesta del paciente
 *   WAITING_CONFIRM  → esperando confirmación de cancelación
 */

const { isValidResponse, isCancelIntent } = require('./ResponseValidator');
const { synthesizeSpeech } = require('./ttsHelper');
const { sleep }                           = require('./utils');

const STATE = {
  IDLE:             'IDLE',
  WAITING_RESPONSE: 'WAITING_RESPONSE',
  WAITING_CONFIRM:  'WAITING_CONFIRM'
};

// ── Timeouts ──────────────────────────────────────────────────────────────────
const TIMEOUT_FIRST_SHORT  = 60000;  // 60s sin actividad → repetir pregunta (modo single)
const TIMEOUT_FIRST_LONG   = 120000; // 120s sin STT ni VAD → repetir pregunta (modo vad)
const TIMEOUT_RETRY        = 60000;  // 60s retry tras no_response
const TIMEOUT_CONFIRM      =  8000;  // confirmación cancelación

// ── Patrones de filler ────────────────────────────────────────────────────────
const FILLER_RE = [
  /^(e+m+|a+h+|u+h+|hm+|mm+|eh+|ah+|uh+|oh+)\s*$/i,
  /^(pues|bueno|a ver|veamos|espera|dejame|déjame|vamos|vamos a ver|es que|o sea)\s*[,.]?\s*$/i,
  /^(okay|ok|vale|claro|listo)\s*$/i,
];

// Fracción de palabras (>2 chars) compartidas entre dos fragmentos STT
function wordOverlap(a, b) {
  const norm = s => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9\s]/g,' ');
  const wordsA = new Set(norm(a).split(/\s+/).filter(w => w.length > 2));
  if (!wordsA.size) return 0;
  const wordsB = norm(b).split(/\s+/).filter(w => w.length > 2);
  const hits = wordsB.filter(w => wordsA.has(w)).length;
  return hits / Math.max(wordsA.size, wordsB.length, 1);
}

// Si el texto del paciente reproduce más del 55% de palabras de la pregunta → eco
function isQuestionEcho(text, questionText) {
  if (!text || !questionText) return false;
  const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z\s]/g,'');
  const tWords = normalize(text).split(/\s+/).filter(w => w.length > 3);
  if (tWords.length < 2) return false;
  const qSet = new Set(normalize(questionText).split(/\s+/));
  const overlap = tWords.filter(w => qSet.has(w)).length;
  return overlap / tWords.length > 0.55;
}

const AFFIRMATIVE_RE = /^(sí|si|no)\s*$/i;

function isFiller(text, mode) {
  const t = (text || '').trim();
  if (AFFIRMATIVE_RE.test(t)) return false;
  if (FILLER_RE.some(p => p.test(t))) return true;
  // Solo filtrar fragmentos de 1 palabra muy cortos (≤3 chars): evita descartar
  // meses ("octubre", "mayo") o números ("veinte") que el paciente dice uno a uno.
  if (mode === 'vad' && t.split(/\s+/).length === 1 && t.length <= 3) return true;
  return false;
}

// ── Detección síncrona de solicitud de repetición ────────────────────────────
// Se detecta en resolveSTT (síncrono) para interceptar ANTES de cualquier validación.
const REPEAT_KEYWORDS_SYNC = [
  'repetir','repita','repite','de nuevo','otra vez',
  'no entendi','no escuche','no oi','no le oi','no lo oi',
  'puede repetir','puede repetirlo','digalo de nuevo',
  'no entendiste','que dijo','como dice','perdon','mande',
  'no escuche bien','mas despacio','mas lento',
  'vuelva a','vuelve a','no le entendi','no lo entendi',
  'no le oiste','no oiste','repitelo','repite la'
];

const CANCEL_KEYWORDS_SYNC = [
  'quiero salir','quiero parar','quiero detener','quiero terminar',
  'salir del test','salir de la evaluacion','salir de la evaluacion',
  'parar el test','terminar el test',
  'no quiero continuar','no quiero seguir',
  'basta','detente','cancela','cancele','suficiente','para ya'
];

function normalizeSync(t) {
  return (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function isRepeatSync(text) {
  const t = normalizeSync(text);
  return REPEAT_KEYWORDS_SYNC.some(k => t.includes(k));
}

function isCancelSync(text) {
  const t = normalizeSync(text);
  return CANCEL_KEYWORDS_SYNC.some(k => t.includes(k));
}

// Respuestas negativas del paciente ante "¿Está listo para comenzar?"
function _wantsStopReady(text) {
  const t = normalizeSync(text);
  if (/\bno\b/.test(t)) return true;
  return ['basta','cancela','quiero salir','ahora no','luego','mañana','manana',
          'despues','después','todavia','todavía','aun no','aún no',
          'cansado','cansada','prefiero no','no me siento','no estoy'].some(k => t.includes(k));
}

class CancelledError extends Error {
  constructor() { super('Test cancelado por el paciente'); this.code = 'CANCELLED'; }
}

class TestRunner {
  constructor(ctx) {
    this.ctx      = ctx;
    this.socket   = ctx.socket;
    this.state    = STATE.IDLE;

    // Para modo single
    this._resolve           = null;
    this._timeout           = null;
    this._pendingRepeatResolve = null; // usado por el loop waitWithRepeat
    this._confirmQueue      = null;    // respuesta recibida mientras TTS de confirmación

    // Para modo VAD
    this._vadResolve     = null;
    this._vadTimeout     = null;
    this._vadAccumulated = [];
    this._collectMode     = 'single';
    this._currentQuestion = '';
    this._allAccumulated  = [];

    // Ventana de pre-armado: STT que llega justo al final del TTS
    this._bufferedSTT      = null;
    this._lastSayEnd       = 0;
    this._sayActive        = false;  // true mientras say() está reproduciendo audio
    this._lastAcceptedText = null;   // última respuesta aceptada (para filtrar ecos de pregunta anterior)

    // Flag de cancelación: permite que say() y waitForResponse() aborten limpiamente
    this._cancelled = false;
  }

  // ── TTS ──────────────────────────────────────────────────────────────────────

  async say(text) {
    if (this._cancelled) throw new CancelledError();
    this._sayActive     = true;
    this.ctx.vadEnabled = false;

    try {
      console.log(`🔊 [Runner] "${text.slice(0, 70)}"`);
      this.socket.emit('assistant_text',      { delta: text });
      this.socket.emit('assistant_text_done', { text });

      const audioBuf = await synthesizeSpeech(text);
      if (audioBuf) {
        this.socket.emit('tts_audio', {
          audio:    audioBuf.toString('base64'),
          mimeType: 'audio/wav'
        });
        const durationMs = Math.max(1000, (audioBuf.length / 32000) * 1000);
        await sleep(durationMs);
        if (this._cancelled) throw new CancelledError();
        // Registrar fin del audio ANTES del buffer extra: STT que llegue
        // en esta ventana se guarda en lugar de descartarse (race condition fix)
        this._lastSayEnd = Date.now();
        await sleep(600);
      } else {
        this._lastSayEnd = Date.now();
        await sleep(1500);
      }
      if (this._cancelled) throw new CancelledError();
    } finally {
      this._sayActive = false;
    }
  }

  // ── Callbacks VAD ─────────────────────────────────────────────────────────────

  onVadSpeech() {
    if (this.state !== STATE.WAITING_RESPONSE || this._collectMode !== 'vad') return;
    clearTimeout(this._vadTimeout);
    this._vadTimeout = setTimeout(() => this._vadTimeoutFired(), TIMEOUT_FIRST_LONG);
  }

  onVadSilence() {
    if (this.state !== STATE.WAITING_RESPONSE || this._collectMode !== 'vad') return;
    if (!this._vadResolve) return;

    const text = this._vadAccumulated.join(' ').trim();

    // Ignorar silencio si aún no hay nada acumulado: el paciente no ha empezado a hablar
    if (!text) {
      console.log('🔇 [VAD] Silencio sin acumulado — ignorado (esperando habla)');
      return;
    }

    console.log(`🔇 [VAD] Silencio detectado. Acumulado: "${text.slice(0, 60)}"`);

    clearTimeout(this._vadTimeout);
    this.ctx.vadEnabled = false;

    const resolve = this._vadResolve;
    this._vadResolve     = null;
    this._vadAccumulated = [];
    this.state = STATE.IDLE;
    resolve({ text: text || null, timedOut: false });
  }

  _vadTimeoutFired() {
    if (!this._vadResolve) return;
    this.ctx.vadEnabled = false;
    const text = this._vadAccumulated.join(' ').trim();
    console.log(`⏰ [VAD] Timeout máximo. Acumulado: "${text.slice(0, 60)}"`);
    const resolve = this._vadResolve;
    this._vadResolve     = null;
    this._vadAccumulated = [];
    this.state = STATE.IDLE;
    resolve({ text: text || null, timedOut: !text });
  }

  // ── Entrada STT ──────────────────────────────────────────────────────────────

  resolveSTT(text) {
    const t = (text || '').trim();
    if (!t) return;

    // ── Modo confirmación ─────────────────────────────────────────────────────
    if (this.state === STATE.WAITING_CONFIRM) {
      if (this._resolve) {
        // Promesa ya lista: resolver directamente
        clearTimeout(this._timeout);
        const resolve = this._resolve;
        this._resolve = null;
        this.state = STATE.IDLE;
        resolve({ text: t, timedOut: false });
      } else {
        // TTS todavía reproduciéndose: encolar para cuando la promesa esté lista
        console.log(`📬 [Runner] Confirmación encolada (TTS en curso): "${t.slice(0, 20)}"`);
        this._confirmQueue = t;
      }
      return;
    }

    if (this.state !== STATE.WAITING_RESPONSE) {
      // Guardar STT que llega durante el TTS o dentro de 1s tras su fin (race condition al inicio de espera)
      if (this.state === STATE.IDLE && (this._sayActive || Date.now() - this._lastSayEnd < 1000)) {
        console.log(`📦 [Runner] STT pre-armado (TTS activo o reciente): "${t.slice(0, 40)}"`);
        this._bufferedSTT = t;
        return;
      }
      console.log(`🔇 [Runner] STT descartado (estado: ${this.state}): "${t.slice(0, 40)}"`);
      return;
    }

    // ── Modo VAD: acumular ────────────────────────────────────────────────────
    if (this._collectMode === 'vad') {
      if (!this._vadResolve) return;

      if (isFiller(t, 'vad') || isQuestionEcho(t, this._currentQuestion)) {
        console.log(`💭 [Runner] Ignorado (filler/eco): "${t.slice(0, 40)}"`);
        return;
      }

      // Repetición en modo VAD: cerrar el VAD y señalizar repeat
      if (isRepeatSync(t)) {
        console.log(`🔄 [Runner] Repetición solicitada (VAD): "${t.slice(0, 40)}"`);
        clearTimeout(this._vadTimeout);
        this.ctx.vadEnabled  = false;
        const resolve        = this._vadResolve;
        this._vadResolve     = null;
        this._vadAccumulated = [];
        this.state           = STATE.IDLE;
        resolve({ text: null, timedOut: false, repeatRequest: true });
        return;
      }

      // Cancelación sync en VAD: resolver inmediatamente para que isCancelIntent lo procese
      if (isCancelSync(t)) {
        console.log(`🛑 [Runner] Cancelación detectada (VAD sync): "${t.slice(0, 40)}"`);
        clearTimeout(this._vadTimeout);
        this.ctx.vadEnabled  = false;
        const resolve        = this._vadResolve;
        this._vadResolve     = null;
        this._vadAccumulated = [];
        this.state           = STATE.IDLE;
        resolve({ text: t, timedOut: false });
        return;
      }

      // Deduplicar: si el nuevo fragmento solapa >60% con el último acumulado
      // (ej: pre-arm + re-transcripción de la misma frase), reemplazar en lugar de añadir
      const last = this._vadAccumulated[this._vadAccumulated.length - 1];
      if (last && wordOverlap(t, last) > 0.60) {
        this._vadAccumulated[this._vadAccumulated.length - 1] = t;
        console.log(`🔄 [Runner] Fragmento reemplazado (re-transcripción): "${t.slice(0, 40)}"`);
      } else {
        this._vadAccumulated.push(t);
        console.log(`📥 [Runner] Acumulado (${this._vadAccumulated.length}): "${t.slice(0, 40)}"`);
      }
      // Nuevo fragmento STT = el paciente habló → resetear ventana de silencio
      this.ctx.resetVadSilenceTimer?.();
      return;
    }

    // ── Modo single ───────────────────────────────────────────────────────────
    if (!this._resolve) return;

    if (isFiller(t, 'single') || isQuestionEcho(t, this._currentQuestion)) {
      console.log(`💭 [Runner] Ignorado (filler/eco): "${t.slice(0, 40)}"`);
      return;
    }

    // Repetición en modo single: cancelar timer y señalizar repeat
    if (isRepeatSync(t)) {
      console.log(`🔄 [Runner] Repetición solicitada: "${t.slice(0, 40)}"`);
      clearTimeout(this._timeout);
      const resolve  = this._resolve;
      this._resolve  = null;
      this.state     = STATE.IDLE;
      resolve({ text: null, timedOut: false, repeatRequest: true });
      return;
    }

    clearTimeout(this._timeout);
    const resolve = this._resolve;
    this._resolve = null;
    this.state = STATE.IDLE;
    resolve({ text: t, timedOut: false });
  }

  // ── Espera interna: modo single ───────────────────────────────────────────────

  _waitSingle(timeoutMs) {
    // Si hay STT pre-armado, resolverlo directamente sin esperar (si no es ruido)
    if (this._bufferedSTT) {
      const buffered = this._bufferedSTT;
      this._bufferedSTT = null;

      const normalize = s => (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
      const isEchoPrev = this._lastAcceptedText && normalize(buffered) === normalize(this._lastAcceptedText);
      const discard = isFiller(buffered, 'single')
        || isQuestionEcho(buffered, this._currentQuestion)
        || isEchoPrev;

      if (discard) {
        console.log(`💭 [Runner] Pre-armado descartado (filler/eco/dup): "${buffered.slice(0, 40)}"`);
        // caer al bloque de espera normal
      } else {
        console.log(`📦 [Runner] Flush pre-armado (single): "${buffered.slice(0, 40)}"`);
        this.state = STATE.IDLE;
        return Promise.resolve({ text: buffered, timedOut: false });
      }
    }
    return new Promise(resolve => {
      this._resolve = resolve;
      this._timeout = setTimeout(() => {
        this._resolve = null;
        this.state = STATE.IDLE;
        resolve({ text: null, timedOut: true });
      }, timeoutMs);
    });
  }

  // ── Espera interna: modo VAD ──────────────────────────────────────────────────

  _waitVAD(silenceMs = null) {
    this._vadAccumulated = [];
    this.ctx.vadEnabled  = true;
    if (silenceMs !== null) this.ctx.vadSilenceMs = silenceMs;

    // Si hay STT pre-armado, añadirlo como primer fragmento acumulado (si no es ruido)
    if (this._bufferedSTT) {
      const buffered = this._bufferedSTT;
      this._bufferedSTT = null;
      if (!isFiller(buffered, 'vad') && !isQuestionEcho(buffered, this._currentQuestion)) {
        console.log(`📦 [Runner] Flush pre-armado (vad): "${buffered.slice(0, 40)}"`);
        this._vadAccumulated.push(buffered);
        // El paciente ya habló antes de que empezara el VAD → arrancar el countdown de silencio
        // Si no se hace esto, el timer nunca se arma (no llega energía nueva) y espera 120s
        this.ctx.resetVadSilenceTimer?.();
      } else {
        console.log(`💭 [Runner] Pre-armado VAD descartado (filler/eco): "${buffered.slice(0, 40)}"`);
      }
    }

    return new Promise(resolve => {
      this._vadResolve = resolve;
      this._vadTimeout = setTimeout(() => this._vadTimeoutFired(), TIMEOUT_FIRST_LONG);
    });
  }

  // ── Espera con soporte de repetición ilimitada ───────────────────────────────
  // Cada vez que el paciente solicita repetición, dice la pregunta de nuevo
  // y vuelve a esperar. No consume intentos de timeout/retry.

  async _waitWithRepeat(questionText, mode, silenceMs, timeoutMs) {
    while (true) {
      this._collectMode = mode;
      this.state = STATE.WAITING_RESPONSE;

      const result = mode === 'vad'
        ? await this._waitVAD(silenceMs)
        : await this._waitSingle(timeoutMs);

      if (result.cancelled) return result;

      if (result.repeatRequest) {
        await this.say(questionText);
        continue; // volver a esperar sin contar como intento
      }

      return result;
    }
  }

  // ── Espera de confirmación de inicio ─────────────────────────────────────────
  // Pausa el test tras la introducción y espera que el paciente diga que está listo.
  // Cualquier respuesta (o timeout) = continuar. Cancel keywords = CancelledError.

  async waitForReady(timeoutMs = 12000) {
    if (this._cancelled) throw new CancelledError();

    // Si hay algo pre-buffereado (llegó durante el TTS), procesarlo ya
    if (this._bufferedSTT) {
      const buf = this._bufferedSTT;
      this._bufferedSTT = null;
      if (_wantsStopReady(buf)) throw new CancelledError();
      return; // cualquier otra respuesta → continuar
    }

    this.state = STATE.WAITING_CONFIRM;
    this._collectMode = 'single';
    this.ctx.vadEnabled = true;

    const result = await new Promise(resolve => {
      this._resolve = resolve;
      this._timeout = setTimeout(() => {
        this._resolve = null;
        this.ctx.vadEnabled = false;
        this.state = STATE.IDLE;
        resolve({ text: null, timedOut: true });
      }, timeoutMs);
    });

    this.ctx.vadEnabled = false;
    this.state = STATE.IDLE;

    if (result.text && _wantsStopReady(result.text)) throw new CancelledError();
    // timeout o cualquier respuesta positiva → continuar normalmente
  }

  // Descarta cualquier STT capturado en el buffer pre-armado (eco de TTS, etc.)
  clearBuffer() {
    this._bufferedSTT = null;
  }

  // ── API pública ───────────────────────────────────────────────────────────────

  async waitForResponse(questionText, questionId) {
    this._currentQuestion = questionText;

    const longQuestions = ['countdown', 'months_reverse', 'address_recall', 'time'];
    const mode = longQuestions.includes(questionId) ? 'vad' : 'single';
    const silenceMs = questionId === 'months_reverse' ? 9000
                    : questionId === 'countdown'      ? 7000
                    : questionId === 'address_recall' ? 6000
                    : questionId === 'time'           ? 4000
                    : 3500;
    this._allAccumulated = [];

    // ── Intento 1 ─────────────────────────────────────────────────────────────
    const first = await this._waitWithRepeat(questionText, mode, silenceMs, TIMEOUT_FIRST_SHORT);

    if (first.cancelled) throw new CancelledError();

    if (mode === 'vad' && first.text) this._allAccumulated.push(first.text);

    if (first.timedOut || !first.text) {
      await this.say('Perdone, no le escuché bien. ¿Podría repetir su respuesta?');
      await this.say(questionText);

      const second = await this._waitWithRepeat(questionText, mode, silenceMs, TIMEOUT_RETRY);

      if (second.cancelled) throw new CancelledError();
      if (second.timedOut || !second.text) return { status: 'no_response', text: null };
      if (await isCancelIntent(second.text)) await this._handleCancelConfirm(questionText);
      const v = await isValidResponse(questionText, second.text);
      if (v === 'noise') return { status: 'unclear', text: null };
      this._lastAcceptedText = second.text;
      return { status: 'answered', text: second.text };
    }

    // Verificar cancelación
    if (await isCancelIntent(first.text)) await this._handleCancelConfirm(questionText);

    // Validar respuesta
    const validity = await isValidResponse(questionText, first.text);

    if (validity === 'noise') {
      // En modo VAD: el paciente pudo haber continuado hablando después del primer silencio.
      if (mode === 'vad') {
        const retry = await this._waitWithRepeat(questionText, mode, silenceMs, TIMEOUT_RETRY);
        if (retry.cancelled) throw new CancelledError();
        if (!retry.timedOut && retry.text) {
          this._allAccumulated.push(retry.text);
          const combined = this._allAccumulated.join(' ');
          const v2 = await isValidResponse(questionText, combined);
          if (v2 !== 'noise') {
            this._lastAcceptedText = combined;
            return { status: 'answered', text: combined };
          }
        }
      }
      await this.say('Perdone, no le escuché bien. ¿Podría repetirlo?');

      const retry = await this._waitWithRepeat(questionText, mode, silenceMs, TIMEOUT_RETRY);

      if (retry.cancelled) throw new CancelledError();
      if (retry.timedOut || !retry.text) return { status: 'unclear', text: null };
      if (await isCancelIntent(retry.text)) await this._handleCancelConfirm(questionText);
      const v2 = await isValidResponse(questionText, retry.text);
      if (v2 === 'noise') return { status: 'unclear', text: null };
      const finalText = mode === 'vad'
        ? [...this._allAccumulated, retry.text].join(' ')
        : retry.text;
      this._lastAcceptedText = finalText;
      return { status: 'answered', text: finalText };
    }

    this._lastAcceptedText = first.text;
    return { status: 'answered', text: first.text };
  }

  // ── Cancelación ───────────────────────────────────────────────────────────────

  async _handleCancelConfirm(questionText) {
    // Marcar estado ANTES del TTS para que resolveSTT pueda encolar la respuesta
    this.state = STATE.WAITING_CONFIRM;
    this._confirmQueue = null;
    await this.say('¿Quiere que nos detengamos?');

    const confirm = await new Promise(resolve => {
      // Si el paciente respondió mientras el TTS estaba reproduciéndose, usar esa respuesta
      if (this._confirmQueue) {
        const queued = this._confirmQueue;
        this._confirmQueue = null;
        this.state = STATE.IDLE;
        console.log(`📬 [Runner] Usando confirmación encolada: "${queued.slice(0, 20)}"`);
        resolve({ text: queued, timedOut: false });
        return;
      }
      this._resolve = resolve;
      this._timeout = setTimeout(() => {
        this._resolve = null;
        this.state = STATE.IDLE;
        resolve({ text: null, timedOut: true });
      }, TIMEOUT_CONFIRM);
    });

    if (confirm.timedOut || !confirm.text) {
      await this.say('Muy bien, seguimos adelante.');
      this.state = STATE.WAITING_RESPONSE;
      return;
    }

    const lower = confirm.text.toLowerCase();
    const confirmed = ['si','sí','yes','detener','para','cancela','basta'].some(w => lower.includes(w));

    if (confirmed) {
      await this.say('Entendido. Detenemos la evaluación aquí. Que se recupere bien.');
      throw new CancelledError();
    } else {
      await this.say('Muy bien, continuamos.');
      this.state = STATE.WAITING_RESPONSE;
    }
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────────

  destroy() {
    this._cancelled = true;
    this.ctx.resetVAD();
    clearTimeout(this._timeout);
    clearTimeout(this._vadTimeout);
    if (this._resolve)    { this._resolve({ text: null, timedOut: false, cancelled: true });    this._resolve = null; }
    if (this._vadResolve) { this._vadResolve({ text: null, timedOut: false, cancelled: true }); this._vadResolve = null; }
    this._vadAccumulated = [];
    this._confirmQueue   = null;
    this.state = STATE.IDLE;
  }
}

module.exports = { TestRunner, CancelledError, STATE };