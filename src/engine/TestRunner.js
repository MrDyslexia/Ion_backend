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
 * POST-TEST:
 *    → El runner mismo dice una frase de cierre neutral.
 *      No involucra al LLM para el cierre inmediato.
 *
 * Estados:
 *   IDLE             → sin operación activa
 *   WAITING_RESPONSE → esperando respuesta del paciente
 *   WAITING_CONFIRM  → esperando confirmación de cancelación
 */

const { isValidResponse, isCancelIntent } = require('./ResponseValidator');
const { synthesizeSpeech }                = require('./ttsHelper');

const STATE = {
  IDLE:             'IDLE',
  WAITING_RESPONSE: 'WAITING_RESPONSE',
  WAITING_CONFIRM:  'WAITING_CONFIRM'
};

// ── Timeouts ──────────────────────────────────────────────────────────────────
const TIMEOUT_FIRST_SHORT  = 20000;  // 20s sin actividad → repetir pregunta (modo single)
const TIMEOUT_FIRST_LONG   = 30000;  // 30s sin STT ni VAD → repetir pregunta (modo vad)
const TIMEOUT_RETRY        = 18000;  // retry tras no_response
const TIMEOUT_CONFIRM      =  8000;  // confirmación cancelación

// ── Patrones de filler ────────────────────────────────────────────────────────
// Texto que indica pensamiento en voz alta o repetición de la pregunta → ignorar
const FILLER_RE = [
  /^(e+m+|a+h+|u+h+|hm+|mm+|eh+|ah+|uh+|oh+)\s*$/i,
  /^(pues|bueno|a ver|veamos|espera|dejame|déjame|vamos|vamos a ver|es que|o sea)\s*[,.]?\s*$/i,
  /^(sí|si|no|okay|ok|vale|claro|listo)\s*$/i,  // respuestas monosilábicas ambiguas en modo largo
];

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

function isFiller(text, mode) {
  const t = (text || '').trim();
  if (FILLER_RE.some(p => p.test(t))) return true;
  // En modo largo, fragmentos muy cortos también son fillers
  if (mode === 'vad' && t.split(/\s+/).length <= 2 && t.length < 12) return true;
  return false;
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
    this._resolve = null;
    this._timeout = null;

    // Para modo VAD
    this._vadResolve     = null;
    this._vadTimeout     = null;   // timeout máximo sin STT
    this._vadAccumulated = [];     // fragmentos STT acumulados durante habla
    this._collectMode     = 'single';
    this._currentQuestion = '';
    this._allAccumulated  = [];  // acumula STT entre el primer intento y el retry (modo VAD)
  }

  // ── TTS ──────────────────────────────────────────────────────────────────────

  async say(text) {
    // Desactivar VAD mientras el runner habla para no capturar el audio propio
    this.ctx.vadEnabled = false;

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
      await sleep(durationMs + 600);  // margen extra para que el audio termine en cliente
    } else {
      await sleep(1500);
    }
  }

  // ── Callbacks VAD (llamados desde SessionContext.processVAD) ─────────────────

  onVadSpeech() {
    if (this.state !== STATE.WAITING_RESPONSE || this._collectMode !== 'vad') return;
    // Habla detectada → resetear timeout máximo (el paciente está respondiendo)
    clearTimeout(this._vadTimeout);
    this._vadTimeout = setTimeout(() => this._vadTimeoutFired(), TIMEOUT_FIRST_LONG);
  }

  onVadSilence() {
    if (this.state !== STATE.WAITING_RESPONSE || this._collectMode !== 'vad') return;
    if (!this._vadResolve) return;

    // Silencio detectado → entregar lo acumulado
    const text = this._vadAccumulated.join(' ').trim();
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
    if (this.state === STATE.WAITING_CONFIRM && this._resolve) {
      clearTimeout(this._timeout);
      const resolve = this._resolve;
      this._resolve = null;
      this.state = STATE.IDLE;
      resolve({ text: t, timedOut: false });
      return;
    }

    if (this.state !== STATE.WAITING_RESPONSE) {
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

      this._vadAccumulated.push(t);
      console.log(`📥 [Runner] Acumulado (${this._vadAccumulated.length}): "${t.slice(0, 40)}"`);
      return;
    }

    // ── Modo single ───────────────────────────────────────────────────────────
    if (!this._resolve) return;

    if (isFiller(t, 'single') || isQuestionEcho(t, this._currentQuestion)) {
      console.log(`💭 [Runner] Ignorado (filler/eco): "${t.slice(0, 40)}"`);
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

    return new Promise(resolve => {
      this._vadResolve = resolve;
      this._vadTimeout = setTimeout(() => this._vadTimeoutFired(), TIMEOUT_FIRST_LONG);
    });
  }

  // ── API pública ───────────────────────────────────────────────────────────────

  /**
   * Espera la respuesta del paciente con lógica completa.
   *
   * Preguntas largas usan VAD. Preguntas cortas usan timer.
   * Los fillers y ecos se ignoran silenciosamente.
   *
   * Retorna:
   *   { status: 'answered',    text: string }
   *   { status: 'unclear',     text: null   }
   *   { status: 'no_response', text: null   }
   * O lanza CancelledError.
   */
  async waitForResponse(questionText, questionId) {
    this._currentQuestion = questionText;

    const longQuestions = ['countdown', 'months_reverse'];
    const mode = longQuestions.includes(questionId) ? 'vad' : 'single';
    this._collectMode = mode;
    this.state = STATE.WAITING_RESPONSE;

    // Silencio más generoso para meses (el paciente puede pausar entre meses)
    const silenceMs = questionId === 'months_reverse' ? 2800 : 1800;
    this._allAccumulated = [];

    // ── Intento 1 ─────────────────────────────────────────────────────────────
    const first = mode === 'vad'
      ? await this._waitVAD(silenceMs)
      : await this._waitSingle(TIMEOUT_FIRST_SHORT);

    if (mode === 'vad' && first.text) this._allAccumulated.push(first.text);

    if (first.timedOut || !first.text) {
      // Sin respuesta → repetir pregunta una vez
      await this.say(questionText);
      this._collectMode = mode;
      this.state = STATE.WAITING_RESPONSE;

      const second = mode === 'vad'
        ? await this._waitVAD(silenceMs)
        : await this._waitSingle(TIMEOUT_RETRY);

      if (second.timedOut || !second.text) return { status: 'no_response', text: null };
      if (await isCancelIntent(second.text)) await this._handleCancelConfirm(questionText);
      const v = await isValidResponse(questionText, second.text);
      if (v === 'noise') return { status: 'unclear', text: null };
      return { status: 'answered', text: second.text };
    }

    // Verificar cancelación
    if (await isCancelIntent(first.text)) await this._handleCancelConfirm(questionText);

    // Validar respuesta
    const validity = await isValidResponse(questionText, first.text);

    if (validity === 'noise') {
      // En modo VAD para preguntas largas: el paciente pudo haber continuado
      // hablando después del primer silencio. Hacer retry SIN decir nada
      // (solo esperar otro fragmento), combinando con lo ya capturado.
      if (mode === 'vad') {
        this._collectMode = mode;
        this.state = STATE.WAITING_RESPONSE;
        const retry = await this._waitVAD(silenceMs);
        if (!retry.timedOut && retry.text) {
          this._allAccumulated.push(retry.text);
          const combined = this._allAccumulated.join(' ');
          const v2 = await isValidResponse(questionText, combined);
          if (v2 !== 'noise') return { status: 'answered', text: combined };
        }
      }
      await this.say('Disculpe, no le entendí bien. ¿Puede repetir su respuesta?');
      this._collectMode = mode;
      this.state = STATE.WAITING_RESPONSE;

      const retry = mode === 'vad'
        ? await this._waitVAD(silenceMs)
        : await this._waitSingle(TIMEOUT_RETRY);

      if (retry.timedOut || !retry.text) return { status: 'unclear', text: null };
      if (await isCancelIntent(retry.text)) await this._handleCancelConfirm(questionText);
      const v2 = await isValidResponse(questionText, retry.text);
      if (v2 === 'noise') return { status: 'unclear', text: null };
      const finalText = mode === 'vad'
        ? [...this._allAccumulated, retry.text].join(' ')
        : retry.text;
      return { status: 'answered', text: finalText };
    }

    return { status: 'answered', text: first.text };
  }

  // ── Cancelación ───────────────────────────────────────────────────────────────

  async _handleCancelConfirm(questionText) {
    this.state = STATE.WAITING_CONFIRM;
    await this.say('¿Desea detener la evaluación? Diga "sí" para confirmar o "no" para continuar.');

    const confirm = await new Promise(resolve => {
      this._resolve = resolve;
      this._timeout = setTimeout(() => {
        this._resolve = null;
        this.state = STATE.IDLE;
        resolve({ text: null, timedOut: true });
      }, TIMEOUT_CONFIRM);
    });

    if (confirm.timedOut || !confirm.text) {
      await this.say('Continuamos con la evaluación.');
      this.state = STATE.WAITING_RESPONSE;
      return;
    }

    const lower = confirm.text.toLowerCase();
    const confirmed = ['si','sí','yes','detener','para','cancela','basta'].some(w => lower.includes(w));

    if (confirmed) {
      await this.say('Entendido. Detenemos la evaluación aquí.');
      throw new CancelledError();
    } else {
      await this.say('Bien, continuamos.');
      this.state = STATE.WAITING_RESPONSE;
    }
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────────

  destroy() {
    this.ctx.resetVAD();
    clearTimeout(this._timeout);
    clearTimeout(this._vadTimeout);
    if (this._resolve)    { this._resolve({ text: null, timedOut: true });    this._resolve = null; }
    if (this._vadResolve) { this._vadResolve({ text: null, timedOut: true }); this._vadResolve = null; }
    this._vadAccumulated = [];
    this.state = STATE.IDLE;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { TestRunner, CancelledError, STATE };
