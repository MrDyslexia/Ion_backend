/**
 * db.js — SQLite via sql.js (WebAssembly, sin bindings nativos)
 * npm install sql.js
 */
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');
const { randomUUID } = require('crypto');

const DB_DIR  = path.join(__dirname, '../data');
const DB_PATH = path.join(DB_DIR, 'alma.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

/** ======================= Init async ======================= */
let db = null;

async function initDB() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA foreign_keys = ON;`);

  db.run(`
    CREATE TABLE IF NOT EXISTS patients (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      age            INTEGER,
      clinical_notes TEXT DEFAULT '',
      created_at     INTEGER DEFAULT (strftime('%s','now')),
      updated_at     INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id                  TEXT PRIMARY KEY,
      patient_id          TEXT NOT NULL REFERENCES patients(id),
      socket_id           TEXT,
      started_at          INTEGER DEFAULT (strftime('%s','now')),
      ended_at            INTEGER,
      evaluation_complete INTEGER DEFAULT 0,
      summary             TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      tool_calls TEXT DEFAULT NULL,
      created_at INTEGER DEFAULT (strftime('%s','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_patient ON sessions(patient_id);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);

  persist();
  console.log('✅ SQLite (sql.js) listo:', DB_PATH);
  return db;
}

/** Persiste el DB en disco después de cada escritura */
function persist() {
  if (!db) return;
  try {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
  } catch (e) {
    console.error('❌ Error persistiendo DB:', e.message);
  }
}

/** Helper: ejecuta y persiste */
function run(sql, params = []) {
  db.run(sql, params);
  persist();
}

/** Helper: devuelve array de filas como objetos */
function all(sql, params = []) {
  const stmt    = db.prepare(sql);
  const rows    = [];
  stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** Helper: devuelve primera fila o null */
function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

/** ======================= Patients ======================= */
const patientOps = {
  create(id, name, age, clinicalNotes = '') {
    run(`INSERT INTO patients (id, name, age, clinical_notes) VALUES (?,?,?,?)`,
      [id, name, age ?? null, clinicalNotes]);
  },
  getById(id)  { return get(`SELECT * FROM patients WHERE id = ?`, [id]); },
  getAll()     { return all(`SELECT * FROM patients ORDER BY created_at DESC`); },
  update(id, fields) {
    const allowed = ['name','age','clinical_notes'];
    const keys    = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    const sets  = keys.map(k => `${k} = ?`).join(', ');
    const vals  = keys.map(k => fields[k]);
    run(`UPDATE patients SET ${sets}, updated_at = strftime('%s','now') WHERE id = ?`, [...vals, id]);
  },
  delete(id) { run(`DELETE FROM patients WHERE id = ?`, [id]); }
};

/** ======================= Sessions ======================= */
const sessionOps = {
  create(patientId, socketId) {
    const id = randomUUID();
    run(`INSERT INTO sessions (id, patient_id, socket_id) VALUES (?,?,?)`, [id, patientId, socketId]);
    return id;
  },
  getById(id)              { return get(`SELECT * FROM sessions WHERE id = ?`, [id]); },
  getLatestForPatient(pid) {
    return get(`SELECT * FROM sessions WHERE patient_id = ? ORDER BY started_at DESC LIMIT 1`, [pid]);
  },
  getAllForPatient(pid)  { return all(`SELECT * FROM sessions WHERE patient_id = ? ORDER BY started_at DESC`, [pid]); },
  updateSocket(id, sid) { run(`UPDATE sessions SET socket_id = ? WHERE id = ?`, [sid, id]); },
  end(id, evalComplete = false) {
    run(`UPDATE sessions SET ended_at = strftime('%s','now'), evaluation_complete = ? WHERE id = ?`,
      [evalComplete ? 1 : 0, id]);
  },
  saveSummary(id, summary) { run(`UPDATE sessions SET summary = ? WHERE id = ?`, [summary, id]); }
};

/** ======================= Messages ======================= */
const messageOps = {
  add(sessionId, role, content, toolCalls = null) {
    run(`INSERT INTO messages (session_id, role, content, tool_calls) VALUES (?,?,?,?)`,
      [sessionId, role, content, toolCalls ? JSON.stringify(toolCalls) : null]);
  },
  getForSession(sessionId) {
    return all(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC`, [sessionId])
      .map(m => ({ ...m, tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null }));
  },
  getLastN(sessionId, n = 10) {
    return all(`
      SELECT * FROM (
        SELECT * FROM messages WHERE session_id = ? AND role != 'system'
        ORDER BY created_at DESC, id DESC LIMIT ?
      ) ORDER BY created_at ASC, id ASC`, [sessionId, n])
      .map(m => ({ ...m, tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null }));
  },
  countForSession(sessionId) {
    const r = get(`SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role != 'system'`, [sessionId]);
    return r?.c ?? 0;
  }
};

/** ======================= buildDialog ======================= */
const RECENT_MESSAGES    = 10;
const COMPRESS_THRESHOLD = 20;

function buildDialog(systemPrompt, session) {
  const total = session ? messageOps.countForSession(session.id) : 0;
  let dialog  = [{ role: 'system', content: systemPrompt }];

  if (session?.summary) {
    dialog.push({ role: 'system', content: `[Resumen de conversación anterior]: ${session.summary}` });
  }

  if (!session) return { dialog, needsCompression: false };

  const msgs = total > COMPRESS_THRESHOLD
    ? messageOps.getLastN(session.id, RECENT_MESSAGES)
    : messageOps.getForSession(session.id).filter(m => m.role !== 'system');

  dialog = [...dialog, ...msgs.map(m => ({ role: m.role, content: m.content }))];
  return { dialog, needsCompression: total > COMPRESS_THRESHOLD };
}

module.exports = { initDB, patientOps, sessionOps, messageOps, buildDialog, COMPRESS_THRESHOLD, RECENT_MESSAGES };
