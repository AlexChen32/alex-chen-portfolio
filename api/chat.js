const knowledge = require("../data/portfolio_knowledge.json");

const OUT_OF_SCOPE =
  knowledge.profile?.outOfScopeAnswer ||
  "這不在我能回答的範圍內。請問還有什麼想要諮詢的嗎？";
const MODEL = process.env.GEMINI_MODEL || process.env.gemini_model || "gemini-3.5-flash";
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
    "你是陳勇學個人作品集網站的 AI 客服助理，代表他接待訪客（多為人資與用人主管）。",
    "請用自然、親切又專業的口吻，像真人客服一樣把重點講清楚、講完整，而不是只回一句罐頭答案；可以適度整理、摘要、換句話說、依提問重點組織內容。",
    "務必只根據下方『履歷資料』作答，不要捏造或補充資料中沒有的事實；資料有寫的可以延伸說明，資料沒寫的就不要編。",
    "回答範圍限於陳勇學的履歷、經歷、專案、作品、技能、成果與聯絡方式。",
    "若資料中確實沒有答案，就誠實說明目前資料未涵蓋，並主動引導對方詢問可回答的主題（工作經歷、AI 與自動化、WeCosplay 專案、活動企劃、聯絡方式等）。",
    "如果問題與陳勇學的履歷或作品集完全無關（例如天氣、新聞、財經、醫療、法律、政治、寫程式教學、日常閒聊等），請禮貌婉拒並把話題帶回，例如：「這部分我不太方便回答，我主要負責介紹陳勇學的經歷與作品，有什麼想了解的嗎？」",
    "一律使用繁體中文，語氣友善、段落簡潔、重點清楚。"
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
  const apiKey = process.env.GEMINI_API_KEY || process.env.gemini_api_key;
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
        temperature: 0.55,
        maxOutputTokens: 640
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

  let chunks = retrieveChunks(message);
  if (!chunks.length) {
    chunks = (knowledge.chunks || []).slice(0, 6);
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
