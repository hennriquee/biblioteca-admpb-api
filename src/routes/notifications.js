import { Router } from "express";
import rateLimit from "express-rate-limit";
import AdminDevice from "../models/AdminDevice.js";
import LoanRequest from "../models/LoanRequest.js";
import BookSuggestion from "../models/BookSuggestion.js";
import Person from "../models/Person.js";
import { requireAdmin } from "../middleware/auth.js";
import { OCCUPYING_REQUEST } from "../services/occupancy.js";
import { getPushKeys, readEndpoint } from "../services/returnAlerts.js";
import { NOTIFY_KINDS, readKinds, saveDevice, sendTest } from "../services/adminPush.js";

/**
 * SININHO DO PAINEL (canto direito do topo, ver frontend Layout.jsx) e as
 * NOTIFICACOES DO APP de cada administrador (Configurações > Notificações).
 *
 * O sininho junta (desde 12/11/2026, com as Conversas, que o painel soma pela
 * contagem de nao lidas do WhatsApp):
 * - PEDIDOS NOVOS do acervo publico (solicitacao "pendente": a pessoa pediu,
 *   ninguem registrou ainda). Cada um com "Registrar solicitação" (o mesmo
 *   caminho do link da mensagem) e "Descartar";
 * - solicitacoes de emprestimo que esperam a retirada (Empréstimos >
 *   Solicitados). Contam na bolinha vermelha ENQUANTO existirem: so saem
 *   quando viram emprestimo ou sao excluidas.
 * - livros sugeridos (Configurações > Livros sugeridos). Contam na bolinha so
 *   os que ESTE administrador ainda nao viu: abrir a tela de sugestoes marca
 *   como vistos (POST /api/suggestions/seen). Cada administrador tem a sua
 *   marca (Person.suggestionsSeenAt).
 *
 * As janelas do sininho mostram os assuntos sempre; o "visto" so muda a
 * contagem da bolinha.
 */
const router = Router();
router.use(requireAdmin);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Pedidos novos mostrados no sininho (os mais recentes).
const MAX_PENDING = 30;
const PENDING_DAYS = 7;

// GET /api/notifications
// -> { requests: n, suggestions: { total, unseen }, pending: [pedido] }
// pedido = { _id, token, bookTitle, bookCover, requesterName, requesterIsNew,
// pickupDate, createdAt, waChat }. (O token e o do link: so administrador
// chega aqui, e com ele o "Registrar solicitação" abre ja preenchido.)
router.get("/", async (req, res, next) => {
  try {
    const me = await Person.findById(req.user.id).select("suggestionsSeenAt").lean();
    const seenAt = me?.suggestionsSeenAt || null;
    const [requests, total, unseen, pending] = await Promise.all([
      LoanRequest.countDocuments({ status: { $in: OCCUPYING_REQUEST } }),
      BookSuggestion.countDocuments(),
      seenAt
        ? BookSuggestion.countDocuments({ createdAt: { $gt: seenAt } })
        : BookSuggestion.countDocuments(),
      // (so os dos ultimos PENDING_DAYS dias: quem desistiu no meio nao fica
      // no sininho o mes inteiro; o link continua valendo 30 dias)
      LoanRequest.find({
        status: "pendente",
        linkExpiresAt: { $gt: new Date() },
        createdAt: { $gt: new Date(Date.now() - PENDING_DAYS * 24 * 60 * 60 * 1000) },
      })
        .select("token bookTitle bookCover requesterName requesterIsNew pickupDate createdAt waChat")
        .sort({ createdAt: -1, _id: -1 })
        .limit(MAX_PENDING)
        .lean(),
    ]);
    return res.json({
      requests,
      suggestions: { total, unseen },
      pending: pending.map((item) => ({
        _id: item._id,
        token: item.token,
        bookTitle: item.bookTitle,
        bookCover: item.bookCover || "",
        requesterName: item.requesterName || "",
        requesterIsNew: Boolean(item.requesterIsNew),
        pickupDate: item.pickupDate,
        createdAt: item.createdAt,
        waChat: item.waChat || null,
      })),
    });
  } catch (error) {
    return next(error);
  }
});

// ---------- Notificacoes do app (Configurações > Notificações) ----------

// Gravar aparelho e mandar teste: poucos por administrador.
const writeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => "notificacoes:" + String(req.account?._id || "sem-conta"),
  message: { error: "Muitas mudanças em pouco tempo. Aguarde alguns minutos." },
});
const testLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => "notificacoes-teste:" + String(req.account?._id || "sem-conta"),
  message: { error: "Muitos testes em pouco tempo. Aguarde alguns minutos." },
});

async function prefsOf(personId) {
  const [me, devices] = await Promise.all([
    Person.findById(personId).select("notify").lean(),
    AdminDevice.find({ person: personId })
      .select("label createdAt lastOkAt")
      .sort({ updatedAt: -1 })
      .lean(),
  ]);
  return {
    kinds: readKinds(me?.notify),
    devices: devices.map((d) => ({ _id: d._id, label: d.label || "Aparelho", createdAt: d.createdAt })),
  };
}

// GET /api/notifications/prefs -> { kinds: { requests, suggestions, messages },
// devices: [{ _id, label, createdAt }] } (os aparelhos DESTE administrador)
router.get("/prefs", async (req, res, next) => {
  try {
    return res.json(await prefsOf(req.account._id));
  } catch (error) {
    return next(error);
  }
});

// PUT /api/notifications/prefs { kinds: { requests?, suggestions?, messages? } }
// So muda o que veio (o resto fica como estava).
router.put("/prefs", writeLimiter, async (req, res, next) => {
  try {
    const raw = req.body?.kinds;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return res.status(400).json({ error: "Escolha o que quer receber." });
    }
    const set = {};
    for (const kind of NOTIFY_KINDS) {
      if (raw[kind] === undefined) continue;
      if (typeof raw[kind] !== "boolean") {
        return res.status(400).json({ error: "Escolha o que quer receber." });
      }
      set["notify." + kind] = raw[kind];
    }
    if (Object.keys(set).length) await Person.updateOne({ _id: req.account._id }, { $set: set });
    return res.json(await prefsOf(req.account._id));
  } catch (error) {
    return next(error);
  }
});

// GET /api/notifications/push/key -> { publicKey } (a mesma do acervo)
router.get("/push/key", async (req, res, next) => {
  try {
    const { publicKey } = await getPushKeys();
    return res.json({ publicKey });
  } catch (error) {
    return next(error);
  }
});

// POST /api/notifications/push { subscription } -> liga ESTE aparelho a conta
router.post("/push", writeLimiter, async (req, res, next) => {
  try {
    const device = await saveDevice(req.account._id, req.body?.subscription, req.get("user-agent"));
    if (!device) {
      return res.status(400).json({
        error:
          "Este navegador não conseguiu preparar as notificações. Tente de novo ou use outro navegador.",
      });
    }
    return res.status(201).json({ ok: true, ...(await prefsOf(req.account._id)) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/notifications/push/status { endpoint } -> { active }: este
// aparelho recebe as notificacoes DESTA conta?
router.post("/push/status", async (req, res, next) => {
  try {
    const endpoint = readEndpoint(req.body?.endpoint);
    if (!endpoint) return res.json({ active: false });
    const active = await AdminDevice.exists({ endpoint, person: req.account._id });
    return res.json({ active: Boolean(active) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/notifications/push/cancel { endpoint?, deviceId? } -> desliga um
// aparelho DESTA conta (este, pelo endereco, ou outro da lista, pelo id).
router.post("/push/cancel", writeLimiter, async (req, res, next) => {
  try {
    const endpoint = readEndpoint(req.body?.endpoint);
    const deviceId =
      typeof req.body?.deviceId === "string" && /^[a-f0-9]{24}$/i.test(req.body.deviceId)
        ? req.body.deviceId
        : null;
    if (!endpoint && !deviceId) return res.status(400).json({ error: "Aparelho inválido." });
    await AdminDevice.deleteOne({
      person: req.account._id,
      ...(endpoint ? { endpoint } : { _id: deviceId }),
    });
    return res.json({ ok: true, ...(await prefsOf(req.account._id)) });
  } catch (error) {
    return next(error);
  }
});

// POST /api/notifications/push/test -> manda uma notificacao de teste para os
// aparelhos DESTE administrador. -> { devices, sent }
router.post("/push/test", testLimiter, async (req, res, next) => {
  try {
    return res.json(await sendTest(req.account._id));
  } catch (error) {
    return next(error);
  }
});

export default router;
