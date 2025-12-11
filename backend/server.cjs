// backend/server.cjs
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");

const OPENAI_KEY = process.env.OPENAI_API_KEY || ""; // nếu anh có key -> dùng OpenAI
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || ""; // optional

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
console.log("ThamAI v5 backend starting on port", PORT);
console.log("OPENAI_KEY present:", !!OPENAI_KEY, "OPENROUTER_KEY present:", !!OPENROUTER_KEY);

// SIMPLE local fallback reply (deterministic, fast)
function simpleReply(user) {
  const u = (user || "").trim();
  if (!u) return "Bạn chưa nhập gì cả.";
  if (/xin chào|chào/i.test(u)) return "Chào bạn! Mình là ThamAI (chế độ miễn phí).";
  if (/giúp|làm/i.test(u)) return "Mình có thể giúp: học lập trình, viết nội dung, tạo ý tưởng, tán gẫu.";
  return `Echo (miễn phí): ${user}`;
}

// Helper: simulate streaming by splitting text into chunks
function *chunker(text, chunkSize = 40) {
  let i = 0;
  while (i < text.length) {
    yield text.slice(i, i + chunkSize);
    i += chunkSize;
  }
}

// Try call OpenAI (non-stream) — returns string or null
async function callOpenAIOnce(message) {
  try {
    if (!OPENAI_KEY) return null;
    const payload = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Bạn là ThamAI — trợ lý thân thiện, trả lời ngắn gọn khi cần." },
        { role: "user", content: message }
      ],
      max_tokens: 512
    };
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const t = await res.text().catch(()=>"");
      console.error("OpenAI non-stream error", res.status, t);
      return null;
    }
    const j = await res.json();
    const reply = j?.choices?.[0]?.message?.content || j?.choices?.[0]?.text || null;
    return reply;
  } catch (e) {
    console.error("callOpenAIOnce error", e);
    return null;
  }
}

// POST /chat -> single JSON response
app.post("/chat", async (req, res) => {
  try {
    const message = (req.body && req.body.message) || "";
    if (!message) return res.status(400).json({ error: "Missing message" });

    let reply = null;
    // try OpenAI first
    reply = await callOpenAIOnce(message);
    if (!reply) reply = simpleReply(message);

    return res.json({ reply, audio_base64: null });
  } catch (err) {
    console.error("chat err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// POST /chat-stream -> streaming chunks (text/event-stream-like but using chunked plain text)
// Frontend will fetch and read response.body stream
app.post("/chat-stream", async (req, res) => {
  try {
    const message = (req.body && req.body.message) || "";
    if (!message) return res.status(400).json({ error: "Missing message" });

    // Decide reply source
    let reply = await callOpenAIOnce(message); // try single-call for quality
    if (!reply) {
      reply = simpleReply(message);
    }

    // Start streaming response:
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    // disable buffering at proxies if possible
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    // stream chunks with small delay to allow frontend progressive rendering
    (async () => {
      for (const part of chunker(reply, 60)) {
        try {
          res.write(part);
          // small flush-friendly pause
          await new Promise(r => setTimeout(r, 50));
        } catch (e) {
          console.warn("stream write error:", e);
          break;
        }
      }
      try { res.end(); } catch (e) {}
    })();

  } catch (err) {
    console.error("chat-stream err", err);
    try { res.status(500).end("ERROR"); } catch(e) {}
  }
});

// health
app.get("/", (req, res) => res.json({ status: "ok", mode: OPENAI_KEY ? "openai" : "free" }));

app.listen(PORT, () => {
  console.log(`ThamAI v5 backend listening on ${PORT}`);
});
