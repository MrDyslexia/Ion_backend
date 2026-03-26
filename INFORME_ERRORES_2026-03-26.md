# Informe de Errores — Sesión de Prueba ALMA
**Fecha:** 2026-03-26
**Sesión analizada:** a197e467-7717-4244-b95a-bef7b43414a0
**Paciente:** Paciente de Prueba (DEV-001)

---

## Resumen ejecutivo

Se identificaron **5 errores** en la sesión de prueba: 2 dentro del flujo del test 6CIT y 3 en el comportamiento general de conversación. Todos los errores fueron corregidos.

---

## Error 1 — Dirección descartada silenciosamente (race condition en TestRunner)

### Descripción
En la pregunta de memorización de dirección (Q3), el paciente solicitó repetir la pregunta ("repíteme la pregunta"). El sistema la repitió correctamente, pero al responder la dirección por primera vez, el STT fue descartado sin feedback. El paciente tuvo que decirla dos veces para que el sistema la aceptara.

### Evidencia en log
```
🔊 [Runner] "Le voy a decir una dirección para que la recuerde. Escuche con atenció"
⏱️  [STT ] "manuel rodríguez trece setenta y tres sa" → 241ms
🔇 [Runner] STT descartado (estado: IDLE): "manuel rodríguez trece setenta y tres sa"
⏱️  [STT ] "manuel rodríguez trece setenta y tres sa" → 226ms
🔊 [Runner] "Gracias. Por favor, intente recordar esa dirección."
```

### Causa raíz
`TestRunner.resolveSTT()` tiene una ventana de pre-armado de 1 segundo *tras* el fin del TTS. Sin embargo, cuando el paciente responde *durante* la reproducción del audio (antes de que `say()` termine), `_lastSayEnd` corresponde al TTS anterior y el fragmento cae fuera de la ventana → descartado con estado `IDLE`.

### Archivos afectados
- `src/engine/TestRunner.js`

### Corrección aplicada
Se añadió el flag `_sayActive` (booleano, `true` durante toda la ejecución de `say()`, con `try/finally` para garantizar su limpieza). La condición de buffering ahora cubre tanto la ventana post-TTS como el TTS activo:

```js
// Antes
if (this.state === STATE.IDLE && Date.now() - this._lastSayEnd < 1000)

// Después
if (this.state === STATE.IDLE && (this._sayActive || Date.now() - this._lastSayEnd < 1000))
```

---

## Error 2 — LLM afirma tener acceso a búsqueda en internet

### Descripción
El paciente preguntó si ALMA tenía acceso a internet. El LLM respondió afirmativamente ("Sí, puedo buscar información actualizada..."), luego más adelante se contradijo ("Lo siento, actualmente no tengo la capacidad de buscar información en tiempo real"). Esta incoherencia genera desconfianza.

### Evidencia en chat del asistente
```
"Claro, te proporcionaré información sobre cómo la situación del mercado internacional..."
"Sí, puedo buscar información actualizada sobre los precios del combustible en Chile..."
[más adelante]
"Lo siento, pero actualmente no tengo la capacidad de buscar información en tiempo real en Internet."
```

### Causa raíz
El system prompt no indicaba explícitamente la ausencia de capacidad de búsqueda web. El modelo (qwen2.5:7b) infirió incorrectamente que podía hacerlo, probablemente por el contexto conversacional sobre información y precios.

### Archivos afectados
- `src/server.js` → `buildSystemPrompt()`

### Corrección aplicada
Se añadió al system prompt:
```
NO tienes acceso a internet ni puedes buscar información en línea. Si el paciente pide
una búsqueda web o información en tiempo real, explícale brevemente que actualmente no
tienes esa capacidad, pero que se incorporará en el futuro.
```

---

## Error 3 — Saludo triple al inicio de sesión

### Descripción
Al iniciar la sesión con "hola alma", el asistente respondió con tres saludos consecutivos:
1. "¡Hola! ¿Cómo estás hoy?"
2. "¡Buenos días, Paciente de Prueba! ¿Cómo estás hoy?"
3. "¡Hola! ¿Cómo estás hoy? Estoy aquí para ayudarte."

### Evidencia en log
```
⏱️  [STT ] "hola" → 242ms
⏱️  [STT ] "hola alma" → 200ms
⏱️  [STT ] "hola alma" → 88ms
⏱️  [LLM ] primer token → 35228ms   ← primera llamada
⏱️  [LLM ] primer token → 7769ms    ← segunda llamada
⏱️  [LLM ] respuesta completa (23 chars) → 7913ms
⏱️  [LLM ] respuesta completa (50 chars) → 35549ms
```
```
▶ Activación: hola alma
▶ Activación: hola alma
```

### Causa raíz
Vosk procesó el wake word "hola alma" dos veces en rápida sucesión (~200ms y ~88ms), probablemente por el solapamiento entre resultado parcial y final del mismo audio. El primer "hola alma" activó `conversationActive = true` correctamente. El segundo "hola alma", al llegar con la conversación ya activa, no era detectado como activación y caía al branch `continue_conversation`, lo que añadía "hola alma" al dialog como mensaje de usuario y disparaba un segundo `askLLM`.

### Archivos afectados
- `src/server.js` → `processVoiceCommands()`

### Corrección aplicada
Si "hola alma" llega con `conversationActive = true`, se ignora silenciosamente (duplicado de activación). Si contiene texto adicional tras el wake word, solo ese texto se procesa como conversación normal:

```js
if (t.includes('hola alma') && ctx.conversationActive) {
  const rest = t.split('hola alma').pop()?.trim() || '';
  if (!rest) return { isCommand: false, action: null }; // ignorar duplicado
  ctx.userBuffer += (ctx.userBuffer ? ' ' : '') + rest;
  return { isCommand: false, action: 'continue_conversation' };
}
```

---

## Error 4 — `conduct_test` disparado por conversación no relacionada

### Descripción
El LLM llamó a la herramienta `conduct_test` cuando el paciente preguntó "que alguien me diga lo que dijo el ministro de economía sobre este fenómeno", iniciando la evaluación cognitiva sin que el paciente la hubiera aceptado.

### Evidencia en log
```
⏱️  [STT ] "que alguien me diga lo que dijo el minis" → 389ms
⏱️  [LLM ] primer token → 179ms
🔧 Tool: conduct_test { testId: 'sixcit' }
🔧 Result: Iniciando evaluación sixcit. El sistema tomará control del flujo de voz.
```

### Causa raíz
La descripción de la herramienta era demasiado genérica: *"cuando el paciente acepte realizar una evaluación"*. Tras la compresión de contexto, el LLM (qwen2.5:7b) asoció erróneamente la solicitud de información del paciente con un consentimiento implícito para el test.

### Archivos afectados
- `src/server.js` → `LLM_TOOLS`

### Corrección aplicada
La descripción del tool fue reescrita con restricciones explícitas:
```
Inicia la evaluación cognitiva 6CIT. Úsala ÚNICAMENTE cuando el paciente haya aceptado
EXPLÍCITAMENTE hacer una evaluación de memoria (ejemplo: "sí quiero", "de acuerdo",
"vamos"). NUNCA la uses en respuesta a preguntas sobre otros temas, búsquedas de
información, o conversación general.
```

---

## Error 5 — LLM confundido tras finalización del test

### Descripción
Inmediatamente después de completarse el test 6CIT, el paciente dijo "oh" y el LLM respondió:

> *"Lamento la confusión. Parece que hubo un malentendido. No tengo la capacidad de conducir una evaluación de memoria directamente, pero puedo buscar la información que necesitas sobre el ministro de economía."*

El LLM contradijo lo que el sistema acababa de realizar y además ofreció buscar en internet (capacidad inexistente).

### Evidencia en chat del asistente
```
"Lamento la confusión. Parece que hubo un malentendido. No tengo la capacidad de conducir
una evaluación de memoria directamente, pero puedo buscar la información que necesitas
sobre el ministro de economía.
¿Te gustaría que busque la declaración más reciente del ministro de economía sobre este tema?"
```

### Causa raíz
El filtro post-test elimina del dialog los mensajes de tool_call y tool_result, dejando la conversación con este salto sin explicación:
```
user:      "que alguien me diga lo que dijo el ministro de economía..."
assistant: "Hemos terminado la evaluación. Muchas gracias..."
user:      "oh"
```
El LLM interpreta el salto como un error en la conversación y trata de "corregirlo" negando que pueda hacer evaluaciones y ofreciendo buscar la información del ministro.

### Archivos afectados
- `src/server.js` → bloque post-test en `executeTool()`

### Corrección aplicada
Se inyecta un mensaje `system` justo después del filtro del dialog (y por tanto fuera de su alcance) para proveer contexto al LLM:

```js
ctx.dialog.push({
  role: 'system',
  content: 'La evaluación cognitiva 6CIT acaba de completarse con éxito. ' +
           'Retoma la conversación normal con el paciente sobre cualquier tema que él desee.'
});
```

El mismo mecanismo se aplica en caso de cancelación del test.

---

## Tabla resumen

| # | Componente | Tipo | Severidad | Estado |
|---|-----------|------|-----------|--------|
| 1 | `TestRunner.js` — race condition STT durante TTS | Bug funcional (test) | Alta | ✅ Corregido |
| 2 | `server.js` — system prompt sin restricción de internet | Comportamiento LLM | Media | ✅ Corregido |
| 3 | `server.js` — duplicate wake word dispara LLM dos veces | Bug funcional (UX) | Media | ✅ Corregido |
| 4 | `server.js` — `conduct_test` disparado fuera de contexto | Bug crítico (seguridad clínica) | Alta | ✅ Corregido |
| 5 | `server.js` — LLM sin contexto post-test genera respuesta incorrecta | Comportamiento LLM | Alta | ✅ Corregido |

---

## Archivos modificados

| Archivo | Cambios |
|---------|---------|
| `src/engine/TestRunner.js` | Flag `_sayActive` + condición de buffering ampliada |
| `src/server.js` | System prompt (internet), tool description (`conduct_test`), `processVoiceCommands` (dedup wake word), mensaje de contexto post-test |
