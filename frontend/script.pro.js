// frontend/script.pro.js
// ThamAI — Frontend secure v1 (PRO)
// Mục tiêu: KHÔNG chứa bất kỳ secret nào, sanitize output, HTTPS policy, rate-limit, optional TTS disabled by default.

(function () {
  "use strict";

  // --- CẤU HÌNH ---
  const DEFAULT_API = ""; // để trống cho dev; production: set window.API_URL_BASE trước khi load
  const MIN_REQUEST_INTERVAL_MS = 800; // rate-limit
  const ALLOW_TTS = false; // mặc định tắt TTS (bật tùy ý)
  const FORCE_HTTPS = true; // nếu true và API_BASE rỗng -> vẫn dùng localhost; nếu set API_BASE bắt buộc https

  // Lấy API_BASE an toàn: ưu tiên biến window (đặt trước khi load)
  const API_BASE_RAW = window.API_URL_BASE || DEFAULT_API;
  const API_BASE = (function () {
    if (!API_BASE_RAW) return "";
    try {
      const u = new URL(API_BASE_RAW);
      if (FORCE_HTTPS && u.protocol !== "https:") {
        console.warn("API_URL_BASE không phải HTTPS - bị chặn bởi policy bảo mật.");
        return "";
      }
      return u.origin;
    } catch (e) {
      console.warn("API_URL_BASE không hợp lệ - bỏ qua.");
      return "";
    }
  })();

  const CHAT_STREAM_URL = (API_BASE || "http://localhost:3000") + "/chat-stream";
  const CHAT_URL = (API_BASE || "http://localhost:3000") + "/chat";

  // --- HELPERS ---
  function $(id) { return document.getElementById(id); }

  // Simple sanitizer: render plain text; treat fenced code explicitly
  function sanitizeAndRender(container, raw) {
    if (!raw || typeof raw !== "string") {
      container.textContent = String(raw || "");
      return;
    }
    if (raw.includes("```")) {
      container.innerHTML = "";
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
      container.textContent = raw;
    }
  }

  // rate limiter
  let lastRequestAt = 0;
  function allowRequest() {
    const now = Date.now();
    if (now - lastRequestAt < MIN_REQUEST_INTERVAL_MS) return false;
    lastRequestAt = now;
    return true;
  }

  // Safe fetch wrapper: remove credentials & Authorization
  async function safeFetch(url, opts = {}) {
    const safeOpts = Object.assign({}, opts);
    safeOpts.credentials = "omit";
    if (safeOpts.headers) {
      const h = Object.assign({}, safeOpts.headers);
      delete h.Authorization;
      delete h.authorization;
      safeOpts.headers = h;
    }
    return fetch(url, safeOpts);
  }

  // Optional TTS wrapper
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
          sanitizeAndRender(aiTextEl, accumulated);
          chatBox.scrollTop = chatBox.scrollHeight;
        }

        sanitizeAndRender(aiTextEl, accumulated);
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
