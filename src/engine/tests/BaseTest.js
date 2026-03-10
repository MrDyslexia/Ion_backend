/**
 * BaseTest.js — Interfaz abstracta para todos los tests cognitivos.
 */

class BaseTest {
  constructor() {
    if (new.target === BaseTest) {
      throw new Error('BaseTest es abstracta. Usa una subclase.');
    }
  }

  get id()       { throw new Error('Implementar id'); }
  get name()     { throw new Error('Implementar name'); }
  get version()  { throw new Error('Implementar version'); }
  get maxScore() { throw new Error('Implementar maxScore'); }

  /**
   * @param {SessionContext} ctx
   * @param {TestRunner}     runner
   * @returns {Promise<TestResult>}
   */
  async run(ctx, runner) { throw new Error('Implementar run(ctx, runner)'); }

  /**
   * @param {number} score
   * @returns {{ level: string, label: string, color: string }}
   */
  interpret(score) { throw new Error('Implementar interpret(score)'); }
}

module.exports = { BaseTest };
