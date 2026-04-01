# Project Eira 🧠

Project Eira is a culturally-native AI study companion designed specifically for Indian students. It features a responsive, dark-mode first UI, advanced long-term memory capabilities (via Xenova/Transformers vector embeddings), and high-speed cognitive reasoning using parsing models through the Groq API.

## Features
- **Dual Personas:** Switch seamlessly between Tanya (emotional support) and Kian (logic and strategy).
- **Persistent AI Memory:** Remembers important context about the user's life, extracting facts in the background.
- **RAG & Computer Vision:** Users can upload documents (PDF/TXT) or share their screen for instant AI analysis.
- **Security Hardened:** Fully protected with Helmet.js, rate-limiting, and XSS sanitization. 

## Deployment
Built entirely on Node.js. Can be easily deployed mapped out-of-the-box to free cloud platforms like Render.com.

## Tech Stack
- Frontend: Vanilla HTML/JS/CSS (PWA-enabled)
- Backend: Express.js (Node.js)
- Intelligence: Groq API (Llama 8B Instant)
- Vector Embeddings: @xenova/transformers (local Node.js embedding generation)
- Storage: SQLite3 with manual eviction policies
