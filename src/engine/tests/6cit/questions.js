/**
 * questions.js — Definición oficial del 6CIT (Kingshill Version 2000)
 *
 * scoreMode:
 *   'binary'  → correcto/incorrecto, puntaje total si falla
 *   'time'    → correcto si está dentro de ±1 hora
 *   'partial' → 0 / maxScore*0.5 / maxScore según calidad
 *   'address' → 2 pts por cada componente olvidado
 *   'none'    → no puntúa (memory_register)
 */

const ADDRESS = {
  components: ['Manuel', 'Rodríguez', '1373', 'Santiago'],
  full:       'Manuel Rodríguez 1373 Santiago'
};

const QUESTIONS = [
  {
    id:        'year',
    type:      'question',
    tts:       '¿En qué año estamos?',
    maxScore:  4,
    scoreMode: 'binary',
    meta:      {}
  },
  {
    id:        'month',
    type:      'question',
    tts:       '¿En qué mes estamos?',
    maxScore:  3,
    scoreMode: 'binary',
    meta:      {}
  },
  {
    id:        'address_register',
    type:      'memory_register',
    tts:       `Le voy a decir una dirección para que la recuerde. Escuche con atención: ${ADDRESS.full}. ¿Puede repetirla?`,
    maxScore:  0,
    scoreMode: 'none',
    meta:      { address: ADDRESS }
  },
  {
    id:        'time',
    type:      'question',
    tts:       '¿Qué hora es aproximadamente ahora?',
    maxScore:  3,
    scoreMode: 'time',
    meta:      { toleranceMinutes: 60 }
  },
  {
    id:        'countdown',
    type:      'question',
    tts:       '¿Puede contar hacia atrás desde el veinte hasta el uno?',
    maxScore:  4,
    scoreMode: 'partial',
    meta:      {}
  },
  {
    id:        'months_reverse',
    type:      'question',
    tts:       '¿Puede decirme los meses del año en orden inverso, empezando desde diciembre?',
    maxScore:  4,
    scoreMode: 'partial',
    meta:      {}
  },
  {
    id:        'address_recall',
    type:      'question',
    tts:       '¿Recuerda la dirección que le pedí memorizar al principio?',
    maxScore:  10,
    scoreMode: 'address',
    meta:      { address: ADDRESS }
  }
];

const SCORING_QUESTIONS = QUESTIONS.filter(q => q.type === 'question');
const MAX_TOTAL_SCORE   = SCORING_QUESTIONS.reduce((sum, q) => sum + q.maxScore, 0); // 28

module.exports = { QUESTIONS, SCORING_QUESTIONS, ADDRESS, MAX_TOTAL_SCORE };
