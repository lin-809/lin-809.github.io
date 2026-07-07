/**
 * Wandr AI 行程規劃 — Cloudflare Worker（含速率限制版）
 *
 * 部署方式：
 * 1. Cloudflare Dashboard → Workers & Pages → 你的 Worker（fragrant-bush-aaff）
 *    → Edit Code → 全選貼上這份程式碼 → Deploy
 * 2. 建立 KV（做速率限制用，免費方案即可）：
 *    Dashboard → Storage & Databases → KV → Create namespace，取名 WANDR_RATE
 *    → 回到 Worker → Settings → Bindings → Add → KV Namespace
 *    → Variable name 填 RATE_KV，Namespace 選 WANDR_RATE
 * 3. 確認 Settings → Variables and Secrets 裡已有 ANTHROPIC_API_KEY
 *    （你原本的 Worker 能動就代表已設好；若你原本用別的變數名稱，把下面的
 *      env.ANTHROPIC_API_KEY 改成你原本的名稱）
 *
 * 沒綁 KV 也能跑（只是不做限流），所以可以先貼程式碼再補 KV。
 */

// ── 可調整的設定 ──
const MODEL = "claude-opus-4-8";   // 想省成本可改 "claude-haiku-4-5"（品質略降、便宜約 5 倍）
const MAX_TOKENS = 8192;           // 行程 JSON 的輸出上限，兼顧成本
const PER_IP_HOURLY_LIMIT = 10;    // 每個 IP 每小時最多生成次數
const GLOBAL_DAILY_LIMIT = 300;    // 整個網站每天最多生成次數（保護你的帳單）
const MAX_PROMPT_CHARS = 8000;     // 單次請求的 prompt 長度上限（防灌爆）

// 允許呼叫這個 Worker 的來源（網站、Android APP WebView、iOS、本機開發）
const ALLOWED_ORIGINS = [
  "https://lin-809.github.io",
  "https://localhost",        // Capacitor Android APP
  "capacitor://localhost",    // Capacitor iOS APP
  "http://localhost:8091",    // 本機開發預覽
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// 回傳跟 Anthropic API 相同形狀的錯誤，前端會把 text 顯示給使用者
function friendlyError(message, status, origin) {
  return json({ content: [{ type: "text", text: message }], error: message }, status, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return friendlyError("Method not allowed", 405, origin);
    }
    // 只接受來自允許清單的網頁呼叫（curl 等無 Origin 的請求一律擋掉）
    if (!ALLOWED_ORIGINS.includes(origin)) {
      return friendlyError("Forbidden origin", 403, origin);
    }

    // ── 速率限制（有綁 RATE_KV 才會生效）──
    if (env.RATE_KV) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const hour = Math.floor(Date.now() / 3600_000);
      const day = Math.floor(Date.now() / 86_400_000);
      const ipKey = `rl:${ip}:${hour}`;
      const dayKey = `rl:global:${day}`;

      const [ipCount, dayCount] = await Promise.all([
        env.RATE_KV.get(ipKey).then((v) => parseInt(v, 10) || 0),
        env.RATE_KV.get(dayKey).then((v) => parseInt(v, 10) || 0),
      ]);

      if (ipCount >= PER_IP_HOURLY_LIMIT) {
        return friendlyError("⏳ 你這小時的免費生成次數已用完，請一小時後再試，或改用自己的 Gemini/ChatGPT API Key。", 429, origin);
      }
      if (dayCount >= GLOBAL_DAILY_LIMIT) {
        return friendlyError("🙏 今日全站免費額度已用完，請明天再來，或改用自己的 Gemini/ChatGPT API Key。", 429, origin);
      }

      await Promise.all([
        env.RATE_KV.put(ipKey, String(ipCount + 1), { expirationTtl: 3700 }),
        env.RATE_KV.put(dayKey, String(dayCount + 1), { expirationTtl: 90_000 }),
      ]);
    }

    // ── 驗證請求內容 ──
    let body;
    try {
      body = await request.json();
    } catch {
      return friendlyError("Invalid JSON", 400, origin);
    }
    const messages = body && body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return friendlyError("messages required", 400, origin);
    }
    const totalChars = messages.reduce((s, m) => s + String(m.content || "").length, 0);
    if (totalChars > MAX_PROMPT_CHARS) {
      return friendlyError("Prompt too long", 413, origin);
    }

    // ── 呼叫 Anthropic API ──
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: messages.map((m) => ({ role: m.role, content: String(m.content) })),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log("Anthropic API error", res.status, detail);
      if (res.status === 429 || res.status === 529) {
        return friendlyError("🚦 AI 目前忙碌中，請稍等一分鐘再試。", 429, origin);
      }
      return friendlyError("AI 服務暫時無法使用，請稍後再試。", 502, origin);
    }

    const data = await res.json();
    return json(data, 200, origin);
  },
};
