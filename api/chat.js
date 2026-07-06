const knowledge = require("../data/portfolio_knowledge.json");

const OUT_OF_SCOPE =
  knowledge.profile?.outOfScopeAnswer ||
  "這不在我能回答的範圍內。請問還有什麼想要諮詢的嗎？";
const PREFERRED_MODEL = process.env.GEMINI_MODEL || process.env.gemini_model || "";
const DEFAULT_MODEL_CANDIDATES = [
  "gemini-3.1-flash-lite",
  "gemini-flash-latest",
  "gemini-3.5-flash",
  "gemini-2.5-flash"
];
const MAX_MESSAGE_LENGTH = 500;
const DEFAULT_MAX_OUTPUT_TOKENS = 360;
const REWRITE_MAX_OUTPUT_TOKENS = 220;

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
    "請用自然、親切又專業的口吻回答，重點清楚即可，不要一次把所有履歷內容都說完。",
    "務必只根據下方『履歷資料』作答，不要捏造或補充資料中沒有的事實；資料有寫的可以延伸說明，資料沒寫的就不要編。",
    "回答範圍限於陳勇學的履歷、經歷、專案、作品、技能、成果與聯絡方式。",
    "如果使用者只是打招呼，請只用 1 句話自然回應，並提示可以詢問作品集或工作經歷，不要摘要履歷。",
    "若資料中確實沒有答案，就誠實說明目前資料未涵蓋，並主動引導對方詢問可回答的主題（工作經歷、AI 與自動化、WeCosplay 專案、活動企劃、聯絡方式等）。",
    "如果問題與陳勇學的履歷或作品集完全無關（例如天氣、新聞、財經、醫療、法律、政治、寫程式教學、日常閒聊等），請禮貌婉拒並把話題帶回，例如：「這部分我不太方便回答，我主要負責介紹陳勇學的經歷與作品，有什麼想了解的嗎？」",
    "一般回答控制在 1 到 3 句；只有使用者明確要求詳細說明時，才使用最多 3 個完整條列。",
    "前端會以純文字顯示回答，請不要使用 Markdown 粗體、標題語法或表格。",
    "每次回答都必須完整收尾，最後一句需以句號、問號或驚嘆號結束。",
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
    "請直接回答使用者問題；如果問題超出履歷範圍，請回覆指定的超出範圍句。",
    "請確保回答完整，不要以未完成的條列、標題、冒號或 Markdown 粗體標記結尾。",
    "除非使用者要求詳細說明，請用 120 字以內回答。"
  ].join("\n");
}

function buildRewritePrompt(message, chunks, draftAnswer) {
  const context = chunks
    .map((chunk) => `【${chunk.title}】\n${chunk.content}`)
    .join("\n\n");

  return [
    `使用者問題：${message}`,
    "",
    "可使用的履歷資料：",
    context,
    "",
    "上一版回答疑似中斷或格式未完成：",
    draftAnswer || "（無有效回答）",
    "",
    "請重新輸出一版完整、較短、自然的回答：",
    "- 80 到 140 字內。",
    "- 不要使用 Markdown 粗體標記。",
    "- 若使用條列，每一點都要是完整句子。",
    "- 不要停在標題、冒號、逗號或未完成句。",
    "- 最後一句必須完整收尾。"
  ].join("\n");
}

function extractGeminiResult(data) {
  const candidate = data.candidates?.[0];
  const answer = candidate?.content?.parts
    ?.map((part) => part.text || "")
    .join("")
    .trim();

  return {
    answer: answer || "",
    finishReason: candidate?.finishReason || ""
  };
}

function looksIncompleteAnswer(answer, finishReason) {
  const text = String(answer || "").trim();
  if (!text) return true;
  if ((text.match(/\*\*/g) || []).length % 2 === 1) return true;
  if (/[：:，,、；;]$/.test(text)) return true;
  if (!/[。！？!?…」』）)\].]$/.test(text)) return true;
  if (/(^|\n)\s*[-*]\s*(\*\*)?[^。！？!?]*$/.test(text) && !/[。！？!?]$/.test(text)) return true;
  if (/(包含|例如|如下|分別是|重點有)$/.test(text)) return true;
  if (/\*\*$/.test(text) && !/[。！？!?]$/.test(text)) return true;
  return false;
}

function getModelCandidates() {
  const envFallbacks = process.env.GEMINI_MODEL_FALLBACKS || process.env.gemini_model_fallbacks || "";
  return [
    PREFERRED_MODEL,
    ...envFallbacks.split(",").map((model) => model.trim()),
    ...DEFAULT_MODEL_CANDIDATES
  ].filter(Boolean).filter((model, index, models) => models.indexOf(model) === index);
}

async function requestGemini(apiKey, prompt, maxOutputTokens, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
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
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.45,
        maxOutputTokens,
        thinkingConfig: {
          thinkingLevel: "minimal"
        }
      }
    })
  });

  if (!response.ok) {
    const error = new Error(`Gemini request failed: ${response.status}`);
    error.statusCode = 502;
    throw error;
  }

  return { ...extractGeminiResult(await response.json()), model };
}

async function requestGeminiWithFallback(apiKey, prompt, maxOutputTokens) {
  let lastError;
  for (const model of getModelCandidates()) {
    try {
      return await requestGemini(apiKey, prompt, maxOutputTokens, model);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Gemini request failed");
}

async function callGemini(message, chunks) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.gemini_api_key;
  if (!apiKey) {
    const error = new Error("Missing GEMINI_API_KEY");
    error.statusCode = 503;
    throw error;
  }

  const firstResult = await requestGeminiWithFallback(apiKey, buildUserPrompt(message, chunks), DEFAULT_MAX_OUTPUT_TOKENS);
  if (!looksIncompleteAnswer(firstResult.answer, firstResult.finishReason)) {
    return firstResult;
  }

  const rewriteResult = await requestGeminiWithFallback(
    apiKey,
    buildRewritePrompt(message, chunks, firstResult.answer),
    REWRITE_MAX_OUTPUT_TOKENS
  );

  if (!looksIncompleteAnswer(rewriteResult.answer, rewriteResult.finishReason)) {
    return rewriteResult;
  }

  return { answer: "AI 回覆產生不完整，請再輸入一次問題。", model: rewriteResult.model || firstResult.model };
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
      answer: answer.answer || answer,
      source: "gemini",
      model: answer.model,
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
