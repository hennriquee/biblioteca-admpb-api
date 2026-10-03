import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { connectDatabase } from "./src/config/db.js";
import authRoutes from "./src/routes/auth.js";
import bookRoutes from "./src/routes/books.js";
import loanRoutes from "./src/routes/loans.js";
import peopleRoutes from "./src/routes/people.js";
import { requireAuth } from "./src/middleware/auth.js";

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
      return callback(new Error("Origem nao autorizada pelo CORS: " + origin));
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
  .then(() => {
    app.listen(PORT, () => {
      console.log("API rodando na porta " + PORT);
    });
  })
  .catch((error) => {
    console.error("Nao foi possivel conectar ao MongoDB:", error.message);
    process.exit(1);
  });
