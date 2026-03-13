/**
 * 6cit/index.js — Orquestador del test 6CIT
 */

const { BaseTest }                    = require('../BaseTest');
const { TestRunner, CancelledError }  = require('../../TestRunner');
const { QUESTIONS, MAX_TOTAL_SCORE }  = require('./questions');
const { scoreAnswer, interpretScore } = require('./scorer');
const { evaluatePartialResponse }     = require('../../ResponseValidator');

class SixCITTest extends BaseTest {
  get id()       { return 'sixcit'; }
  get name()     { return '6CIT — Cognitive Impairment Test'; }
  get version()  { return 'Kingshill 2000'; }
  get maxScore() { return MAX_TOTAL_SCORE; }

  async run(ctx, runner) {
    const startedAt = Date.now();
    const answers   = {};
    let totalScore  = 0;

    try {
      await runner.say(
        'Vamos a realizar una evaluación breve de memoria y orientación. ' +
        'No se preocupe si no sabe alguna respuesta, haga lo mejor que pueda. ' +
        'Puede pedir que detengamos en cualquier momento.'
      );

      for (const question of QUESTIONS) {
        await runner.say(question.tts);

        if (question.type === 'memory_register') {
          const answer = await runner.waitForResponse(question.tts, question.id);
          await runner.say('Gracias. Por favor, intente recordar esa dirección.');
          answers[question.id] = { ...answer, score: 0, detail: 'registro' };
          continue;
        }

        const answer = await runner.waitForResponse(question.tts, question.id);

        // Para preguntas parciales, evaluar calidad con LLM
        if (question.scoreMode === 'partial' && answer.status === 'answered') {
          answer.quality = await evaluatePartialResponse(question.id, answer.text);
        }

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

        console.log(`📊 [6CIT] ${question.id}: ${score}/${question.maxScore} (${detail})`);
        await sleep(600);
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = { SixCITTest };
