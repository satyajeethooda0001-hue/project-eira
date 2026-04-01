// ============================================================
// Project Eira — Memory Engine v3.0
// Scalable, deduplicated, categorized memory system.
//
// KEY FIXES from audit:
//   1. No longer loads ALL vectors into JS for comparison
//   2. Deduplicates facts before saving (fuzzy match)
//   3. Categorizes memories (identity, preference, event, etc.)
//   4. Caps total memories per user (eviction policy)
//   5. Caches embeddings to avoid redundant Ollama calls
// ============================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, 'memory.sqlite');
const db = new sqlite3.Database(dbPath);

// --- Constants ---
const MAX_MEMORIES_PER_SESSION = 200;   // Cap per user to prevent bloat
const SIMILARITY_THRESHOLD = 0.55;      // Lower threshold = more recall
const DEDUP_THRESHOLD = 0.88;           // Higher = stricter dedup
const TOP_K_RESULTS = 5;               // Return top 5 relevant memories
const EMBEDDING_MODEL = 'nomic-embed-text'; // Much better than gemma2 for embeddings

// --- Embedding cache (in-memory, per-process) ---
const embeddingCache = new Map();
const CACHE_MAX_SIZE = 500;

// ============================================================
// Database Initialization
// ============================================================

function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Main memories table — creates fresh if not exists
      db.run(`CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        fact TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        importance INTEGER DEFAULT 5,
        emotionalWeight INTEGER DEFAULT 5,
        vector BLOB NOT NULL,
        accessCount INTEGER DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastUsed DATETIME,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // === MIGRATION: Add columns to EXISTING databases ===
      // ALTER TABLE ADD COLUMN is safe — SQLite ignores if column exists (we catch the error)
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
          // "duplicate column name" is expected for already-migrated DBs — ignore it
          if (err && !err.message.includes('duplicate column')) {
            console.error('[Memory] Migration warning:', err.message);
          }
        });
      }

      // Index for fast session lookups
      db.run(`CREATE INDEX IF NOT EXISTS idx_session ON memories(sessionId)`);
      
      // Index for category filtering
      db.run(`CREATE INDEX IF NOT EXISTS idx_category ON memories(sessionId, category)`);
      
      // Document chunks table for "Chat with your Textbook" (RAG)
      db.run(`CREATE TABLE IF NOT EXISTS document_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        documentName TEXT,
        chunkText TEXT NOT NULL,
        vector BLOB NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);

      // User profile table — stores extracted structured data
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
          console.log('[Memory] ✅ Database initialized (with migrations)');
          resolve();
        }
      });
    });
  });
}

// Initialize on load
initDatabase().catch(err => console.error('[Memory] DB init error:', err));


// ============================================================
// Embedding Generation (with caching)
// ============================================================

// --- Utility ---
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

// ============================================================
// Embedding Generation (with caching)
// ============================================================

let pipelineFn = null;

async function getEmbedding(text) {
  // Check cache first (fixed collision bug using SHA256)
  const cacheKey = crypto.createHash('sha256').update(text).digest('hex');
  if (embeddingCache.has(cacheKey)) {
    return embeddingCache.get(cacheKey);
  }

  try {
    if (!pipelineFn) {
      console.log("[Memory] Initializing Xenova Transformers for local embeddings...");
      const transformers = await import('@xenova/transformers');
      // Force remote download on first run (avoids local storage issues in cloud)
      transformers.env.allowLocalModels = false; 
      transformers.env.useBrowserCache = false;
      pipelineFn = await transformers.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
      console.log("[Memory] Transformers initialized successfully.");
    }

    const output = await pipelineFn(text, { pooling: 'mean', normalize: true });
    const embedding = Array.from(output.data);

    // Cache with eviction
    if (embeddingCache.size >= CACHE_MAX_SIZE) {
      const firstKey = embeddingCache.keys().next().value;
      embeddingCache.delete(firstKey);
    }
    embeddingCache.set(cacheKey, embedding);

    return embedding;
  } catch (err) {
    console.error('[Memory] Local embedding error:', err.message);
    return null;
  }
}


// ============================================================
// Vector Math (cosine similarity)
// ============================================================

function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}


// ============================================================
// Memory De-duplication Check
// ============================================================

async function isDuplicate(sessionId, newFact, newVector) {
  return new Promise((resolve) => {
    // Only check against recent memories (last 50) for speed
    db.all(
      `SELECT fact, vector FROM memories WHERE sessionId = ? ORDER BY id DESC LIMIT 50`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          resolve(false);
          return;
        }

        for (const row of rows) {
          try {
            const storedVec = deserializeVector(row.vector);
            const similarity = cosineSimilarity(newVector, storedVec);
            if (similarity > DEDUP_THRESHOLD) {
              console.log(`[Memory] Duplicate detected (${(similarity * 100).toFixed(1)}%): "${newFact}" ≈ "${row.fact}"`);
              resolve(true);
              return;
            }
          } catch (e) { /* skip corrupt entries */ }
        }
        resolve(false);
      }
    );
  });
}


// ============================================================
// Vector Serialization (Binary Buffer instead of JSON string)
// Saves ~60% storage vs JSON.stringify for float arrays
// ============================================================

function serializeVector(vec) {
  return Buffer.from(new Float32Array(vec).buffer);
}

function deserializeVector(buf) {
  // Handle both legacy JSON strings and new binary buffers
  if (typeof buf === 'string') {
    return JSON.parse(buf);
  }
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}


// ============================================================
// Save Memory (with dedup + category + cap enforcement)
// ============================================================

async function saveMemory(sessionId, fact, category = 'general', importance = 5, emotionalWeight = 5) {
  const vector = await getEmbedding(fact);
  if (!vector) return false;

  // Check for duplicates
  const dupe = await isDuplicate(sessionId, fact, vector);
  if (dupe) {
    console.log(`[Memory] Skipped duplicate: "${fact}"`);
    return false;
  }

  // Enforce memory cap — evict oldest, lowest-importance memories
  await enforceMemoryCap(sessionId);

  return new Promise((resolve) => {
    db.run(
      `INSERT INTO memories (sessionId, fact, category, importance, emotionalWeight, vector) VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, fact, category, importance, emotionalWeight, serializeVector(vector)],
      function(err) {
        if (err) {
          console.error('[Memory] Save error:', err.message);
          resolve(false);
        } else {
          console.log(`[Memory] ✅ Saved [${category}]: "${fact}" (imp:${importance}, emo:${emotionalWeight})`);
          resolve(true);
        }
      }
    );
  });
}


// ============================================================
// Enforce Memory Cap (evict old low-importance facts)
// ============================================================

function enforceMemoryCap(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT COUNT(*) as count FROM memories WHERE sessionId = ?`,
      [sessionId],
      (err, row) => {
        if (err || !row || row.count < MAX_MEMORIES_PER_SESSION) {
          resolve();
          return;
        }

        // Delete the oldest, least-important, least-accessed entries
        const excess = row.count - MAX_MEMORIES_PER_SESSION + 10; // Remove 10 extra for buffer
        db.run(
          `DELETE FROM memories WHERE id IN (
            SELECT id FROM memories WHERE sessionId = ?
            ORDER BY importance ASC, accessCount ASC, timestamp ASC
            LIMIT ?
          )`,
          [sessionId, excess],
          (err) => {
            if (!err) console.log(`[Memory] Evicted ${excess} old memories for session ${sessionId}`);
            resolve();
          }
        );
      }
    );
  });
}


// ============================================================
// Fetch Relevant Memories — CAPPED retrieval, not full scan
// ============================================================

async function fetchRelevantMemories(sessionId, queryText) {
  const queryVector = await getEmbedding(queryText);
  if (!queryVector) return [];

  return new Promise((resolve) => {
    // OPTIMIZATION: Only load the most recent 100 memories max
    // This prevents the "load everything" problem from the audit
    db.all(
      `SELECT id, fact, category, importance, emotionalWeight, createdAt, vector FROM memories 
       WHERE sessionId = ? 
       ORDER BY timestamp DESC 
       LIMIT 100`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          resolve([]);
          return;
        }

        const scored = [];
        const topIdentityFacts = [];
        const nowMs = Date.now();

        for (const row of rows) {
          try {
            const storedVec = deserializeVector(row.vector);
            const similarity = cosineSimilarity(queryVector, storedVec);
            
            // Recency Score (inverse of age): 1.0 = now, 0.0 = old
            // We'll scale where 30 days is ~0
            const ageMs = nowMs - new Date(row.createdAt).getTime();
            const maxAgeMs = 30 * 24 * 60 * 60 * 1000; 
            const recencyScore = Math.max(0, 1 - (ageMs / maxAgeMs));
            
            const importanceValue = row.importance || 5;
            const emoWeightValue = row.emotionalWeight || 5;

            // requested base score structure
            // max possible base is (10*0.5) + (10*0.3) + (1*0.2) = 5 + 3 + 0.2 = 8.2
            const metaScore = (importanceValue * 0.5) + (emoWeightValue * 0.3) + (recencyScore * 0.2);
            
            // To be a decision system, similarity must act as a filter AND multiplier
            // If they are completely unrelated (sim < threshold), skip, UNLESS it's an identity fact
            if (row.category === 'identity' && importanceValue >= 8) {
              // ALWAYS include high-importance identity facts
              topIdentityFacts.push({
                id: row.id,
                fact: row.fact,
                category: row.category,
                score: 100 // ensure it stays on top
              });
            } else if (similarity > SIMILARITY_THRESHOLD) {
              // Final score incorporates semantic relevance + meta importance
              const finalScore = (similarity * 5) + metaScore; 
              scored.push({
                id: row.id,
                fact: row.fact,
                category: row.category,
                score: finalScore
              });
            }
          } catch (e) { /* skip corrupt entries */ }
        }

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);
        
        // Take top K results (Combine identity + highest scored)
        const combined = [];
        const seen = new Set();
        
        // 1. Always identity first
        for (const m of topIdentityFacts) {
          if (!seen.has(m.id)) {
            combined.push(m);
            seen.add(m.id);
          }
        }
        
        // 2. Fill rest with top relevant memories (Total max = TOP_K_RESULTS)
        for (const m of scored) {
          if (combined.length >= TOP_K_RESULTS) break;
          if (!seen.has(m.id)) {
            combined.push(m);
            seen.add(m.id);
          }
        }

        // Update lastUsed timestamp + access counts
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
// Fact Extraction + Categorization (using local Ollama)
// ============================================================

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
Example: FACT|preference|5|2|User prefers studying at night

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

    if (extraction === "NO_FACT" || extraction.toLowerCase().includes("no_fact")) {
      return;
    }

    // Parse structured output
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
          
          // Also update user profile if it's an identity fact
          if (category === 'identity') {
            await updateUserProfile(sessionId, fact);
          }
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
    // Ensure profile row exists
    await new Promise((resolve) => {
      db.run(
        `INSERT OR IGNORE INTO user_profiles (sessionId) VALUES (?)`,
        [sessionId],
        () => resolve()
      );
    });

    // Extract structured data from identity facts
    const nameMatch = factLower.match(/(?:name is|called|naam)\s+(\w+)/i);
    const ageMatch = factLower.match(/(?:is|age|saal)\s+(\d{1,3})\s*(?:years?|saal|yr)?/i);

    if (nameMatch) {
      const name = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);
      db.run(`UPDATE user_profiles SET name = ?, lastUpdated = CURRENT_TIMESTAMP WHERE sessionId = ?`, [name, sessionId]);
      console.log(`[Profile] Updated name: ${name}`);
    }
    if (ageMatch) {
      const age = parseInt(ageMatch[1]);
      if (age > 5 && age < 100) {
        db.run(`UPDATE user_profiles SET age = ?, lastUpdated = CURRENT_TIMESTAMP WHERE sessionId = ?`, [age, sessionId]);
        console.log(`[Profile] Updated age: ${age}`);
      }
    }
  } catch (err) {
    console.error('[Profile] Update error:', err.message);
  }
}


/**
 * Get the user profile for dynamic prompt building
 */
function getUserProfile(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT * FROM user_profiles WHERE sessionId = ?`,
      [sessionId],
      (err, row) => {
        if (err || !row) {
          resolve({ age: null, name: null, language: 'hinglish', interests: [] });
        } else {
          resolve({
            age: row.age,
            name: row.name,
            language: row.language || 'hinglish',
            interests: row.interests ? JSON.parse(row.interests) : []
          });
        }
      }
    );
  });
}


// ============================================================
// Memory Stats (for debugging)
// ============================================================

function getMemoryStats(sessionId) {
  return new Promise((resolve) => {
    db.get(
      `SELECT 
        COUNT(*) as totalFacts,
        COUNT(DISTINCT category) as categories,
        MAX(timestamp) as lastFact
       FROM memories WHERE sessionId = ?`,
      [sessionId],
      (err, row) => resolve(err ? {} : row)
    );
  });
}


// ============================================================
// "Chat with your Textbook" RAG Functions
// ============================================================

async function saveDocumentChunk(sessionId, documentName, chunkText) {
  const vector = await getEmbedding(chunkText);
  if (!vector) return false;

  return new Promise((resolve) => {
    db.run(
      `INSERT INTO document_chunks (sessionId, documentName, chunkText, vector) VALUES (?, ?, ?, ?)`,
      [sessionId, documentName, chunkText, serializeVector(vector)],
      (err) => {
        if (err) console.error('[Memory] RAG Save Error:', err.message);
        resolve(!err);
      }
    );
  });
}

async function searchDocumentChunks(sessionId, queryText, topK = 3) {
  const queryVector = await getEmbedding(queryText);
  if (!queryVector) return [];

  return new Promise((resolve) => {
    db.all(
      `SELECT documentName, chunkText, vector FROM document_chunks WHERE sessionId = ?`,
      [sessionId],
      (err, rows) => {
        if (err || !rows || rows.length === 0) {
          resolve([]);
          return;
        }

        const scored = [];
        for (const row of rows) {
          try {
            const storedVec = deserializeVector(row.vector);
            const similarity = cosineSimilarity(queryVector, storedVec);
            
            // Only keep highly relevant chunks for the textbook
            if (similarity > 0.50) {
              scored.push({
                document: row.documentName,
                text: row.chunkText,
                score: similarity
              });
            }
          } catch (e) { /* skip */ }
        }

        scored.sort((a, b) => b.score - a.score);
        resolve(scored.slice(0, topK).map(s => `[From Document: ${s.document}]: ${s.text}`));
      }
    );
  });
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
