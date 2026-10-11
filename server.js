import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { connectDatabase } from "./src/config/db.js";
import authRoutes from "./src/routes/auth.js";
import bookRoutes from "./src/routes/books.js";
import loanRoutes from "./src/routes/loans.js";
import peopleRoutes from "./src/routes/people.js";
import publicRoutes from "./src/routes/public.js";
import { requireAuth } from "./src/middleware/auth.js";
import { backfillTitleOrder } from "./src/models/Book.js";

const app = express();

// Render/Netlify ficam atras de proxy: isso faz o rate limit ler o IP certo.
app.set("trust proxy", 1);

const allowedOrigins = process.env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Requisicoes sem origin (Postman, health check do Render) sao liberadas.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origem não autorizada pelo CORS: " + origin));
    },
  }),
);

// A rota de livros aceita a foto da capa (data URI ~150 KB, ate 4 MB), por
// isso tem um limite maior. Vem antes do parser geral (1 MB) e so depois de
// checar o login, para ninguem sem token conseguir mandar corpos grandes.
app.use("/api/books", requireAuth, express.json({ limit: "6mb" }));
app.use(express.json({ limit: "1mb" }));

// Protecao contra tentativa de adivinhar a senha: 20 tentativas a cada 15 min.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas tentativas de login. Tente novamente em 15 minutos.",
  },
});

// Consulta publica do acervo (pagina /catalogo): unica parte da API sem login.
// So tem GET e so devolve dados do livro e contagens. Como qualquer pessoa
// pode chamar, tem limite por IP (folgado, porque uma sala inteira na mesma
// rede Wi-Fi aparece como um IP so).
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas consultas em pouco tempo. Aguarde um instante e tente de novo.",
  },
});

app.get("/", (req, res) => {
  res.json({ name: "Biblioteca ADMP Brasil API", status: "online" });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/api/auth/login", loginLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/books", bookRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/people", peopleRoutes);
app.use("/api/public", publicLimiter, publicRoutes);

// Rota nao encontrada
app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

// Tratador de erros central
app.use((err, req, res, next) => {
  console.error(err);
  res
    .status(err.status || 500)
    .json({ error: err.message || "Erro interno no servidor." });
});

const PORT = process.env.PORT || 4000;

connectDatabase()
  .then(async () => {
    try {
      const fixed = await backfillTitleOrder();
      if (fixed)
        console.log("Ordem de título criada para " + fixed + " livro(s).");
    } catch (error) {
      // Não impede o servidor de subir: no máximo a ordem fica menos precisa.
      console.error(
        "Não foi possível preparar a ordem dos títulos:",
        error.message,
      );
    }
    app.listen(PORT, () => {
      console.log("API rodando na porta " + PORT);
    });
  })
  .catch((error) => {
    console.error("Não foi possível conectar ao MongoDB:", error.message);
    process.exit(1);
  });
