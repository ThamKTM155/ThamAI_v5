// frontend/script.pro.js
// ThamAI — Frontend secure v1
// Tính năng bảo mật:
// - Bắt buộc HTTPS (nếu không set API_BASE)
// - Sanitize output (simple text-only renderer)
// - Rate-limit gửi (1 request / 800ms) để tránh spam
// - Không chứa bất kỳ key/hardcode secret nào
// - Tùy chọn tắt TTS để tránh leak qua audio
// - Xử lý lỗi an toàn, không leak header/token

(function () {
  "use strict";

  // --- CẤU HÌNH ---
  const DEFAULT_API = ""; // để trống khuyến nghị; production hãy set window.API_URL_BASE trước khi load
  const MIN_REQUEST_INTERVAL_MS = 800; // rate-limit
  const ALLOW_TTS = false; // nếu muốn bật TTS mặc định, set true
  const FORCE_HTTPS = true; // nếu true và API_BASE rỗng -> require HTTPS endpoint

  // Lấy API_BASE an toàn: ưu tiên window var (đặt trước khi load script)
  const API_BASE_RAW = window.API_URL_BASE || DEFAULT_API;
  const API_BASE = (function () {
    if (!API_BASE_RAW) return ""; // dev local -> empty allowed
    try {
      const u = new URL(API_BASE_RAW);
      if (FORCE_HTTPS && u.protocol !== "https:") {
        console.warn("API_URL_BASE is not HTTPS — blocked by security policy.");
        return "";
      }
      return u.origin;
    } catch (e) {
      console.warn("Invalid API_URL_BASE — ignored.");
      return "";
    }
  })();

  const CHAT_STREAM_URL = (API_BASE || "http://localhost:3000") + "/chat-stream";
  const CHAT_URL = (API_BASE || "http://localhost:3000") + "/chat";

  // --- HELPERS ---
  function $(id) { return document.getElementById(id); }

  // Simple sanitizer: treat content as plain text; preserve code fences explicitly
  function sanitizeAndRender(container, raw) {
    // If contains triple backticks -> do fence-aware rendering
    if (raw.includes("```")) {
      container.innerHTML = ""; // clear
      const parts = raw.split(/(```[\s\S]*?```)/g);
      parts.forEach(part => {
        if (part.startsWith("```") && part.endsWith("```")) {
          const inner = part.slice(3, -3);
          const langMatch = part.match(/^```(\w+)/);
          const lang = langMatch ? langMatch[1] : "";
          const pre = document.createElement("pre");
          const code = document.createElement("code");
          code.textContent = inner;
          if (lang) code.className = `language-${lang}`;
          pre.appendChild(code);
          container.appendChild(pre);
          if (window.hljs) try { window.hljs.highlightElement(code); } catch(e){}
        } else {
          const p = document.createElement("div");
          p.textContent = part;
          container.appendChild(p);
        }
      });
    } else {
      // normal plain text
      container.textContent = raw;
    }
  }

  // Rate limiter
  let lastRequestAt = 0;
  function allowRequest() {
    const now = Date.now();
    if (now - lastRequestAt < MIN_REQUEST_INTERVAL_MS) return false;
    lastRequestAt = now;
    return true;
  }

  // Safe fetch wrapper (no credentials, no exposing tokens)
  async function safeFetch(url, opts = {}) {
    const safeOpts = Object.assign({}, opts);
    // remove credentials by default
    safeOpts.credentials = "omit";
    // ensure no Authorization headers are leaked from frontend-side
    if (safeOpts.headers) {
      const h = Object.assign({}, safeOpts.headers);
      delete h.Authorization;
      delete h.authorization;
      safeOpts.headers = h;
    }
    return fetch(url, safeOpts);
  }

  // TTS wrapper (can disable)
  function speakText(text) {
    if (!ALLOW_TTS) return;
    try {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "vi-VN";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utter);
    } catch (e) {
      console.warn("TTS failed", e);
    }
  }

  // --- UI init ---
  window.addEventListener("DOMContentLoaded", () => {
    const chatBox = $("chatbox");
    const userInput = $("userInput");
    const sendBtn = $("sendBtn");
    const micBtn = $("micBtn");

    if (!chatBox || !userInput || !sendBtn) {
      console.error("Missing UI elements");
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

    async function sendMessage() {
      const message = userInput.value.trim();
      if (!message) return;
      if (!allowRequest()) {
        alert("Bạn đang gửi quá nhanh — vui lòng đợi một chút.");
        return;
      }
      appendUser(message);
      userInput.value = "";

      const aiTextEl = appendAIContainer();
      let accumulated = "";

      try {
        const resp = await safeFetch(CHAT_STREAM_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message })
        });

        if (!resp.ok) {
          const j = await resp.json().catch(()=>null);
          const fallback = j?.reply || `❗ Lỗi server: ${resp.status}`;
          sanitizeAndRender(aiTextEl, fallback);
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          accumulated += chunk;
          // render live as plain text
          sanitizeAndRender(aiTextEl, accumulated);
          chatBox.scrollTop = chatBox.scrollHeight;
        }

        // final rendering
        sanitizeAndRender(aiTextEl, accumulated);

        // optional TTS
        speakText(accumulated);

      } catch (err) {
        console.error("sendMessage error", err);
        sanitizeAndRender(aiTextEl, "❗ Lỗi kết nối máy chủ.");
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
        if (!SR) return alert("Trình duyệt không hỗ trợ STT.");
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

})();
