// ============================================================
// Project Eira — Memory Engine v4.0 (Free-Tier Edition)
// Uses TF-IDF keyword similarity instead of heavy ML embeddings.
// Zero external ML dependencies — runs on ANY free host.
// ============================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'memory.sqlite');
const db = new sqlite3.Database(dbPath);

// --- Constants ---
const MAX_MEMORIES_PER_SESSION = 200;
const SIMILARITY_THRESHOLD = 0.12;   // TF-IDF threshold (lower than cosine)
const DEDUP_THRESHOLD = 0.80;        // Dedup aggressiveness
const TOP_K_RESULTS = 5;

// ============================================================
// Database Initialization
// ============================================================

function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        importance INTEGER DEFAULT 5,
        emotionalWeight INTEGER DEFAULT 5,
        accessCount INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastUsed DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // Safe migrations (column already exists = ignored)
      const migrations = [
        `ALTER TABLE memories ADD COLUMN category TEXT DEFAULT 'general'`,
        `ALTER TABLE memories ADD COLUMN importance INTEGER DEFAULT 5`,
        `ALTER TABLE memories ADD COLUMN emotionalWeight INTEGER DEFAULT 5`,
        `ALTER TABLE memories ADD COLUMN accessCount INTEGER DEFAULT 0`,
        `ALTER TABLE memories ADD COLUMN createdAt DATETIME DEFAULT CURRENT_TIMESTAMP`,
        `ALTER TABLE memories ADD COLUMN lastUsed DATETIME`
      ];
      for (const sql of migrations) {
        db.run(sql, (err) => {
          if (err && !err.message.includes('duplicate column')) {
            console.error('[Memory] Migration warning:', err.message);
          }
        });
      }

      db.run(`CREATE INDEX IF NOT EXISTS idx_session ON memories(sessionId)`);
      db.run(`CREATE INDEX IF NOT EXISTS idx_category ON memories(sessionId, category)`);

      // Drop old vector column from document_chunks if it exists (safe migration)
      db.run(`CREATE TABLE IF NOT EXISTS document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        documentName TEXT,
        chunkText TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
        sessionId TEXT PRIMARY KEY,
        name TEXT,
        age INTEGER,
        language TEXT DEFAULT 'hinglish',
        interests TEXT DEFAULT '[]',
        lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
      )`, (err) => {
        if (err) reject(err);
        else {
          console.log('[Memory] ✅ Database initialized (Lightweight TF-IDF mode)');
          resolve();
        }
      });
    });
  });
}

initDatabase().catch(err => console.error('[Memory] DB init error:', err));


// ============================================================
// TF-IDF Similarity Engine (No external dependencies)
// ============================================================

// Tokenize text into meaningful words (removes stopwords)
const STOP_WORDS = new Set([
  'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'that', 'this', 'these', 'those', 'what',
  'how', 'when', 'where', 'who', 'which', 'so', 'just', 'very', 'much',
  'also', 'like', 'get', 'got', 'about', 'up', 'out', 'if', 'than', 'then',
  'hai', 'hain', 'ka', 'ki', 'ke', 'ko', 'ne', 'se', 'mein', 'bhi', 'aur',
  'toh', 'nahi', 'main', 'tu', 'aap', 'kya', 'jo', 'ye', 'wo', 'kuch'
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')  // keep hindi chars too
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// Build TF (term frequency) map for a text
function buildTF(text) {
  const tokens = tokenize(text);
  const tf = new Map();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) || 0) + 1);
  }
  // Normalize by doc length
  for (const [k, v] of tf) {
    tf.set(k, v / tokens.length);
  }
  return tf;
}

// Compute cosine-like similarity between two TF maps
function tfidfSimilarity(tf1, tf2) {
  if (tf1.size === 0 || tf2.size === 0) return 0;
  
  let dot = 0, norm1 = 0, norm2 = 0;
  for (const [term, val] of tf1) {
    norm1 += val * val;
    if (tf2.has(term)) {
      dot += val * tf2.get(term);
    }
  }
  for (const [, val] of tf2) {
    norm2 += val * val;
  }
  if (norm1 === 0 || norm2 === 0) return 0;
  return dot / (Math.sqrt(norm1) * Math.sqrt(norm2));
}

// Check if two facts are duplicates
function isTextDuplicate(fact1, fact2) {
  const tf1 = buildTF(fact1);
  const tf2 = buildTF(fact2);
  return tfidfSimilarity(tf1, tf2) >= DEDUP_THRESHOLD;
}


// ============================================================
// Memory De-duplication Check
// ============================================================

async function isDuplicate(sessionId, newFact) {
  return new Promise((resolve) => {
    db.all(
      `SELECT fact FROM memories WHERE sessionId = ? ORDER BY id DESC LIMIT 50`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) { resolve(false); return; }
        for (const row of rows) {
          if (isTextDuplicate(newFact, row.fact)) {
            console.log(`[Memory] Duplicate detected: "${newFact}"`);
            resolve(true);
            return;
          }
        }
        resolve(false);
      }
    );
  });
}


// ============================================================
// Save Memory
// ============================================================

async function saveMemory(sessionId, fact, category = 'general', importance = 5, emotionalWeight = 5) {
  const dupe = await isDuplicate(sessionId, fact);
  if (dupe) return false;

  await enforceMemoryCap(sessionId);

  return new Promise((resolve) => {
    db.run(
      `INSERT INTO memories (sessionId, fact, category, importance, emotionalWeight) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, fact, category, importance, emotionalWeight],
      function(err) {
        if (err) {
          console.error('[Memory] Save error:', err.message);
          resolve(false);
        } else {
          console.log(`[Memory] ✅ Saved [${category}]: "${fact}"`);
          resolve(true);
        }
      }
    );
  });
}


// ============================================================
// Enforce Memory Cap
// ============================================================

function enforceMemoryCap(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count FROM memories WHERE sessionId = ?`,
      [sessionId],
      (err, row) => {
        if (err || !row || row.count < MAX_MEMORIES_PER_SESSION) { resolve(); return; }
        const excess = row.count - MAX_MEMORIES_PER_SESSION + 10;
        db.run(
          `DELETE FROM memories WHERE id IN (
            SELECT id FROM memories WHERE sessionId = ?
            ORDER BY importance ASC, accessCount ASC, timestamp ASC
            LIMIT ?
          )`,
          [sessionId, excess],
          () => resolve()
        );
      }
    );
  });
}


// ============================================================
// Fetch Relevant Memories (TF-IDF ranked)
// ============================================================

async function fetchRelevantMemories(sessionId, queryText) {
  const queryTF = buildTF(queryText);

  return new Promise((resolve) => {
    db.all(
      `SELECT id, fact, category, importance, emotionalWeight, createdAt FROM memories 
       WHERE sessionId = ? 
       ORDER BY timestamp DESC 
       LIMIT 100`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) { resolve([]); return; }

        const scored = [];
        const identityFacts = [];
        const nowMs = Date.now();

        for (const row of rows) {
          const factTF = buildTF(row.fact);
          const similarity = tfidfSimilarity(queryTF, factTF);

          const ageMs = nowMs - new Date(row.createdAt || Date.now()).getTime();
          const recencyScore = Math.max(0, 1 - (ageMs / (30 * 24 * 60 * 60 * 1000)));
          const metaScore = ((row.importance || 5) * 0.5) + ((row.emotionalWeight || 5) * 0.3) + (recencyScore * 0.2);

          if (row.category === 'identity' && (row.importance || 5) >= 8) {
            identityFacts.push({ id: row.id, fact: row.fact, category: row.category });
          } else if (similarity > SIMILARITY_THRESHOLD) {
            scored.push({ id: row.id, fact: row.fact, category: row.category, score: (similarity * 5) + metaScore });
          }
        }

        scored.sort((a, b) => b.score - a.score);

        const combined = [];
        const seen = new Set();
        for (const m of identityFacts) {
          if (!seen.has(m.id)) { combined.push(m); seen.add(m.id); }
        }
        for (const m of scored) {
          if (combined.length >= TOP_K_RESULTS) break;
          if (!seen.has(m.id)) { combined.push(m); seen.add(m.id); }
        }

        for (const mem of combined) {
          db.run(
            `UPDATE memories SET accessCount = accessCount + 1, lastUsed = CURRENT_TIMESTAMP WHERE id = ?`,
            [mem.id]
          );
        }

        resolve(combined.map(m => `[${m.category}] ${m.fact}`));
      }
    );
  });
}


// ============================================================
// Fact Extraction (uses Groq API — already paid for)
// ============================================================

async function fetchWithTimeout(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function extractAndSaveFact(sessionId, userMessage) {
  try {
    const prompt = `You are a memory extractor for a chat companion app. Analyze the user's message and extract personal facts.

Rules:
- Extract ONLY concrete, specific facts (name, age, job, hobby, goal, relationship, preference, event).
- Do NOT extract opinions, questions, or greetings.
- Categorize each fact as one of: identity, preference, event, goal, relationship, habit, academic, work
- Rate importance 1-10: identity facts (name, age) = 10, preferences = 6, casual events = 3
- Rate emotionalWeight 1-10: emotionally charged statements = 9-10, neutral = 1-4

User message: "${userMessage.substring(0, 500)}"

If there are facts, respond in this EXACT format (one per line):
FACT|category|importance|emotionalWeight|Short statement starting with "User"
Example: FACT|identity|10|3|User's name is Rahul
Example: FACT|academic|7|8|User is stressed about preparing for JEE Mains

If there are NO extractable facts, respond with exactly: NO_FACT

Response:`;

    const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 200
      })
    }, 15000);

    const data = await response.json();
    const extraction = data.choices[0].message.content.trim();

    if (extraction === 'NO_FACT' || extraction.toLowerCase().includes('no_fact')) return;

    const lines = extraction.split('\n').filter(l => l.startsWith('FACT|'));
    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length >= 5) {
        const category = parts[1].trim().toLowerCase();
        const importance = Math.min(10, Math.max(1, parseInt(parts[2]) || 5));
        const emotionalWeight = Math.min(10, Math.max(1, parseInt(parts[3]) || 5));
        const fact = parts[4].trim();

        if (fact.length > 5 && fact.length < 200) {
          await saveMemory(sessionId, fact, category, importance, emotionalWeight);
          if (category === 'identity') await updateUserProfile(sessionId, fact);
        }
      }
    }
  } catch (err) {
    console.log('[Memory] Background extraction failed:', err.message);
  }
}


// ============================================================
// User Profile Management
// ============================================================

async function updateUserProfile(sessionId, fact) {
  const factLower = fact.toLowerCase();
  try {
    await new Promise((resolve) => {
      db.run(`INSERT OR IGNORE INTO user_profiles (sessionId) VALUES (?)`, [sessionId], () => resolve());
    });

    const nameMatch = factLower.match(/(?:name is|called|naam)\s+(\w+)/i);
    const ageMatch = factLower.match(/(?:is|age|saal)\s+(\d{1,3})\s*(?:years?|saal|yr)?/i);

    if (nameMatch) {
      const name = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
      db.run(`UPDATE user_profiles SET name = ?, lastUpdated = CURRENT_TIMESTAMP WHERE sessionId = ?`, [name, sessionId]);
    }
    if (ageMatch) {
      const age = parseInt(ageMatch[1]);
      if (age > 5 && age < 100) {
        db.run(`UPDATE user_profiles SET age = ?, lastUpdated = CURRENT_TIMESTAMP WHERE sessionId = ?`, [age, sessionId]);
      }
    }
  } catch (err) {
    console.error('[Profile] Update error:', err.message);
  }
}

function getUserProfile(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM user_profiles WHERE sessionId = ?`,
      [sessionId],
      (err, row) => {
        if (err || !row) resolve({ age: null, name: null, language: 'hinglish', interests: [] });
        else resolve({
          age: row.age,
          name: row.name,
          language: row.language || 'hinglish',
          interests: row.interests ? JSON.parse(row.interests) : []
        });
      }
    );
  });
}


// ============================================================
// Memory Stats
// ============================================================

function getMemoryStats(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as totalFacts, COUNT(DISTINCT category) as categories, MAX(timestamp) as lastFact
       FROM memories WHERE sessionId = ?`,
      [sessionId],
      (err, row) => resolve(err ? {} : row)
    );
  });
}


// ============================================================
// RAG — "Chat with your Textbook" (TF-IDF powered)
// ============================================================

async function saveDocumentChunk(sessionId, documentName, chunkText) {
  return new Promise((resolve) => {
    db.run(
      `INSERT INTO document_chunks (sessionId, documentName, chunkText) VALUES (?, ?, ?)`,
      [sessionId, documentName, chunkText],
      (err) => {
        if (err) console.error('[Memory] RAG Save Error:', err.message);
        resolve(!err);
      }
    );
  });
}

async function searchDocumentChunks(sessionId, queryText, topK = 3) {
  const queryTF = buildTF(queryText);

  return new Promise((resolve) => {
    db.all(
      `SELECT documentName, chunkText FROM document_chunks WHERE sessionId = ?`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) { resolve([]); return; }

        const scored = rows
          .map(row => ({
            document: row.documentName,
            text: row.chunkText,
            score: tfidfSimilarity(queryTF, buildTF(row.chunkText))
          }))
          .filter(r => r.score > 0.08)
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);

        resolve(scored.map(s => `[From Document: ${s.document}]: ${s.text}`));
      }
    );
  });
}

// Stub: kept for API compatibility (server.js calls this)
async function getEmbedding(text) {
  return null; // No longer used — TF-IDF handles similarity
}


// ============================================================
// Exports
// ============================================================

module.exports = {
  saveMemory,
  fetchRelevantMemories,
  extractAndSaveFact,
  getUserProfile,
  updateUserProfile,
  getMemoryStats,
  getEmbedding,
  saveDocumentChunk,
  searchDocumentChunks
};
