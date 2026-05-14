/**
 * 6cit/index.js — Orquestador del test 6CIT
 */

const { BaseTest }                    = require('../BaseTest');
const { TestRunner, CancelledError }  = require('../../TestRunner');
const { QUESTIONS, MAX_TOTAL_SCORE }  = require('./questions');
const { scoreAnswer, interpretScore } = require('./scorer');
const { evaluatePartialResponse }     = require('../../ResponseValidator');
const { sleep }                       = require('../../utils');

class SixCITTest extends BaseTest {
  get id()       { return 'sixcit'; }
  get name()     { return '6CIT — Cognitive Impairment Test'; }
  get version()  { return 'Kingshill 2000'; }
  get maxScore() { return MAX_TOTAL_SCORE; }

  async run(ctx, runner) {
    const startedAt = Date.now();
    const answers   = {};
    let totalScore  = 0;
    let _ackIndex   = 0;

    try {
      await runner.say(
        'Vamos a hacer una pequeña evaluación de memoria y orientación. ' +
        'No se preocupe si no recuerda alguna respuesta, lo importante es que haga su mejor esfuerzo. ' +
        'En cualquier momento puede pedirme que nos detengamos. ' +
        '¿Está listo para comenzar?'
      );
      await runner.waitForReady(15000);

      for (const question of QUESTIONS) {
        // Framing previo para preguntas cognitivamente exigentes
        if (question.id === 'countdown') {
          await runner.say('Ahora le voy a pedir algo un poco más difícil.');
        } else if (question.id === 'months_reverse') {
          await runner.say('Muy bien. Ahora haremos algo parecido pero con los meses del año.');
        }

        if (question.type === 'memory_register') {
          // Dirección + pedido de repetición en un solo TTS: evita pausa entre frases.
          await runner.say(`${question.tts} ¿Podría repetirla, por favor?`);
          runner.clearBuffer();
          const answer = await runner.waitForResponse('¿Podría repetir la dirección?', question.id);
          await runner.say('Muy bien. Intente recordarla.');
          runner.clearBuffer();
          answers[question.id] = { ...answer, score: 0, detail: 'registro' };
          continue;
        }

        await runner.say(question.tts);

        const answer = await runner.waitForResponse(question.tts, question.id);

        // Iniciar evaluación parcial en paralelo con el acuse de recibo
        const partialPromise = (question.scoreMode === 'partial' && answer.status === 'answered')
          ? evaluatePartialResponse(question.id, answer.text)
          : Promise.resolve(null);

        // Acuse de recibo según estado — mientras el LLM evalúa en segundo plano
        if (answer.status === 'no_response') {
          await runner.say('No hay problema, continuemos.');
        } else if (answer.status === 'unclear') {
          await runner.say('De acuerdo, seguimos.');
        } else {
          const ACK = [
            'Okey, recibido.',
            'Muy bien, sigamos.',
            'Perfecto, continuemos.',
            'Okey, siguiente pregunta.',
            'Muy bien, continuamos.',
          ];
          await runner.say(ACK[_ackIndex++ % ACK.length]);
        }

        const partialQuality = await partialPromise;
        if (partialQuality !== null) answer.quality = partialQuality;

        const { score, detail, componentScores } = scoreAnswer(question, answer);
        totalScore += score;

        answers[question.id] = {
          status:          answer.status,
          text:            answer.text    || null,
          quality:         answer.quality || null,
          score,
          maxScore:        question.maxScore,
          detail,
          componentScores: componentScores || null
        };

        let logLine = `📊 [6CIT] ${question.id}: ${score}/${question.maxScore} (${detail})`;
        if (componentScores) {
          const parts = Object.entries(componentScores)
            .map(([c, r]) => `${r === 'correcto' ? '✅' : '❌'} "${c}"`)
            .join('  ');
          logLine += `  →  ${parts}`;
        }
        console.log(logLine);
        await sleep(400);
      }

      const endedAt        = Date.now();
      const interpretation = interpretScore(totalScore);

      // El post-test en server.js retoma conversación via LLM — no decir nada aquí

      console.log(`✅ [6CIT] Score: ${totalScore}/${MAX_TOTAL_SCORE} — ${interpretation.label}`);

      return {
        testId:              this.id,
        testVersion:         this.version,
        status:              'completed',
        answers,
        totalScore,
        maxScore:            MAX_TOTAL_SCORE,
        interpretation,
        startedAt,
        endedAt,
        cancelledAtQuestion: null
      };

    } catch (err) {
      if (err instanceof CancelledError) {
        const answeredIds = Object.keys(answers);
        const pending     = QUESTIONS.filter(q => !answeredIds.includes(q.id));
        const cancelledAt = pending[0]?.id || null;
        console.log(`⚠️  [6CIT] Cancelado en: ${cancelledAt}`);

        return {
          testId:              this.id,
          testVersion:         this.version,
          status:              'cancelled',
          answers,
          totalScore:          null,
          maxScore:            MAX_TOTAL_SCORE,
          interpretation:      null,
          startedAt,
          endedAt:             Date.now(),
          cancelledAtQuestion: cancelledAt
        };
      }

      console.error('❌ [6CIT] Error inesperado:', err);
      return {
        testId:              this.id,
        testVersion:         this.version,
        status:              'interrupted',
        answers,
        totalScore:          null,
        maxScore:            MAX_TOTAL_SCORE,
        interpretation:      null,
        startedAt,
        endedAt:             Date.now(),
        cancelledAtQuestion: null
      };
    }
  }

  interpret(score) { return interpretScore(score); }
}

module.exports = { SixCITTest };