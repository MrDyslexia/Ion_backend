/** Utilidades compartidas del motor */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { sleep };
