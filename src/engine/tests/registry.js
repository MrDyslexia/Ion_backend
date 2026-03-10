/**
 * registry.js — Registro central de tests disponibles.
 * Para agregar un test nuevo: importarlo y añadirlo a TEST_MAP.
 */

const { SixCITTest } = require('./6cit');

const TEST_MAP = {
  'sixcit': SixCITTest
};

function getTest(testId) {
  const TestClass = TEST_MAP[testId];
  if (!TestClass) throw new Error(`Test desconocido: "${testId}"`);
  return new TestClass();
}

function getAvailableTests() {
  return Object.entries(TEST_MAP).map(([id, TestClass]) => {
    const i = new TestClass();
    return { id, name: i.name, version: i.version, maxScore: i.maxScore };
  });
}

module.exports = { getTest, getAvailableTests };
