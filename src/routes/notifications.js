import { Router } from "express";
import LoanRequest from "../models/LoanRequest.js";
import BookSuggestion from "../models/BookSuggestion.js";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import { OCCUPYING_REQUEST } from "../services/occupancy.js";

/**
 * SININHO DO PAINEL (canto direito do topo, ver frontend Layout.jsx).
 *
 * Dois assuntos:
 * - solicitacoes de emprestimo que esperam a retirada (Empréstimos >
 *   Solicitados). Contam na bolinha vermelha ENQUANTO existirem: so saem
 *   quando viram emprestimo ou sao excluidas.
 * - livros sugeridos (Configurações > Livros sugeridos). Contam na bolinha so
 *   os que ESTE administrador ainda nao viu: abrir a tela de sugestoes marca
 *   como vistos (POST /api/suggestions/seen). Cada administrador tem a sua
 *   marca (Person.suggestionsSeenAt).
 *
 * As janelas do sininho mostram os dois assuntos sempre; o "visto" so muda a
 * contagem da bolinha.
 */
const router = Router();
router.use(requireAdmin);

// GET /api/notifications
// -> { requests: n, suggestions: { total, unseen } }
router.get("/", async (req, res, next) => {
  try {
    const me = await Person.findById(req.user.id).select("suggestionsSeenAt").lean();
    const seenAt = me?.suggestionsSeenAt || null;
    const [requests, total, unseen] = await Promise.all([
      LoanRequest.countDocuments({ status: { $in: OCCUPYING_REQUEST } }),
      BookSuggestion.countDocuments(),
      seenAt
        ? BookSuggestion.countDocuments({ createdAt: { $gt: seenAt } })
        : BookSuggestion.countDocuments(),
    ]);
    res.set("Cache-Control", "no-store");
    return res.json({ requests, suggestions: { total, unseen } });
  } catch (error) {
    return next(error);
  }
});

export default router;
