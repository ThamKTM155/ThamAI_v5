// frontend/script.js
const API_BASE = window.API_URL_BASE || ""; // nếu muốn set khác, set window.API_URL_BASE = "https://..." trước khi load
const CHAT_STREAM_URL = (API_BASE || "http://localhost:3000") + "/chat-stream";
const CHAT_URL = (API_BASE || "http://localhost:3000") + "/chat";

window.addEventListener("DOMContentLoaded", () => {
  const chatBox = document.getElementById("chatbox");
  const userInput = document.getElementById("userInput");
  const sendBtn = document.getElementById("sendBtn");
  const micBtn = document.getElementById("micBtn");
  const audioPlayer = document.getElementById("audio-player");

  if (!chatBox || !userInput || !sendBtn) {
    console.error("Missing elements in index.html");
    return;
  }

  function appendUser(text) {
    const d = document.createElement("div");
    d.className = "msg user";
    d.textContent = text;
    chatBox.appendChild(d);
    chatBox.scrollTop = chatBox.scrollHeight;
  }

  function appendAIContainer() {
    const d = document.createElement("div");
    d.className = "msg ai";
    const p = document.createElement("div");
    p.className = "ai-text";
    d.appendChild(p);
    chatBox.appendChild(d);
    chatBox.scrollTop = chatBox.scrollHeight;
    return p;
  }

  // safe append code block with highlighting
  function appendCodeBlock(parent, code, lang="") {
    const pre = document.createElement("pre");
    const codeEl = document.createElement("code");
    if (lang) codeEl.className = lang;
    codeEl.textContent = code;
    pre.appendChild(codeEl);
    parent.appendChild(pre);
    if (window.hljs) window.hljs.highlightElement(codeEl);
  }

  async function sendMessage() {
    const message = userInput.value.trim();
    if (!message) return;
    appendUser(message);
    userInput.value = "";

    // Create AI container for streaming
    const aiTextEl = appendAIContainer();
    let accumulated = "";

    try {
      // POST to chat-stream and read streamed chunks
      const resp = await fetch(CHAT_STREAM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message })
      });

      if (!resp.ok) {
        // fallback to single-call endpoint
        const j = await resp.json().catch(()=>null);
        const fallback = j?.reply || `❗ Lỗi server: ${resp.status}`;
        aiTextEl.textContent = fallback;
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      while(true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        accumulated += chunk;
        // simple heuristic: if chunk contains code fences, render later; otherwise update live
        aiTextEl.textContent = accumulated;
        chatBox.scrollTop = chatBox.scrollHeight;
      }

      // After stream ends, final rendering: if contains ``` treat as code
      if (accumulated.includes("```")) {
        // parse out fenced blocks and text
        aiTextEl.innerHTML = "";
        const parts = accumulated.split(/(```[\s\S]*?```)/g);
        for (const part of parts) {
          if (part.startsWith("```") && part.endsWith("```")) {
            const inner = part.slice(3, -3).trim();
            // detect language hint like ```js
            const langHint = (part.match(/^```(\w+)/) || [])[1] || "";
            appendCodeBlock(aiTextEl, inner, langHint ? `language-${langHint}` : "");
          } else {
            const p = document.createElement("div");
            p.textContent = part;
            aiTextEl.appendChild(p);
          }
        }
      }

      // TTS: use SpeechSynthesis fallback in browser (no server audio)
      try {
        const utter = new SpeechSynthesisUtterance(accumulated);
        utter.lang = "vi-VN";
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utter);
      } catch (e) { /* ignore */ }

    } catch (err) {
      console.error("sendMessage error", err);
      const aiErr = document.createElement("div");
      aiErr.textContent = "❗ Lỗi kết nối máy chủ.";
      aiTextEl.appendChild(aiErr);
    }
  }

  userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  if (micBtn) {
    micBtn.addEventListener("click", async () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) return alert("Trình duyệt không hỗ trợ ghi âm STT. Dùng gõ tay hoặc upload audio.");
      const r = new SR();
      r.lang = "vi-VN";
      r.interimResults = false;
      r.onresult = (e) => {
        const txt = Array.from(e.results).map(r=>r[0].transcript).join("");
        userInput.value = txt;
        sendMessage();
      };
      r.onerror = (e) => console.error("SpeechRecognition error", e);
      r.start();
    });
  }

});
