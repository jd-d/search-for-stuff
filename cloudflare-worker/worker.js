const TOKEN_TTL_SECONDS = 3600; // 1 hour
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 60;
const LOGIN_RATE_LIMIT_REQUESTS = 10;

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  check(key) {
    if (!key) {
      return true;
    }
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart > this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }
}

const apiLimiter = new RateLimiter(RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);
const loginLimiter = new RateLimiter(LOGIN_RATE_LIMIT_REQUESTS, RATE_LIMIT_WINDOW_MS);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigin = env.ALLOWED_ORIGIN;

    if (request.method === "OPTIONS") {
      return handleOptions(request, allowedOrigin);
    }

    if (origin && allowedOrigin && origin !== allowedOrigin) {
      return withCors(new Response(JSON.stringify({ error: "Forbidden origin" }), {
        status: 403,
        headers: { "Content-Type": "application/json" }
      }), allowedOrigin);
    }

    switch (url.pathname) {
      case "/login":
        return await handleLogin(request, env, allowedOrigin);
      case "/check-instance":
        return await handleCheckInstance(request, env, allowedOrigin);
      case "/tweets":
        return await handleTweets(request, env, allowedOrigin);
      default:
        return withCors(new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        }), allowedOrigin);
    }
  }
};

function handleOptions(request, allowedOrigin) {
  const headers = {
    "Access-Control-Allow-Origin": allowedOrigin || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600"
  };
  return new Response(null, { status: 204, headers });
}

function withCors(response, allowedOrigin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin || "*");
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

async function handleLogin(request, env, allowedOrigin) {
  if (request.method !== "POST") {
    return withCors(jsonResponse({ error: "Method not allowed" }, 405), allowedOrigin);
  }

  const clientId = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "anonymous";
  if (!loginLimiter.check(clientId)) {
    return withCors(jsonResponse({ error: "Too many login attempts" }, 429), allowedOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch (error) {
    return withCors(jsonResponse({ error: "Invalid JSON" }, 400), allowedOrigin);
  }

  const { username = "", password = "" } = body;
  if (!timingSafeEqual(String(username), String(env.AUTH_USERNAME)) ||
      !timingSafeEqual(String(password), String(env.AUTH_PASSWORD))) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return withCors(jsonResponse({ error: "Invalid credentials" }, 401), allowedOrigin);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({ sub: username, iat: now, exp: now + TOKEN_TTL_SECONDS }, env.JWT_SECRET);

  return withCors(jsonResponse({ token, expiresIn: TOKEN_TTL_SECONDS }), allowedOrigin);
}

async function handleCheckInstance(request, env, allowedOrigin) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) {
    return withCors(jsonResponse(auth.body, auth.status), allowedOrigin);
  }

  const url = new URL(request.url);
  const instance = url.searchParams.get("url");
  if (!instance) {
    return withCors(jsonResponse({ error: "Missing url" }, 400), allowedOrigin);
  }

  const identifier = auth.tokenPayload?.sub || request.headers.get("cf-connecting-ip") || "anonymous";
  if (!apiLimiter.check(identifier)) {
    return withCors(jsonResponse({ error: "Rate limit exceeded" }, 429), allowedOrigin);
  }

  try {
    const probe = new URL(instance);
    let response = await fetch(probe.toString(), { method: "HEAD" });
    if (response.status === 405 || response.status === 501) {
      response = await fetch(probe.toString(), { method: "GET" });
    }
    if (!response.ok) {
      throw new Error(`Status ${response.status}`);
    }
    return withCors(jsonResponse({ ok: true }), allowedOrigin);
  } catch (error) {
    return withCors(jsonResponse({ ok: false, error: error.message }), allowedOrigin);
  }
}

async function handleTweets(request, env, allowedOrigin) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) {
    return withCors(jsonResponse(auth.body, auth.status), allowedOrigin);
  }

  const identifier = auth.tokenPayload?.sub || request.headers.get("cf-connecting-ip") || "anonymous";
  if (!apiLimiter.check(identifier)) {
    return withCors(jsonResponse({ error: "Rate limit exceeded" }, 429), allowedOrigin);
  }

  const url = new URL(request.url);
  const instance = url.searchParams.get("instance");
  let handle = url.searchParams.get("handle") || "";
  const count = clamp(Number(url.searchParams.get("count")) || 20, 1, 50);

  if (!instance) {
    return withCors(jsonResponse({ error: "Missing instance" }, 400), allowedOrigin);
  }
  if (!handle) {
    return withCors(jsonResponse({ error: "Missing handle" }, 400), allowedOrigin);
  }

  handle = handle.replace(/^@/, "");

  try {
    const tweets = await fetchTweetsFromInstance(instance, handle, count);
    return withCors(jsonResponse({ tweets }), allowedOrigin);
  } catch (error) {
    return withCors(jsonResponse({ error: error.message || "Failed to fetch tweets" }, 502), allowedOrigin);
  }
}

async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!tokenMatch) {
    return { ok: false, status: 401, body: { error: "Missing Authorization header" } };
  }

  const token = tokenMatch[1];
  try {
    const payload = await verifyToken(token, env.JWT_SECRET);
    return { ok: true, tokenPayload: payload };
  } catch (error) {
    return { ok: false, status: 401, body: { error: error.message || "Invalid token" } };
  }
}

async function fetchTweetsFromInstance(instance, handle, count) {
  const base = instance.replace(/\/$/, "");
  const rssUrl = `${base}/${handle}/rss`; // Nitter RSS endpoint
  const headers = { "User-Agent": "nitter-analytics-worker/1.0" };

  const rssResponse = await fetch(rssUrl, { headers });
  if (rssResponse.ok) {
    const text = await rssResponse.text();
    const tweets = parseRss(text, count);
    if (tweets.length) {
      return tweets;
    }
  }

  const htmlUrl = `${base}/${handle}`;
  const htmlResponse = await fetch(htmlUrl, { headers });
  if (!htmlResponse.ok) {
    throw new Error(`Instance returned ${htmlResponse.status}`);
  }
  const html = await htmlResponse.text();
    const tweets = parseTimelineHtml(html, count, base);
  if (!tweets.length) {
    throw new Error("No tweets found");
  }
  return tweets;
}

function parseRss(xml, count) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, "application/xml");
    const items = Array.from(doc.querySelectorAll("item")).slice(0, count);
    return items.map((item) => {
      const link = textContent(item, "link");
      const id = extractTweetId(link);
      const description = textContent(item, "description");
      const stats = extractStats(description);
      const title = textContent(item, "title");
      return {
        id,
        url: link,
        text: extractTweetText(description, title),
        time: textContent(item, "pubDate"),
        ...stats
      };
    });
  } catch (error) {
    return [];
  }
}

function parseTimelineHtml(html, count, instance) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const items = Array.from(doc.querySelectorAll(".timeline-item")).slice(0, count);
    return items.map((item) => {
      const linkEl = item.querySelector("a.status-link");
      const link = linkEl ? new URL(linkEl.getAttribute("href"), ensureTrailingSlash(instance)).toString() : "";
      const id = extractTweetId(link);
      const content = item.querySelector(".tweet-content");
      const stats = extractStats(item.querySelector(".tweet-stats")?.innerHTML || "");
      return {
        id,
        url: link,
        text: (content?.textContent || "").trim(),
        time: item.querySelector("span.tweet-date > a")?.getAttribute("title") || "",
        ...stats
      };
    });
  } catch (error) {
    return [];
  }
}

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function textContent(node, selector) {
  return node.querySelector(selector)?.textContent?.trim() || "";
}

function extractStats(html) {
  const stats = { replies: 0, retweets: 0, likes: 0 };
  if (!html) {
    return stats;
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html), "text/html");
  const textSources = new Set();
  if (doc.body?.textContent) {
    textSources.add(doc.body.textContent);
  }
  doc.querySelectorAll("[title]").forEach((el) => {
    textSources.add(el.getAttribute("title"));
  });
  doc.querySelectorAll("[aria-label]").forEach((el) => {
    textSources.add(el.getAttribute("aria-label"));
  });

  for (const text of textSources) {
    if (!text) continue;
    const replies = extractNumber(/Replies?:\s*(\d+)/i, text);
    const retweets = extractNumber(/Retweets?:\s*(\d+)/i, text);
    const likes = extractNumber(/Likes?:\s*(\d+)/i, text);
    if (replies !== null) stats.replies = replies;
    if (retweets !== null) stats.retweets = retweets;
    if (likes !== null) stats.likes = likes;
  }

  if (!stats.replies || !stats.retweets || !stats.likes) {
    const numbers = Array.from((doc.body?.textContent || "").matchAll(/\b(\d+)\b/g)).map((match) => Number(match[1]));
    if (numbers.length >= 3) {
      if (!stats.replies) stats.replies = numbers[0];
      if (!stats.retweets) stats.retweets = numbers[1];
      if (!stats.likes) stats.likes = numbers[2];
    }
  }

  return stats;
}

function extractNumber(regex, text) {
  const match = text.match(regex);
  return match ? Number(match[1]) : null;
}

function extractTweetText(description, title) {
  const htmlText = htmlToText(description);
  if (htmlText) {
    return htmlText;
  }
  if (title && title.includes(":")) {
    const candidate = title.slice(title.indexOf(":") + 1).trim();
    if (candidate) {
      return candidate;
    }
  }
  return title || "";
}

function htmlToText(html) {
  if (!html) return "";
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
    return doc.body.textContent?.replace(/\s+/g, " ").trim() || "";
  } catch (error) {
    return String(html);
  }
}

function extractTweetId(link) {
  if (!link) return "";
  try {
    const url = new URL(link);
    const segments = url.pathname.split("/").filter(Boolean);
    const statusIndex = segments.indexOf("status");
    if (statusIndex >= 0 && segments[statusIndex + 1]) {
      return segments[statusIndex + 1];
    }
    return segments[segments.length - 1] || "";
  } catch (error) {
    return "";
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function timingSafeEqual(a, b) {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < bufA.length; i += 1) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

async function signToken(payload, secret) {
  if (!secret) {
    throw new Error("JWT secret not configured");
  }
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSign(secret, data);
  return `${data}.${signature}`;
}

async function verifyToken(token, secret) {
  if (!secret) {
    throw new Error("JWT secret not configured");
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed token");
  }
  const [encodedHeader, encodedPayload, providedSignature] = parts;
  const data = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = await hmacSign(secret, data);
  if (!timingSafeEqual(providedSignature, expectedSignature)) {
    throw new Error("Invalid signature");
  }
  const payloadJson = decodeBase64Url(encodedPayload);
  const payload = JSON.parse(payloadJson);
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) {
    throw new Error("Token expired");
  }
  return payload;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return encodeBase64Url(signature);
}

function encodeBase64Url(value) {
  let buffer;
  if (typeof value === "string") {
    buffer = new TextEncoder().encode(value);
  } else {
    buffer = new Uint8Array(value);
  }
  let binary = "";
  buffer.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "===".slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}
