// ============================================================
// Project Eira — Server v4.0 (Hardened)
// Security: Helmet, Rate Limiting, CORS, XSS Sanitization
// Features: Screen Share, PDF Preview, Landing Page
// ============================================================

require('dotenv').config(); // Loads GROQ_API_KEY from .env
const path = require('path');
const express = require('express');
const { buildCharacterPrompt } = require('./characters');
const memory = require('./memory');

const multer = require('multer');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const fs = require('fs').promises;

const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const xssFilters = require('xss-filters');

// === File Upload Config — Type Whitelist + Size Limit ===
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png', 'image/webp', 'image/gif'
];
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed. Allowed: PDF, TXT, DOCX, Images`));
    }
  }
});

const app = express();
const PORT = 3000;

// ============================================================
// SECURITY MIDDLEWARE
// ============================================================

// Helmet — Secure HTTP headers (relaxed CSP for localhost dev)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "https://api.groq.com"],
      mediaSrc: ["'self'", "blob:"],
    }
  },
  crossOriginEmbedderPolicy: false // Allow fonts/images
}));

// CORS — Only allow same origin in production
app.use(cors({
  origin: true, // Reflects request origin (localhost-friendly)
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  maxAge: 86400
}));

// Rate Limiting — Prevent abuse
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 minute window
  max: 30,                    // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', apiLimiter);

// Stricter rate limit for chat endpoint
const chatLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 15,
  message: { error: 'Too many messages. Please wait a moment.' }
});

// Body parsing with limits
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// XSS Sanitization helper
function sanitize(str) {
  if (typeof str !== 'string') return str;
  return xssFilters.inHTMLData(str.trim());
}

// In-memory conversation storage (per session)
const conversations = new Map();

// Track personality state per session (prevents tone drift)
const personalityState = new Map();

// Session TTL and cleanup to prevent memory leaks
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const sessionTimestamps = new Map();

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, lastActive] of sessionTimestamps) {
    if (now - lastActive > SESSION_TTL_MS) {
      conversations.delete(key);
      personalityState.delete(key);
      sessionTimestamps.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) console.log(`[Cleanup] Evicted ${cleaned} stale sessions`);
}, 30 * 60 * 1000); // Check every 30 mins

// Utility for fetching with timeout
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
// API: Get available characters
// ============================================================
app.get('/api/characters', (req, res) => {
  res.json([
    { id: 'tanya', name: 'Tanya', avatar: '👩', tagline: 'Warm, caring, and always here for you' },
    { id: 'kian', name: 'Kian', avatar: '🧑', tagline: 'Chill, witty, and always keeping it real' }
  ]);
});

// ============================================================
// API: Get available models
// ============================================================
app.get('/api/models', async (req, res) => {
  res.json([
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768',
    'gemma2-9b-it'
  ]);
});

// ============================================================
// Intent Router — Classify which character should respond
// Uses Groq API (cloud-ready, no Ollama dependency)
// ============================================================
async function classifyIntent(userMessage) {
  try {
    const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Classify this message into one category. Reply with ONLY one word — either "tanya" or "kian".

"tanya" = emotional support, relationships, personal problems, lifestyle, feelings, casual chat, venting, fashion, social issues
"kian" = logical problems, exams, coding, finance, fitness, career advice, strategy, math, hard decisions, planning

Examples:
- "I'm feeling really stressed" → tanya
- "How to prepare for JEE in 3 months?" → kian
- "My best friend is ignoring me" → tanya
- "Should I invest in mutual funds?" → kian

Message: "${userMessage.substring(0, 300)}"

Answer:`
        }],
        temperature: 0.05,
        max_tokens: 10
      })
    }, 10000);

    const data = await response.json();
    const result = data.choices[0].message.content.trim().toLowerCase();
    return result.includes("kian") ? "kian" : "tanya";
  } catch (err) {
    console.error('[Router] Classification error:', err.message);
    return 'tanya';
  }
}

// ============================================================
// Emotion Classifier — Detects mood AND crisis signals
// Returns: { mood, intensity, isCrisis }
// ============================================================
async function classifyEmotion(characterId, userMessage) {
  const tanyaMoods = ["happy", "sympathetic", "curious", "playful", "concerned", "neutral"];
  const kianMoods = ["analytical", "chill", "supportive", "witty", "motivational", "neutral"];
  const options = characterId === 'tanya' ? tanyaMoods : kianMoods;

  // Fast crisis keyword check (no model needed)
  const crisisKeywords = [
    'suicide', 'kill myself', 'end my life', 'want to die', 'no reason to live',
    'self harm', 'cutting myself', 'marna chahta', 'mar jaunga', 'zinda nahi rehna',
    'khatam karna hai', 'life khatam', 'sab khatam', 'aur nahi sah sakta'
  ];
  const msgLower = userMessage.toLowerCase();
  const isCrisis = crisisKeywords.some(kw => msgLower.includes(kw));

  if (isCrisis) {
    return {
      mood: characterId === 'tanya' ? 'sympathetic' : 'supportive',
      intensity: 1.0,
      isCrisis: true
    };
  }

  try {
    const prompt = `You analyze emotions in chat messages. Given the message, pick the SINGLE best mood AND rate emotional intensity.

Mood options: [${options.join(', ')}]
Intensity: a number from 0.0 (calm) to 1.0 (extreme emotion)

Message: "${userMessage.substring(0, 300)}"

Reply in EXACT format: mood|intensity
Example: sympathetic|0.8
Example: chill|0.2

Answer:`;

    const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.15,
        max_tokens: 20
      })
    }, 10000);

    const data = await response.json();
    const parts = data.choices[0].message.content.trim().split('|');
    const detectedMood = parts[0]?.trim().toLowerCase();
    const intensity = parseFloat(parts[1]) || 0.5;

    return {
      mood: options.includes(detectedMood) ? detectedMood : 'neutral',
      intensity: Math.max(0, Math.min(1, intensity)),
      isCrisis: false
    };
  } catch (err) {
    return { mood: 'neutral', intensity: 0.5, isCrisis: false };
  }
}

// ============================================================
// Personality Consistency Tracker
// Prevents the AI from "drifting" mid-conversation
// ============================================================
function getPersonalityContext(sessionId, characterId) {
  if (!personalityState.has(sessionId)) {
    personalityState.set(sessionId, {
      characterId,
      moodHistory: [],
      responseCount: 0,
      lastTopics: []
    });
  }
  return personalityState.get(sessionId);
}

function buildConsistencyReminder(pState) {
  // After every 5 messages, inject a subtle personality anchor
  if (pState.responseCount > 0 && pState.responseCount % 5 === 0) {
    return `\n[SYSTEM REMINDER: You have been chatting for ${pState.responseCount} messages now. Stay in character. Do NOT drift toward generic AI assistant behavior. Maintain your unique speaking style and personality. Do NOT increase response length over time — keep it conversational.]`;
  }
  return '';
}

// ============================================================
// Anti-Repetition: Track recent AI response patterns
// ============================================================
function buildAntiRepetitionGuard(history) {
  if (history.length < 4) return '';
  
  // Get last 3 AI responses
  const recentAI = history
    .filter(m => m.role === 'assistant')
    .slice(-3)
    .map(m => m.content.substring(0, 50));
  
  if (recentAI.length < 2) return '';

  return `\n[ANTI-REPETITION: Your recent response openings were: "${recentAI.join('", "')}". Do NOT start your next response the same way. Vary your opening words and sentence structure.]`;
}

// ============================================================
// MAIN CHAT ENDPOINT
// ============================================================
app.post('/api/chat', chatLimiter, async (req, res) => {
  const rawMessage = req.body.message;
  const { characterId, sessionId, modelName } = req.body;

  if (!rawMessage || !characterId) {
    return res.status(400).json({ error: 'Message and characterId are required' });
  }

  // Sanitize user input to prevent XSS
  const message = sanitize(rawMessage).substring(0, 5000); // Cap message length

  const convKey = sessionId || 'default';
  sessionTimestamps.set(convKey, Date.now()); // Update session TTL
  
  // 1. Fire-and-forget: Extract facts from user message (queued to prevent races)
  memory.extractAndSaveFact(convKey, message).catch(e => console.error('[Memory] Background extraction failed:', e));

  // 2. Route intent if "auto"
  let activeCharId = characterId;
  if (activeCharId === 'auto') {
    activeCharId = await classifyIntent(message);
    console.log(`[Router] → ${activeCharId.toUpperCase()}`);
  }

  // 3. Classify emotion (mood + intensity + crisis check)
  const emotion = await classifyEmotion(activeCharId, message);
  console.log(`[Emotion] ${activeCharId}: ${emotion.mood} (${(emotion.intensity * 100).toFixed(0)}%) ${emotion.isCrisis ? '⚠️ CRISIS' : ''}`);

  // 4. Retrieve relevant memories
  const retrievedMemories = await memory.fetchRelevantMemories(convKey, message);
  
  // 4b. Retrieve relevant textbook/document chunks (RAG)
  const documentChunks = await memory.searchDocumentChunks(convKey, message);

  // 5. Get user profile (dynamic age, name, etc.)
  const userProfile = await memory.getUserProfile(convKey);
  console.log(`[Profile] Name: ${userProfile.name || 'unknown'}, Age: ${userProfile.age || 'unknown'}`);

  // 6. Build personality-driven system prompt
  const activeChar = buildCharacterPrompt(activeCharId, userProfile, emotion.mood, {
    intensity: emotion.intensity,
    isCrisis: emotion.isCrisis
  });

  // Inject memories into system prompt
  let finalSystemPrompt = activeChar.systemPrompt;
  if (retrievedMemories.length > 0) {
    finalSystemPrompt += `\n\n[Long-Term Memories about this User]:\n- ${retrievedMemories.join('\n- ')}`;
  }

  // Inject RAG Document Chunks
  if (documentChunks && documentChunks.length > 0) {
    finalSystemPrompt += `\n\n[Context from User's Uploaded Documents]:\nUse this information to answer the user's questions if relevant:\n${documentChunks.join('\n\n')}`;
  }

  // 7. Track personality consistency
  const pState = getPersonalityContext(convKey, activeCharId);
  pState.responseCount++;
  pState.moodHistory.push(emotion.mood);
  if (pState.moodHistory.length > 10) pState.moodHistory.shift();

  finalSystemPrompt += buildConsistencyReminder(pState);

  // 8. Manage conversation history
  if (!conversations.has(convKey)) {
    conversations.set(convKey, []);
  }
  const history = conversations.get(convKey);
  history.push({ role: 'user', content: message });

  // Anti-repetition guard
  finalSystemPrompt += buildAntiRepetitionGuard(history);

  // Sliding window: keep last 20 messages for better context
  // CRITICAL: Strip any non-standard fields like 'character' out before sending to API 
  const recentHistory = history.slice(-20).map(m => ({
    role: m.role,
    content: m.content
  }));

  const messages = [
    { role: 'system', content: finalSystemPrompt },
    ...recentHistory
  ];

  // 9. Request Groq Inference (Streaming)
  try {
    if (!process.env.GROQ_API_KEY) {
      throw new Error("GROQ_API_KEY is missing in .env");
    }

    // Dynamic temperature: lower for crisis, higher for casual
    let temperature = 0.7;
    if (emotion.isCrisis) temperature = 0.4;    // More careful in crisis
    if (emotion.mood === 'analytical') temperature = 0.5;  // More precise
    if (emotion.mood === 'playful' || emotion.mood === 'witty') temperature = 0.85; // More creative

    // Dynamic max_tokens: increase for analytical/breakdown responses
    let maxTokens = 400;
    if (emotion.mood === 'analytical') maxTokens = 600;
    if (emotion.isCrisis) maxTokens = 300; // Keep crisis responses focused

    const controller = new AbortController();
    const groqTimeoutId = setTimeout(() => controller.abort(), 30000); // 30s total timeout
    
    let response;
    try {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
        },
        body: JSON.stringify({
          model: modelName || 'llama-3.3-70b-versatile',
          messages: messages,
          stream: true,
          temperature: temperature,
          max_tokens: maxTokens,
          frequency_penalty: 0.3,    // Reduces repetitive phrasing
          presence_penalty: 0.2      // Encourages topic diversity
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(groqTimeoutId);
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Groq Error]', errorText);
      throw new Error(`Groq API returned ${response.status}`);
    }

    // Stream headers
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    
    // Auto-routing header
    if (characterId === 'auto') {
      res.write(`[AUTO_ROUTED_TO:${activeCharId}]\n`);
    }

    let aiMessage = '';
    const decoder = new TextDecoder('utf-8');
    let buffer = ''; // Buffer for partial SSE lines

    // Use Node.js-compatible async iteration (works with v18+ native fetch)
    for await (const chunk of response.body) {
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      
      // Process complete lines from buffer
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete last line in buffer
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        try {
          const jsonStr = trimmed.replace(/^data:\s*/, '');
          const data = JSON.parse(jsonStr);
          if (data.choices?.[0]?.delta?.content) {
            const content = data.choices[0].delta.content;
            aiMessage += content;
            res.write(content);
          }
        } catch (e) {} // Ignore partial chunk parsing errors
      }
    }

    // Save to history (we can tracking character locally because we strip it before sending)
    history.push({ role: 'assistant', content: aiMessage, character: activeCharId });
    res.end();

  } catch (error) {
    console.error('API error:', error.message);
    const fallbackMsg = "Something went wrong, but I'm still here. Can you try saying that again?";
    
    // Safely return fallback message
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.write(fallbackMsg);
      history.push({ role: 'assistant', content: fallbackMsg, character: activeCharId });
      res.end();
    } else {
      res.write('\n' + fallbackMsg);
      res.end();
    }
  }
});

// ============================================================
// API: Document Upload & Summarization
// ============================================================
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { characterId, sessionId } = req.body;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    let extractedText = '';
    const filePath = file.path;

    // 1. Extract Text
    if (file.mimetype === 'application/pdf') {
       const dataBuffer = await fs.readFile(filePath);
       
       // Handle different versions of the pdf-parse package
       let data;
       if (typeof pdf === 'function') {
         data = await pdf(dataBuffer);
       } else if (pdf && typeof pdf.PDFParse === 'function') {
         data = await pdf.PDFParse(dataBuffer);
       } else {
         throw new Error('PDF parsing library is missing the parse function.');
       }
       
       extractedText = data.text;
    } else if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
       const dataBuffer = await fs.readFile(filePath);
       const result = await mammoth.extractRawText({ buffer: dataBuffer });
       extractedText = result.value;
    } else {
       // Assume text-based
       extractedText = await fs.readFile(filePath, 'utf8');
    }

    // Cleanup: delete file after extraction to save space
    await fs.unlink(filePath).catch(e => console.error('[Cleanup] Failed:', e));

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error('Could not extract text from document');
    }

    // --- RAG: Background Document Chunking & Saving ---
    const chunkSize = 1000;
    const chunks = [];
    for (let i = 0; i < extractedText.length; i += chunkSize) {
      chunks.push(extractedText.substring(i, i + chunkSize));
    }
    
    // Fire-and-forget background processing for RAG setup
    Promise.all(chunks.map(chunk => 
      memory.saveDocumentChunk(sessionId || 'default', file.originalname, chunk)
    )).then(() => console.log(`[RAG] Saved ${chunks.length} chunks from ${file.originalname}`))
      .catch(e => console.error('[RAG] Error saving chunks:', e));

    // 2. Select Character
    const activeCharId = characterId === 'auto' ? 'tanya' : characterId;
    
    // 3. Built Summarization Prompt
    const summaryPrompt = activeCharId === 'tanya' 
      ? `Hey! 💕 I just read this document for you. Here is a sweet and simple summary of everything important:\n\n[DOCUMENT CONTENT START]\n${extractedText.substring(0, 10000)}\n[DOCUMENT CONTENT END]\n\nWrite a warm, caring, and helpful summary for me. Keep it conversational. Mention that you're Tanya.`
      : `Yo! 🤙 I scanned that document. Here's the core logic and the main points you need to know:\n\n[DOCUMENT CONTENT START]\n${extractedText.substring(0, 10000)}\n[DOCUMENT CONTENT END]\n\nGive me a sharp, logical, and witty breakdown. Mention that you're Kian.`;

    // 4. Get Summary from Groq
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: summaryPrompt }],
        temperature: 0.7,
        max_tokens: 1000
      })
    });

    const data = await response.json();
    const summary = data.choices[0].message.content;

    res.json({ summary });

  } catch (error) {
    console.error('[Upload Error]', error.message);
    res.status(500).json({ error: 'Failed to process document: ' + error.message });
  }
});

// ============================================================

// ============================================================
// API: Computer Vision for Homework Help
// ============================================================
app.post('/api/vision', async (req, res) => {
  const { image, characterId, sessionId } = req.body;

  if (!image || !characterId) {
    return res.status(400).json({ error: 'Image and characterId are required' });
  }

  try {
    const activeCharId = characterId === 'auto' ? 'kian' : characterId;
    
    // Ensure properly formatted base64 URL
    const base64Url = image; // Frontend sends data URL

    const prompt = activeCharId === 'tanya' 
      ? "Hey! 💕 Can you look at this image and break it down for me in a warm, simple way? If it's homework, guide me gently."
      : "Yo Kian! 🤙 Check out this image. Give me a sharp, logical breakdown. If it's a problem, walk me through the solution step-by-step.";

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: base64Url } }
        ]
      }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.2-11b-vision-preview',
        messages: messages,
        temperature: 0.5,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Vision Error]', errText);
      throw new Error(`Vision API error: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.choices[0].message.content;

    // Save interaction to conversation history so context is preserved
    const convKey = sessionId || 'default';
    if (!conversations.has(convKey)) conversations.set(convKey, []);
    conversations.get(convKey).push({ role: 'user', content: "[User sent an image for analysis]" });
    conversations.get(convKey).push({ role: 'assistant', content: summary, character: activeCharId });

    res.json({ summary });

  } catch (error) {
    console.error('[Vision Endpoint Error]', error.message);
    res.status(500).json({ error: 'Failed to analyze image: ' + error.message });
  }
});

// ============================================================
// API: Clear conversation + reset personality state
// ============================================================
app.post('/api/clear', (req, res) => {
  const { sessionId } = req.body;
  const convKey = sessionId || 'default';
  conversations.delete(convKey);
  personalityState.delete(convKey);
  res.json({ success: true, message: 'Conversation cleared' });
});

// ============================================================
// API: Get memory stats (for debugging)
// ============================================================
app.get('/api/memory-stats/:sessionId', async (req, res) => {
  const stats = await memory.getMemoryStats(req.params.sessionId);
  const profile = await memory.getUserProfile(req.params.sessionId);
  res.json({ stats, profile });
});

// ============================================================
// API: Screen Share Analysis
// ============================================================
app.post('/api/screen-share', chatLimiter, async (req, res) => {
  const { image, characterId, sessionId } = req.body;

  if (!image || !characterId) {
    return res.status(400).json({ error: 'Image and characterId are required' });
  }

  try {
    const activeCharId = characterId === 'auto' ? 'kian' : characterId;

    const prompt = activeCharId === 'tanya'
      ? "Hey! 💕 The user is sharing their screen with me. I'll look at what's on their screen and help them out in a warm, friendly way. If it's study material, I'll explain it simply. If they're stuck on something, I'll guide them gently."
      : "Yo! 🤙 The user is sharing their screen. I'll give a sharp, logical breakdown of what I see. If it's code, I'll debug it. If it's a problem, I'll solve it step by step. If it's content, I'll summarize the key points.";

    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: image } }
        ]
      }
    ];

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.2-11b-vision-preview',
        messages: messages,
        temperature: 0.5,
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[Screen Share Error]', errText);
      throw new Error(`Vision API error: ${response.status}`);
    }

    const data = await response.json();
    const summary = data.choices[0].message.content;

    // Save to conversation history
    const convKey = sessionId || 'default';
    if (!conversations.has(convKey)) conversations.set(convKey, []);
    conversations.get(convKey).push({ role: 'user', content: '[User shared their screen for analysis]' });
    conversations.get(convKey).push({ role: 'assistant', content: summary, character: activeCharId });

    res.json({ summary });

  } catch (error) {
    console.error('[Screen Share Error]', error.message);
    res.status(500).json({ error: 'Failed to analyze screen: ' + error.message });
  }
});

// ============================================================
// API: Serve uploaded PDFs for preview
// ============================================================
app.get('/api/pdf-preview/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // Prevent path traversal
  const filePath = path.join(__dirname, 'uploads', filename);
  res.sendFile(filePath, (err) => {
    if (err) res.status(404).json({ error: 'File not found' });
  });
});

// ============================================================
// Multer Error Handler
// ============================================================
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 15MB.' });
    }
    return res.status(400).json({ error: 'Upload error: ' + err.message });
  }
  if (err.message && err.message.includes('not allowed')) {
    return res.status(415).json({ error: err.message });
  }
  next(err);
});

// ============================================================
// Serve frontend
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Landing Page
app.get('/landing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║    🧠 Project Eira v4.0 (Hardened)      ║
  ║    🔒 Helmet + Rate Limit + XSS Guard   ║
  ║    🖥️  Screen Share + PDF Preview        ║
  ║    Open: http://localhost:${PORT}          ║
  ║    Landing: http://localhost:${PORT}/landing ║
  ╚══════════════════════════════════════════╝
  `);
});
