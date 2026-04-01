// AI Companion — Frontend Logic (Mobile-First v3)

const selectionScreen = document.getElementById("character-selection");
const chatScreen = document.getElementById("chat-screen");

const chatAvatar = document.getElementById("chat-avatar");
const chatName = document.getElementById("chat-name");
const messagesArea = document.getElementById("messages-area");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const micBtn = document.getElementById("mic-btn");
const backBtn = document.getElementById("back-button");
const clearBtn = document.getElementById("clear-btn");
const switchBtn = document.getElementById("switch-btn");
const chatStatus = document.getElementById("chat-status");

const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const screenShareBtn = document.getElementById("screen-share-btn");
const dropOverlay = document.getElementById("drop-overlay");

let currentCharacter = null;
let sessionId = Date.now().toString();
let isWaiting = false;
let isVoiceEnabled = false; // Voice is off by default

// Characters Data — with randomized welcome messages to prevent staleness
const characters = {
  tanya: {
    id: "tanya",
    name: "Tanya",
    avatar: "/images/tanya.jpg",
    theme: "theme-tanya",
    welcomeMessages: [
      "Hey! 💕 Kya scene hai? I'm Tanya — bata, kya chal raha hai tere saath?",
      "Hiii! 💕 Main Tanya. Aaj kaisa raha din? Bata na!",
      "Hey yaar! 💕 Tanya here. Suno, I'm all ears — kya baat karna hai?",
      "Helloo! 💕 Main Tanya hoon. Chal, let's catch up — what's up?",
      "Hey! 💕 I'm Tanya. Aaj ki vibe kaisi hai? Bata mujhe!"
    ]
  },
  kian: {
    id: "kian",
    name: "Kian",
    avatar: "/images/kian.jpg",
    theme: "theme-kian",
    welcomeMessages: [
      "Yo! 🤙 Kian here. Seedhi baat — kya problem hai? Ya bas chill karna hai?",
      "Bro! 🤙 Main Kian. Bata, kya scene hai aaj ka?",
      "Hey! 🤙 Kian this side. Chal bata — kya plan hai ya kuch sort out karna hai?",
      "Yo bhai! 🤙 Kian here. Ready for some real talk? Bol kya chal raha.",
      "Hey! 🤙 Main Kian. Aaj kya karna hai — padhai, planning, ya just bakchodi?"
    ]
  }
};

// --- Screen Transitions --- //

function showScreen(toShow, toHide) {
  toHide.classList.remove('active');
  toHide.style.display = "none";
  toShow.style.display = "flex";
  // Tiny delay for CSS transition
  requestAnimationFrame(() => {
    toShow.classList.add('active');
  });
}

// --- DOM Event Listeners --- //

// 1. Character Selection
document.getElementById("tanya-select").addEventListener("click", function() {
  document.body.className = "theme-tanya";
  showScreen(chatScreen, selectionScreen);
  initChat("tanya");
});

document.getElementById("kian-select").addEventListener("click", function() {
  document.body.className = "theme-kian";
  showScreen(chatScreen, selectionScreen);
  initChat("kian");
});

// 2. Chat Controls
backBtn.addEventListener("click", () => {
  showScreen(selectionScreen, chatScreen);
  document.body.className = "";
  if (window.speechSynthesis) window.speechSynthesis.cancel();
});

const voiceToggleBtn = document.getElementById("voice-toggle-btn");
if (voiceToggleBtn) {
  voiceToggleBtn.addEventListener("click", () => {
    isVoiceEnabled = !isVoiceEnabled;
    if (isVoiceEnabled) {
      voiceToggleBtn.style.color = "#4ade80"; // Bright Green for ON state
      addSystemMessage("Voice synthesis enabled 🔊");
    } else {
      voiceToggleBtn.style.color = ""; 
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      addSystemMessage("Voice synthesis disabled 🔇");
    }
  });
}

switchBtn.addEventListener("click", () => {
  if (!currentCharacter) return;
  const nextId = currentCharacter.id === 'tanya' ? 'kian' : 'tanya';
  document.body.className = `theme-${nextId}`;
  
  // Update character session state locally
  currentCharacter = characters[nextId];
  chatName.innerText = currentCharacter.name;
  chatAvatar.src = currentCharacter.avatar;
  
  // Push a system-like message to UI to clarify the switch
  addSystemMessage(`Switched to ${currentCharacter.name}`);
});

clearBtn.addEventListener("click", async () => {
  if (!currentCharacter) return;
  if (confirm(`Start a new conversation with ${currentCharacter.name}?`)) {
    await fetch('/api/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });
    sessionId = Date.now().toString();
    initChat(currentCharacter.id);
  }
});

// 3. User Input
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

messageInput.addEventListener("input", () => {
  // Auto-expand textarea
  messageInput.style.height = 'auto';
  messageInput.style.height = (messageInput.scrollHeight) + 'px';

  if (messageInput.value.trim()) {
    sendBtn.classList.add("active");
  } else {
    sendBtn.classList.remove("active");
  }
});

// 4. File Upload
attachBtn.addEventListener("click", () => {
  if (isWaiting) return;
  fileInput.click();
});

fileInput.addEventListener("change", async (e) => {
  if (!e.target.files.length) return;
  const file = e.target.files[0];
  if (file.type.startsWith('image/')) {
    await processImageForVision(file);
  } else {
    await uploadFile(file);
  }
  e.target.value = ""; // Reset for next selection
});

// Fix for mobile keyboards shifting viewport
messageInput.addEventListener("focus", () => {
  setTimeout(() => scrollToBottom(), 300);
});

// 5. Screen Share
screenShareBtn.addEventListener("click", () => {
  if (isWaiting) return;
  captureScreen();
});

// 6. Drag & Drop File Upload
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  document.body.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});

document.body.addEventListener('dragenter', () => {
  if (currentCharacter) dropOverlay.classList.add('active');
});

dropOverlay.addEventListener('dragleave', (e) => {
  if (e.target === dropOverlay) dropOverlay.classList.remove('active');
});

dropOverlay.addEventListener('drop', (e) => {
  dropOverlay.classList.remove('active');
  if (!currentCharacter || isWaiting) return;
  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type.startsWith('image/')) {
      processImageForVision(file);
    } else {
      uploadFile(file);
    }
  }
});


// --- Core Functions --- //

function initChat(charId) {
  currentCharacter = characters[charId];
  
  // Set Header
  chatName.innerText = currentCharacter.name;
  chatAvatar.src = currentCharacter.avatar;
  chatStatus.innerText = "Online • Ready to chat";
  
  // Clear Messages and add randomized Welcome
  messagesArea.innerHTML = "";
  const welcomeList = currentCharacter.welcomeMessages;
  const randomWelcome = welcomeList[Math.floor(Math.random() * welcomeList.length)];
  addAiMessage(randomWelcome);
  
  // Focus input
  if (!('ontouchstart' in window)) {
    messageInput.focus();
  }
  
  // Reset textarea height
  messageInput.style.height = 'auto';
  
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

function addSystemMessage(text) {
  const html = `<div class="msg-wrapper system" style="align-self:center;margin:10px 0;opacity:0.6;font-size:11px;text-transform:uppercase;letter-spacing:1px;">— ${text} —</div>`;
  messagesArea.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || isWaiting) return;

  isWaiting = true;
  sendBtn.classList.remove("active");
  chatStatus.innerText = "Thinking...";

  if (window.speechSynthesis) window.speechSynthesis.cancel();

  addMessageToUI(text, "user");
  messageInput.value = "";
  messageInput.style.height = 'auto'; // Reset height after sending

  // Blur input on mobile to dismiss keyboard after sending
  if ('ontouchstart' in window) {
    messageInput.blur();
  }

  // Animated typing indicator
  const typingId = "typing-" + Date.now();
  const typingHTML = `
    <div id="${typingId}" class="msg-wrapper ai">
      <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
      <div class="msg-bubble">
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  `;
  messagesArea.insertAdjacentHTML('beforeend', typingHTML);
  scrollToBottom();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        characterId: currentCharacter.id,
        sessionId: sessionId,
        modelName: 'llama-3.3-70b-versatile'
      })
    });

    // Remove typing indicator
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (!response.ok) {
      console.error("Chat request failed:", response.status, response.statusText);
      addAiMessage("Sorry, I'm having trouble connecting right now. 😔\nPlease try again in a moment.");
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let aiText = '';
    
    const bubbleId = "msg-" + Date.now();
    const aiMsgHTML = `
      <div class="msg-wrapper ai">
        <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
        <div id="${bubbleId}" class="msg-bubble"></div>
      </div>
    `;
    messagesArea.insertAdjacentHTML('beforeend', aiMsgHTML);
    const bubbleEl = document.getElementById(bubbleId);
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      let chunk = decoder.decode(value, { stream: true });
      // Handle auto-routing marker
      chunk = chunk.replace(/^\[AUTO_ROUTED_TO:(tanya|kian)\]\n/, ''); 
      aiText += chunk;
      
      // Render with basic Markdown support
      bubbleEl.innerHTML = renderMarkdown(aiText);
      scrollToBottom();
    }
    
    // Speak if enabled
    if (isVoiceEnabled) {
      speakText(aiText);
    }

  } catch (err) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    addAiMessage("Couldn't reach the server! 🔌\nMake sure the Node server is running.");
  } finally {
    // ALWAYS reset state so user can send again
    isWaiting = false;
    chatStatus.innerText = "Online • Ready to chat";
    if (messageInput.value.trim()) {
      sendBtn.classList.add("active");
    }
  }
}

async function uploadFile(file) {
  if (isWaiting) return;
  isWaiting = true;
  chatStatus.innerText = "Analyzing file...";
  
  // Show file selection in UI
  addSystemMessage(`Uploading: ${file.name}`);
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('characterId', currentCharacter.id);
  formData.append('sessionId', sessionId);

  // Animated typing indicator
  const typingId = "typing-" + Date.now();
  const typingHTML = `
    <div id="${typingId}" class="msg-wrapper ai">
      <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
      <div class="msg-bubble">
        <div class="typing-dots">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  `;
  messagesArea.insertAdjacentHTML('beforeend', typingHTML);
  scrollToBottom();

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (!response.ok) {
      const err = await response.json();
      addAiMessage(`Sorry, I couldn't read that file. ${err.error || ""}`);
      return;
    }

    const data = await response.json();
    // Use PDF card for document files, plain message for others
    if (file.name.match(/\.(pdf|docx|txt)$/i)) {
      renderPdfCard(file.name, data.summary);
    } else {
      addAiMessage(data.summary);
    }

  } catch (err) {
    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();
    addAiMessage("File upload failed! 🔌 Check your connection.");
  } finally {
    isWaiting = false;
    chatStatus.innerText = "Online • Ready to chat";
  }
}

async function processImageForVision(file) {
  if (isWaiting) return;
  isWaiting = true;
  chatStatus.innerText = "Analyzing image...";

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Image = e.target.result;
      
      // Show user message with image
      const html = `
        <div class="msg-wrapper user">
          <div class="msg-bubble img-preview"><img src="${base64Image}" style="max-width:100%; max-height:200px; border-radius:8px;"></div>
        </div>
      `;
      messagesArea.insertAdjacentHTML('beforeend', html);
      scrollToBottom();

      // Typing indicator
      const typingId = "typing-" + Date.now();
      const typingHTML = `
        <div id="${typingId}" class="msg-wrapper ai">
          <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
          <div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>
        </div>
      `;
      messagesArea.insertAdjacentHTML('beforeend', typingHTML);
      scrollToBottom();

      try {
        const response = await fetch('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: base64Image,
            characterId: currentCharacter.id,
            sessionId: sessionId
          })
        });

        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();

        if (!response.ok) throw new Error("Vision failed");

        const data = await response.json();
        addAiMessage(data.summary);
        
        if (isVoiceEnabled) speakText(data.summary);
      } catch (err) {
        const typingEl = document.getElementById(typingId);
        if (typingEl) typingEl.remove();
        addAiMessage("Sorry, I couldn't see the image properly. 😔");
      } finally {
        isWaiting = false;
        chatStatus.innerText = "Online • Ready to chat";
        resolve();
      }
    };
    reader.readAsDataURL(file);
  });
}

// --- Screen Capture --- //

async function captureScreen() {
  if (!currentCharacter) return;
  
  try {
    // Request screen capture
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { mediaSource: 'screen' }
    });

    // Capture a frame from the stream
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();

    // Wait a moment for the video to load
    await new Promise(resolve => setTimeout(resolve, 500));

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);

    // Stop the stream immediately after capture
    stream.getTracks().forEach(track => track.stop());

    const base64Image = canvas.toDataURL('image/jpeg', 0.8);

    // Show the captured screen in chat
    const html = `
      <div class="msg-wrapper user">
        <div class="msg-bubble img-preview">
          <div class="screen-share-badge">🖥️ Screen Capture</div>
          <img src="${base64Image}" style="max-width:100%; max-height:250px; border-radius:8px;">
        </div>
      </div>
    `;
    messagesArea.insertAdjacentHTML('beforeend', html);
    scrollToBottom();

    // Send to AI for analysis
    isWaiting = true;
    chatStatus.innerText = "Analyzing screen...";

    const typingId = "typing-" + Date.now();
    const typingHTML = `
      <div id="${typingId}" class="msg-wrapper ai">
        <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
        <div class="msg-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>
      </div>
    `;
    messagesArea.insertAdjacentHTML('beforeend', typingHTML);
    scrollToBottom();

    const response = await fetch('/api/screen-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        image: base64Image,
        characterId: currentCharacter.id,
        sessionId: sessionId
      })
    });

    const typingEl = document.getElementById(typingId);
    if (typingEl) typingEl.remove();

    if (!response.ok) throw new Error("Screen analysis failed");

    const data = await response.json();
    addAiMessage(data.summary);

    if (isVoiceEnabled) speakText(data.summary);

  } catch (err) {
    if (err.name === 'NotAllowedError') {
      // User cancelled screen share — do nothing
      return;
    }
    console.error('[Screen Share]', err);
    addAiMessage("Sorry, I couldn't capture the screen. \ud83d\ude14 Make sure you grant screen sharing permission.");
  } finally {
    isWaiting = false;
    chatStatus.innerText = "Online \u2022 Ready to chat";
  }
}

// --- PDF Card Renderer --- //

function renderPdfCard(fileName, summary) {
  const html = `
    <div class="msg-wrapper ai">
      <img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">
      <div class="msg-bubble">
        <div class="pdf-card">
          <div class="pdf-card-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>
          </div>
          <div class="pdf-card-info">
            <span class="pdf-card-name">${fileName}</span>
            <span class="pdf-card-status">Analyzed \u2713</span>
          </div>
        </div>
        <div style="margin-top:10px;">${renderMarkdown(summary)}</div>
      </div>
    </div>
  `;
  messagesArea.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

// --- Markdown Renderer --- //

function renderMarkdown(text) {
  let html = text;
  // Escape HTML
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // Bold: **text**
  html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // Italic: *text*
  html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
  // Inline code: `code`
  html = html.replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:4px;font-size:0.9em;">$1</code>');
  return html;
}

// --- UI Helpers --- //

function addMessageToUI(text, role) {
  // Escape HTML in text
  const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `
    <div class="msg-wrapper ${role}">
      ${role === 'ai' ? `<img src="${currentCharacter.avatar}" class="avatar-msg" alt="AI">` : ""}
      <div class="msg-bubble">${role === 'ai' ? renderMarkdown(text) : safeText}</div>
    </div>
  `;
  messagesArea.insertAdjacentHTML('beforeend', html);
  scrollToBottom();
}

function addAiMessage(text) {
  addMessageToUI(text, "ai");
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  });
}

// --- Voice Recognition (Speech-to-Text) --- //

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  
  let isRecording = false;

  micBtn.addEventListener("click", () => {
    if (isRecording) {
      recognition.stop();
      return;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    
    messageInput.value = "";
    messageInput.placeholder = "Listening...";
    micBtn.classList.add("mic-recording");
    recognition.start();
    isRecording = true;
  });

  recognition.onresult = (event) => {
    let finalTranscript = '';
    let interimTranscript = '';
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      else interimTranscript += event.results[i][0].transcript;
    }
    
    messageInput.value = finalTranscript || interimTranscript;
    if (finalTranscript) {
      setTimeout(sendMessage, 500);
    }
  };

  recognition.onend = () => {
    isRecording = false;
    micBtn.classList.remove("mic-recording");
    messageInput.placeholder = "Type a message...";
  };
  
  recognition.onerror = () => {
    isRecording = false;
    micBtn.classList.remove("mic-recording");
    messageInput.placeholder = "Type a message...";
  };
} else {
  micBtn.style.display = "none"; 
}

// --- Voice Generation (Text-to-Speech) --- //

function speakText(text) {
  if (!window.speechSynthesis || !currentCharacter) return;
  
  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();
  let selectedVoice = null;
  
  if (currentCharacter.id === 'tanya') {
    selectedVoice = voices.find(v => v.name.includes('Female') || v.name.includes('Zira'));
    utterance.pitch = 1.1;
  } else {
    selectedVoice = voices.find(v => v.name.includes('Male') || v.name.includes('David'));
    utterance.pitch = 0.95;
  }
  
  if (selectedVoice) utterance.voice = selectedVoice;
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => window.speechSynthesis.getVoices();
}

// --- Mobile viewport fix (iOS Safari address bar) --- //
function setViewportHeight() {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);
