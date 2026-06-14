/**
 * ttsHelper.js
 *
 * Helper de TTS desacoplado para que TestRunner pueda sintetizar voz
 * sin importar server.js (evita dependencia circular).
 *
 * Normaliza el texto antes de enviarlo a XTTS-v2 para evitar artefactos
 * de audio causados por markdown, símbolos, URLs, emojis, etc.
 */

const TTS_URL = process.env.TTS_URL || 'http://localhost:8002';

/**
 * Normaliza texto para XTTS-v2:
 * - Elimina markdown (negrita, cursiva, encabezados, listas, líneas horizontales)
 * - Elimina URLs
 * - Elimina emojis y símbolos no pronunciables
 * - Convierte puntuaciones numéricas (e.g. "0/28") a forma verbal
 * - Sustituye caracteres especiales por equivalentes hablables
 * - Limpia espacios y saltos de línea redundantes
 */
function normalizeTTSText(text) {
  if (!text) return '';

  let t = text;

  // Eliminar URLs (http/https/www)
  t = t.replace(/https?:\/\/[^\s]+/g, '');
  t = t.replace(/www\.[^\s]+/g, '');

  // Eliminar emojis y símbolos Unicode no latinos
  t = t.replace(/[\u{1F000}-\u{1FFFF}]/gu, '');
  t = t.replace(/[\u{2600}-\u{27BF}]/gu, '');

  // Eliminar bloques de código markdown (``` ... ```)
  t = t.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`[^`]+`/g, '');

  // Eliminar encabezados markdown (## Título)
  t = t.replace(/^#{1,6}\s+/gm, '');

  // Eliminar líneas horizontales markdown (---, ***, ___)
  t = t.replace(/^[-*_]{3,}\s*$/gm, '');

  // Eliminar negrita e itálica (**texto**, *texto*, __texto__, _texto_)
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');

  // Eliminar marcadores de lista numérica y viñetas usados en resultados de búsqueda
  // e.g. "[1]", "[2]", "1.", "2.", "- ", "• "
  t = t.replace(/\[\d+\]/g, '');
  t = t.replace(/^\s*\d+\.\s+/gm, '');
  t = t.replace(/^\s*[-•*]\s+/gm, '');

  // Convertir puntuaciones numéricas a forma verbal (e.g. "0/28" → "0 de 28")
  // Solo aplica a patrones de 1-2 dígitos/1-2 dígitos que NO formen parte de una fecha (DD/MM/YYYY)
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g, '$1 de $2');

  // Sustituir símbolos por equivalentes hablables o pausas
  t = t.replace(/\s*[→=>]\s*/g, ', ');
  t = t.replace(/\s*[←<=]\s*/g, ', ');
  t = t.replace(/\s*[—–]\s*/g, ', ');  // guión largo → pausa natural
  t = t.replace(/\.\.\./g, '.');         // puntos suspensivos → punto
  t = t.replace(/…/g, '.');
  t = t.replace(/«|»|"|"/g, '');
  t = t.replace(/(\d)\s*%/g, '$1 por ciento');  // 15% → 15 por ciento
  t = t.replace(/[|\\^~<>{}[\]]/g, ' ');
  t = t.replace(/[+=#@$&*]/g, ' ');

  // Saltos de línea → punto o coma para que XTTS haga pausa natural
  t = t.replace(/\n{2,}/g, '. ');   // párrafos → punto
  t = t.replace(/\n/g, ', ');        // salto simple → coma

  // Colapsar espacios múltiples
  t = t.replace(/\s{2,}/g, ' ');

  // Eliminar puntuación duplicada que pudo generarse arriba
  t = t.replace(/([,.])\s*([,.])+/g, '$1');
  t = t.replace(/,\s*\./g, '.');

  return t.trim();
}

async function synthesizeSpeech(text) {
  const normalized = normalizeTTSText(text);
  if (!normalized) return null;

  try {
    const resp = await fetch(`${TTS_URL}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: normalized, language: 'es' })
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.error('❌ ttsHelper:', e.message);
    return null;
  }
}

async function synthesizeSpeechWithMetrics(text) {
  const normalized = normalizeTTSText(text);
  if (!normalized) return { buf: null, synthMs: null };

  const t0 = Date.now();
  try {
    const resp = await fetch(`${TTS_URL}/synthesize`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text: normalized, language: 'es' })
    });
    if (!resp.ok) throw new Error(`TTS HTTP ${resp.status}`);
    const buf     = Buffer.from(await resp.arrayBuffer());
    const synthMs = Date.now() - t0;
    console.log(`🔊 [TTS ] Síntesis completada: ${synthMs}ms (${buf.length} bytes)`);
    return { buf, synthMs };
  } catch (e) {
    console.error('❌ ttsHelper:', e.message);
    return { buf: null, synthMs: null };
  }
}

module.exports = { synthesizeSpeech, synthesizeSpeechWithMetrics, normalizeTTSText };
