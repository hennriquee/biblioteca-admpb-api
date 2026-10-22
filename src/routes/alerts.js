import { Router } from "express";
import rateLimit from "express-rate-limit";
import ReturnAlert from "../models/ReturnAlert.js";
import {
  announceAvailability,
  bookAvailability,
  getPushKeys,
  MAX_ALERTS_PER_BOOK,
  MAX_ALERTS_PER_DEVICE,
  MAX_ALERTS_TOTAL,
  readBookId,
  readEndpoint,
  readSubscription,
  readTitle,
} from "../services/returnAlerts.js";

/**
 * "Avise-me quando voltar" do acervo publico (/catalogo). Rotas SEM LOGIN,
 * montadas em /api/public/alerts (ver server.js e services/returnAlerts.js).
 *
 * Sao as unicas rotas publicas que gravam alguma coisa, e por isso:
 * - so gravam pedidos de aviso, nunca mexem em livro ou emprestimo;
 * - nenhuma devolve dado de emprestimo (nem com quem esta o livro, nem quem
 *   mais pediu aviso): a resposta e "ok", "ativo ou nao" e a chave publica;
 * - consultar e cancelar exigem o endereco de notificacao do aparelho, que so
 *   o proprio aparelho conhece;
 * - tem limite de pedidos por IP (aqui e em server.js) e tetos de quantidade
 *   (ver MAX_ALERTS_* em services/returnAlerts.js).
 */
const router = Router();

// Pedir aviso grava no banco: limite proprio, mais curto que o das consultas.
// Folgado o bastante para uma sala inteira na mesma rede Wi-Fi (um IP so).
const subscribeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitos pedidos de aviso em pouco tempo. Aguarde alguns minutos e tente de novo.",
  },
});

const INVALID_BOOK = "Livro inválido.";
const INVALID_SUBSCRIPTION =
  "Este navegador não conseguiu preparar as notificações. Tente de novo ou use outro navegador.";

// GET /api/public/alerts/key
// Chave publica que o navegador precisa para criar a inscricao.
router.get("/key", async (req, res, next) => {
  try {
    const { publicKey } = await getPushKeys();
    res.set("Cache-Control", "no-cache");
    return res.json({ publicKey });
  } catch (error) {
    return next(error);
  }
});

// POST /api/public/alerts  { bookId, title, subscription }
// Pede o aviso deste aparelho para este livro. Pedir de novo so renova o
// pedido (um por aparelho e por livro). So vale para livro com todos os
// exemplares emprestados.
router.post("/", subscribeLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const bookId = readBookId(body.bookId);
    if (!bookId) return res.status(400).json({ error: INVALID_BOOK });
    const subscription = readSubscription(body.subscription);
    if (!subscription) {
      return res.status(400).json({ error: INVALID_SUBSCRIPTION });
    }

    const book = await bookAvailability(bookId);
    if (!book) {
      return res.status(404).json({ error: "Esse livro não está mais no acervo." });
    }
    if (!book.fullyLoaned) {
      return res.status(409).json({
        code: "BOOK_AVAILABLE",
        error:
          "Esse livro acabou de voltar para a estante. Procure a equipe da biblioteca para pegar emprestado.",
      });
    }

    const key = { book: book._id, endpoint: subscription.endpoint };
    // Renovar um pedido que ja existe nunca esbarra nos tetos.
    if (!(await ReturnAlert.exists(key))) {
      const [forDevice, forBook, total] = await Promise.all([
        ReturnAlert.countDocuments({ endpoint: subscription.endpoint }),
        ReturnAlert.countDocuments({ book: book._id }),
        ReturnAlert.estimatedDocumentCount(),
      ]);
      if (forDevice >= MAX_ALERTS_PER_DEVICE) {
        return res.status(429).json({
          error:
            "Este aparelho já tem " +
            MAX_ALERTS_PER_DEVICE +
            " avisos ativos. Cancele algum antes de pedir outro.",
        });
      }
      if (forBook >= MAX_ALERTS_PER_BOOK || total >= MAX_ALERTS_TOTAL) {
        return res.status(503).json({
          error: "Não foi possível ativar o aviso agora. Tente de novo mais tarde.",
        });
      }
    }

    try {
      await ReturnAlert.updateOne(
        key,
        {
          $set: {
            p256dh: subscription.p256dh,
            auth: subscription.auth,
            bookTitle: readTitle(body.title),
            // Pedido renovado comeca do zero na conta de falhas.
            failures: 0,
            // Renovar o pedido renova tambem o prazo de validade (TTL).
            createdAt: new Date(),
          },
        },
        { upsert: true },
      );
    } catch (error) {
      // Dois toques ao mesmo tempo: o outro gravou primeiro. O pedido existe,
      // que e o que importa.
      if (error.code !== 11000) throw error;
    }

    // A devolucao pode ter sido confirmada entre a conferencia la em cima e a
    // gravacao: o envio daquela devolucao ja passou e nao viu este pedido.
    // Conferindo de novo, a pessoa e avisada na hora em vez de ficar
    // esperando um livro que ja voltou.
    const now = await bookAvailability(book._id);
    if (now && !now.fullyLoaned) announceAvailability(book._id);

    return res.status(201).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// POST /api/public/alerts/status  { bookId, endpoint }
// Este aparelho ja pediu aviso deste livro? (POST, e nao GET, para o endereco
// de notificacao nao ficar gravado em log de endereco de pagina.)
router.post("/status", async (req, res, next) => {
  try {
    const body = req.body || {};
    const bookId = readBookId(body.bookId);
    const endpoint = readEndpoint(body.endpoint);
    if (!bookId || !endpoint) return res.status(400).json({ error: INVALID_BOOK });

    const active = Boolean(await ReturnAlert.exists({ book: bookId, endpoint }));
    res.set("Cache-Control", "no-store");
    return res.json({ active });
  } catch (error) {
    return next(error);
  }
});

// POST /api/public/alerts/cancel  { bookId, endpoint }
// Cancela o aviso deste aparelho para este livro. Cancelar o que nao existe
// tambem responde ok (o resultado e o mesmo: nao ha aviso).
router.post("/cancel", async (req, res, next) => {
  try {
    const body = req.body || {};
    const bookId = readBookId(body.bookId);
    const endpoint = readEndpoint(body.endpoint);
    if (!bookId || !endpoint) return res.status(400).json({ error: INVALID_BOOK });

    await ReturnAlert.deleteOne({ book: bookId, endpoint });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

// Endereco que nao existe aqui. Responde ja, em vez de seguir para as rotas
// do acervo (que contariam o mesmo pedido de novo no limite por IP).
router.use((req, res) => {
  res.status(404).json({ error: "Rota não encontrada." });
});

// Erro nesta area nunca mostra a mensagem interna (pode citar banco/consulta).
// O detalhe fica so no log do servidor.
router.use((err, req, res, next) => {
  console.error("[avisos]", err);
  res.status(503).json({
    error: "Os avisos estão indisponíveis agora. Tente de novo em instantes.",
  });
});

export default router;
