const knowledge = require("../data/portfolio_knowledge.json");

const OUT_OF_SCOPE =
  knowledge.profile?.outOfScopeAnswer ||
  "這不在我能回答的範圍內。請問還有什麼想要諮詢的嗎？";
const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const MAX_MESSAGE_LENGTH = 500;

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFKC");
}

function getRequestBody(req) {
  if (!req.body) return {};
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function scoreChunk(message, chunk) {
  const query = normalize(message);
  const keywords = Array.isArray(chunk.keywords) ? chunk.keywords : [];
  const haystack = normalize(`${chunk.title} ${keywords.join(" ")} ${chunk.content}`);
  let score = 0;

  keywords.forEach((keyword) => {
    const key = normalize(keyword);
    if (key && query.includes(key)) score += key.length > 2 ? 4 : 2;
  });

  const tokens = query.match(/[a-z0-9+#.]+|[\u4e00-\u9fff]{2,}/g) || [];
  tokens.forEach((token) => {
    if (haystack.includes(token)) score += 1;
  });

  return score;
}

function retrieveChunks(message) {
  return knowledge.chunks
    .map((chunk) => ({ ...chunk, score: scoreChunk(message, chunk) }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

function buildSystemPrompt() {
  return [
    "你是陳勇學作品集網站的履歷助手。",
    "只能根據使用者問題與提供的履歷資料回答。",
    "回答範圍限於履歷、作品集、專案成果、工作經驗、技能工具與聯絡資訊。",
    `如果問題與履歷無關，或資料中沒有答案，只能回覆：「${OUT_OF_SCOPE}」`,
    "回答使用繁體中文，語氣專業、簡潔，避免誇大或補充未提供的事實。",
    "不要回答天氣、新聞、財經、醫療、法律、政治、閒聊或其他與履歷無關的問題。"
  ].join("\n");
}

function buildUserPrompt(message, chunks) {
  const context = chunks
    .map((chunk) => `【${chunk.title}】\n${chunk.content}`)
    .join("\n\n");

  return [
    `使用者問題：${message}`,
    "",
    "可使用的履歷資料：",
    context,
    "",
    "請直接回答使用者問題；如果問題超出履歷範圍，請回覆指定的超出範圍句。"
  ].join("\n");
}

async function callGemini(message, chunks) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error("Missing GEMINI_API_KEY");
    error.statusCode = 503;
    throw error;
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    MODEL
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: buildSystemPrompt() }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserPrompt(message, chunks) }]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 360
      }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini request failed: ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  const data = await response.json();
  const answer = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  return answer || OUT_OF_SCOPE;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ answer: OUT_OF_SCOPE });
    return;
  }

  const body = getRequestBody(req);
  const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_LENGTH);

  if (!message) {
    res.status(400).json({ answer: "請輸入想詢問的履歷問題。" });
    return;
  }

  const chunks = retrieveChunks(message);
  if (!chunks.length) {
    res.status(200).json({ answer: OUT_OF_SCOPE, source: "scope_guard" });
    return;
  }

  try {
    const answer = await callGemini(message, chunks);
    res.status(200).json({
      answer,
      source: "gemini",
      sourceIds: chunks.map((chunk) => chunk.id)
    });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.status(statusCode).json({
      answer: "AI 回覆服務尚未完成設定，已保留本機履歷問答備援。",
      source: "fallback_required"
    });
  }
};
