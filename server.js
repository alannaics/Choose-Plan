import express from "express";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ML = "https://api.mercadolibre.com";
const ML_AUTH = "https://auth.mercadolivre.com.br/authorization";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function redirectUri(req) {
  return process.env.ML_REDIRECT_URI || `${req.protocol}://${req.get("host")}/auth/mercadolivre/callback`;
}

function key32() {
  return crypto.createHash("sha256").update(SESSION_SECRET).digest();
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key32(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64url");
}

function open(value) {
  try {
    const raw = Buffer.from(value, "base64url");
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key32(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || "")
      .split(";")
      .map(x => x.trim())
      .filter(Boolean)
      .map(x => {
        const i = x.indexOf("=");
        return i < 0 ? [x, ""] : [x.slice(0, i), decodeURIComponent(x.slice(i + 1))];
      })
  );
}

function setCookie(res, name, value, maxAge) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function clearCookie(res, name) {
  res.setHeader("Set-Cookie", `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
}

function configuredML() {
  return !!(process.env.ML_CLIENT_ID && process.env.ML_CLIENT_SECRET);
}

async function exchangeCode(code, req) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri(req)
  });
  const r = await fetch(`${ML}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || "Falha ao autorizar Mercado Livre.");
  return data;
}

async function accessToken(req, res) {
  const c = cookies(req);
  const session = c.ml_session ? open(c.ml_session) : null;
  if (!session) return null;

  let token;
  try { token = JSON.parse(session); } catch { return null; }

  if (token.access_token && token.expires_at > Date.now() + 60000) return token.access_token;
  if (!token.refresh_token) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: token.refresh_token
  });

  const r = await fetch(`${ML}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    clearCookie(res, "ml_session");
    return null;
  }

  const next = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || token.refresh_token,
    user_id: data.user_id || token.user_id,
    expires_at: Date.now() + Number(data.expires_in || 21600) * 1000
  };
  setCookie(res, "ml_session", seal(JSON.stringify(next)), 60 * 60 * 24 * 30);
  return next.access_token;
}

app.get("/auth/mercadolivre/start", (req, res) => {
  if (!configuredML()) {
    return res.status(503).send("Mercado Livre ainda não configurado no servidor. Defina ML_CLIENT_ID e ML_CLIENT_SECRET.");
  }

  const state = crypto.randomBytes(24).toString("hex");
  setCookie(res, "ml_oauth_state", seal(state), 600);

  const url = new URL(ML_AUTH);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", process.env.ML_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri(req));
  url.searchParams.set("state", state);

  res.redirect(url.toString());
});

app.get("/auth/mercadolivre/callback", async (req, res) => {
  const c = cookies(req);
  const expected = c.ml_oauth_state ? open(c.ml_oauth_state) : null;
  if (!req.query.code || !expected || expected !== String(req.query.state || "")) {
    return res.status(400).send("Autorização inválida. Volte ao Afiliados IA e tente novamente.");
  }

  try {
    const token = await exchangeCode(String(req.query.code), req);
    const session = {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      user_id: token.user_id,
      expires_at: Date.now() + Number(token.expires_in || 21600) * 1000
    };
    setCookie(res, "ml_session", seal(JSON.stringify(session)), 60 * 60 * 24 * 30);
    clearCookie(res, "ml_oauth_state");
    res.redirect("/?connected=mercadolivre");
  } catch (e) {
    res.status(502).send("Não foi possível concluir a conexão com o Mercado Livre: " + e.message);
  }
});

app.post("/auth/mercadolivre/disconnect", (req, res) => {
  clearCookie(res, "ml_session");
  res.json({ ok: true });
});

async function ml(req, res, p, o = {}) {
  const t = await accessToken(req, res);
  if (!t) return { ok: false, status: 401, error: "Mercado Livre não conectado." };

  const r = await fetch(ML + p, {
    ...o,
    headers: { Authorization: "Bearer " + t, ...(o.headers || {}) }
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}

app.get("/api/health", async (req, res) => {
  const t = await accessToken(req, res);
  res.json({
    ok: true,
    integrations: {
      mercadoLivre: !!t,
      mercadoLivreConfigured: configuredML(),
      shopee: !!(process.env.SHOPEE_API_URL && process.env.SHOPEE_API_KEY),
      ai: !!(process.env.AI_API_URL && process.env.AI_API_KEY)
    }
  });
});

app.get("/api/mercadolivre/trends", async (req, res) => {
  const r = await ml(req, res, "/trends/MLB");
  if (!r.ok) return res.status(r.status || 503).json({ error: r.error || r.data });
  res.json(r.data);
});

app.get("/api/mercadolivre/search", async (req, res) => {
  const x = String(req.query.q || "").trim();
  if (!x) return res.status(400).json({ error: "Informe q." });

  const r = await ml(req, res, "/sites/MLB/search?q=" + encodeURIComponent(x) + "&limit=20");
  if (!r.ok) return res.status(r.status || 503).json({ error: r.error || r.data });
  res.json(r.data);
});

app.post("/api/content", async (req, res) => {
  const { product, channel, kind } = req.body || {};
  if (!product?.title) return res.status(400).json({ error: "Produto inválido." });

  if (!process.env.AI_API_URL || !process.env.AI_API_KEY) {
    return res.status(503).json({ error: "IA não conectada. Configure a conexão de IA no servidor." });
  }

  try {
    const r = await fetch(process.env.AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.AI_API_KEY
      },
      body: JSON.stringify({
        prompt:
          "Crie conteúdo de afiliado em português do Brasil, sem inventar informações. Produto: " +
          JSON.stringify(product) + " Canal: " + channel + " Tipo: " + kind
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: d });
    res.json(d);
  } catch {
    res.status(500).json({ error: "Falha na conexão com a IA." });
  }
});

app.get("/{*splat}", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => console.log("Afiliados IA ativo na porta " + PORT));
