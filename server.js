import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const B = "https://api.mercadolibre.com";

async function ml(p, o = {}) {
  const t = process.env.ML_ACCESS_TOKEN;
  if (!t) {
    return {
      ok: false,
      status: 503,
      error: "Mercado Livre não conectado. Configure ML_ACCESS_TOKEN.",
    };
  }

  const r = await fetch(B + p, {
    ...o,
    headers: {
      Authorization: "Bearer " + t,
      ...(o.headers || {}),
    },
  });

  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data: d };
}

app.get("/api/health", (q, s) =>
  s.json({
    ok: true,
    integrations: {
      mercadoLivre: !!process.env.ML_ACCESS_TOKEN,
      shopee: !!(process.env.SHOPEE_API_URL && process.env.SHOPEE_API_KEY),
      ai: !!(process.env.AI_API_URL && process.env.AI_API_KEY),
    },
  })
);

app.get("/api/mercadolivre/trends", async (q, s) => {
  const r = await ml("/trends/MLB");
  if (!r.ok) return s.status(r.status || 503).json({ error: r.error || r.data });
  s.json(r.data);
});

app.get("/api/mercadolivre/search", async (q, s) => {
  const x = String(q.query.q || "").trim();
  if (!x) return s.status(400).json({ error: "Informe q." });

  const r = await ml("/sites/MLB/search?q=" + encodeURIComponent(x) + "&limit=20");
  if (!r.ok) return s.status(r.status || 503).json({ error: r.error || r.data });
  s.json(r.data);
});

app.post("/api/content", async (q, s) => {
  const { product, channel, kind } = q.body || {};

  if (!product?.title) {
    return s.status(400).json({ error: "Produto inválido." });
  }

  if (!process.env.AI_API_URL || !process.env.AI_API_KEY) {
    return s.status(503).json({
      error: "IA não conectada. Configure AI_API_URL e AI_API_KEY.",
    });
  }

  try {
    const r = await fetch(process.env.AI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + process.env.AI_API_KEY,
      },
      body: JSON.stringify({
        prompt:
          "Crie conteúdo de afiliado em português do Brasil, sem inventar informações. Produto: " +
          JSON.stringify(product) +
          " Canal: " +
          channel +
          " Tipo: " +
          kind,
      }),
    });

    const d = await r.json().catch(() => ({}));
    if (!r.ok) return s.status(r.status).json({ error: d });
    s.json(d);
  } catch (e) {
    s.status(500).json({ error: "Falha na conexão com a IA." });
  }
});

// Express 5 uses the named wildcard syntax below.
// Using app.get("*") causes a PathError during startup.
app.get("/{*splat}", (q, s) =>
  s.sendFile(path.join(__dirname, "public", "index.html"))
);

app.listen(PORT, () => console.log("Afiliados IA ativo na porta " + PORT));
