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
import adminRoutes from "./src/routes/admins.js";
import devRoutes from "./src/routes/dev.js";
import { requireAdmin, requireDev } from "./src/middleware/auth.js";
import { isAccountUsernameShape } from "./src/services/credentials.js";
import { devUsername, usingDefaultDevLogin } from "./src/services/devAccess.js";
import {
  backfillBookLoanTotals,
  backfillTitleOrder,
} from "./src/models/Book.js";
import {
  backfillLoanPersonCodes,
  backfillPersonCodes,
  mergeLegacyAdminAccounts,
} from "./src/services/people.js";

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
app.use("/api/books", requireAdmin, express.json({ limit: "6mb" }));
// As rotas de gente aceitam a foto de perfil (data URI), pelo mesmo motivo e
// com o mesmo cuidado: limite maior, mas so depois de checar o login.
app.use("/api/admins", requireAdmin, express.json({ limit: "6mb" }));
app.use("/api/people", requireAdmin, express.json({ limit: "6mb" }));
// A tela de manutencao tambem cadastra e edita gente (com foto de perfil),
// entao precisa do mesmo limite - e, do mesmo jeito, so depois de conferir
// que quem esta chamando e a sessao de manutencao.
app.use("/api/dev", requireDev, express.json({ limit: "6mb" }));
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
app.use("/api/admins", adminRoutes);
// Tela de manutencao: login e senha de quem entra no painel. So a sessao do
// login reservado passa daqui (ver src/services/devAccess.js).
app.use("/api/dev", devRoutes);
app.use("/api/public", publicLimiter, publicRoutes);

// Rota nao encontrada
app.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

// Tratador de erros central
app.use((err, req, res, next) => {
  // Id malformado no endereco (ex.: /api/people/abc): e pedido errado, nao
  // falha do servidor. A mensagem do Mongoose fala de modelo e caminho
  // interno do banco, que nao interessam a quem chamou.
  if (err && err.name === "CastError") {
    console.error("Id inválido em " + req.originalUrl);
    return res
      .status(400)
      .json({ error: "Esse registro não existe (endereço inválido)." });
  }
  console.error(err);
  return res
    .status(err.status || 500)
    .json({ error: err.message || "Erro interno no servidor." });
});

const PORT = process.env.PORT || 4000;

// Avisos de configuracao, no inicio do log: o login da tela de manutencao
// (ver src/services/devAccess.js) e o unico caminho para dar e tirar acesso ao
// painel, e os valores padrao estao escritos no codigo.
function warnAboutDevLogin() {
  if (usingDefaultDevLogin()) {
    console.warn(
      "ATENÇÃO: a tela de manutenção está com o login padrão, que está escrito no código. " +
        "Defina DEV_USERNAME e DEV_PASSWORD no ambiente (no Render: Environment).",
    );
  }
  if (isAccountUsernameShape(devUsername())) {
    console.warn(
      'ATENÇÃO: DEV_USERNAME ("' +
        devUsername() +
        '") tem a forma de um login de conta. Ele é conferido antes do banco, ' +
        "então um administrador com esse mesmo login não conseguiria entrar. " +
        "Use algo que o cadastro não aceite, como /usuariomaster.",
    );
  }
}

/**
 * Preparos de banco ao iniciar. Cada um no seu try: a MUDANCA DE CASA DAS
 * CONTAS nao pode ficar de fora porque um acerto de ordenacao falhou antes
 * dela - sem ela, ninguem consegue entrar no painel.
 */
async function prepareDatabase() {
  const steps = [
    {
      what: "a ordem dos títulos",
      async run() {
        const fixed = await backfillTitleOrder();
        if (fixed) console.log("Ordem de título criada para " + fixed + " livro(s).");
      },
    },
    {
      what: "o contador de empréstimos dos livros",
      async run() {
        const counted = await backfillBookLoanTotals();
        if (counted)
          console.log(
            "Contador de empréstimos preenchido em " + counted + " livro(s).",
          );
      },
    },
    {
      // Antes da mudanca de casa das contas: numera quem ja existia, do mais
      // antigo para o mais novo.
      what: "o número das pessoas",
      async run() {
        const numbered = await backfillPersonCodes();
        if (numbered) console.log(numbered + " pessoa(s) numerada(s).");
      },
    },
    {
      what: "as contas de administrador",
      async run() {
        const { moved, skipped } = await mergeLegacyAdminAccounts();
        if (moved)
          console.log(
            moved + " conta(s) de administrador movida(s) para a ficha da pessoa.",
          );
        skipped.forEach((account) => {
          console.warn(
            'ATENÇÃO: o login "' +
              account.username +
              '" não foi movido (' +
              account.reason +
              "). Quem precisar desse acesso recebe um login novo na tela de manutenção.",
          );
        });
      },
    },
    {
      what: "o número da pessoa nos empréstimos",
      async run() {
        const loansNumbered = await backfillLoanPersonCodes();
        if (loansNumbered)
          console.log(
            loansNumbered + " emprestimo(s) com o numero da pessoa preenchido.",
          );
      },
    },
  ];

  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      // Um passo que falha nao impede os outros nem o servidor de subir.
      console.error("Não foi possível preparar " + step.what + ":", error.message);
    }
  }
}

connectDatabase()
  .then(async () => {
    warnAboutDevLogin();
    await prepareDatabase();
    app.listen(PORT, () => {
      console.log("API rodando na porta " + PORT);
    });
  })
  .catch((error) => {
    console.error("Não foi possível conectar ao MongoDB:", error.message);
    process.exit(1);
  });
