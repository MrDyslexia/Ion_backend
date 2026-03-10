/**
 * ttsHelper.js
 *
 * Helper de TTS desacoplado para que TestRunner pueda sintetizar voz
 * sin importar server.js (evita dependencia circular).
 */

const TTS_URL = process.env.TTS_URL || 'http://localhost:8002';

async function synthesizeSpeech(text) {
  try {
    const resp = await fetch(`${TTS_URL}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, language: 'es' })
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.error('❌ ttsHelper:', e.message);
    return null;
  }
}

module.exports = { synthesizeSpeech };
