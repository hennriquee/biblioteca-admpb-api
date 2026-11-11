import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import Loan from '../models/Loan.js';
import Person from '../models/Person.js';
import WaChat from '../models/WaChat.js';
import WaMessage from '../models/WaMessage.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizeText } from '../models/Book.js';
import { allWordsRegex, escapeRegex } from '../services/search.js';
import { registerCharge, undoCharge } from '../services/charges.js';
import { WhatsAppError, whatsapp } from '../services/whatsapp/service.js';
import { resolveChat, saveMessage } from '../services/whatsapp/store.js';
import {
  canonicalPhone,
  digitsOf,
  phoneVariants,
  samePhone,
} from '../services/whatsapp/phone.js';

/**
 * Conversas do WhatsApp da biblioteca, dentro do painel (so administrador).
 * A ligacao com o WhatsApp mora em services/whatsapp/service.js.
 *
 * Regras de seguranca desta area:
 * - tudo exige administrador logado (a conta e conferida no banco a cada
 *   chamada) e nada daqui pode ser guardado em cache;
 * - NAO existe rota para escrever para um numero digitado: so se envia para
 *   uma conversa que ja existe ou para uma pessoa/emprestimo do cadastro;
 * - o numero que pode ser vinculado e o da biblioteca, definido no servidor;
 * - envio com limite por administrador (e um teto diario geral).
 */

const MAX_TEXT = 4096;
const MAX_CHANGES = 300;

const router = Router();
router.use(requireAdmin);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.param('id', (req, res, next, id) => {
  if (!mongoose.isValidObjectId(id)) {
    return res.status(404).json({ error: 'Conversa não encontrada.' });
  }
  return next();
});

// ---------- Limites (por administrador) ----------

function perAccount(max, windowMs, message) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => 'wa:' + String(req.account?._id || 'sem-conta'),
    message: { error: message },
  });
}

const readLimiter = perAccount(
  600,
  60 * 1000,
  'Muitas consultas em pouco tempo. Aguarde um instante.'
);
const writeLimiter = perAccount(
  120,
  60 * 1000,
  'Muitas ações em pouco tempo. Aguarde um instante.'
);
// Cada mensagem enviada e uma chance de o WhatsApp estranhar o numero.
const sendLimiter = perAccount(
  20,
  60 * 1000,
  'Você enviou muitas mensagens em pouco tempo. Aguarde um minuto.'
);
// Conectar e desconectar falam com os servidores do WhatsApp (abrir a tela
// sem conexao ja pede o QR, entao o limite e folgado).
const linkLimiter = perAccount(
  20,
  10 * 60 * 1000,
  'Muitas tentativas de conectar o WhatsApp. Aguarde alguns minutos.'
);
// O codigo de vinculacao faz o celular da biblioteca receber um aviso: poucos.
const codeLimiter = perAccount(
  6,
  10 * 60 * 1000,
  'Muitos códigos pedidos. Aguarde alguns minutos ou use o QR code.'
);

// ---------- Formato das respostas ----------

function messageDto(message) {
  return {
    _id: message._id,
    fromMe: message.fromMe,
    kind: message.kind,
    text: message.deleted ? '' : message.text,
    at: message.at,
    status: message.status,
    edited: Boolean(message.edited),
    deleted: Boolean(message.deleted),
    sentByName: message.sentByName || '',
    charge: Boolean(message.chargeLoan),
  };
}

// A ficha da pessoa de cada conversa e achada pelo telefone (o cadastro pode
// guardar o numero com ou sem o 9 de celular). Mesmo numero em varias fichas
// (familia): vale a mais antiga, e "shared" diz quantas mais existem.
async function peopleByChat(chats) {
  const variants = new Set();
  chats.forEach((chat) => phoneVariants(chat.phone).forEach((v) => variants.add(v)));
  const found = variants.size
    ? await Person.find({ phone: { $in: [...variants] } })
        .select('fullName code photo phone')
        .sort({ code: 1 })
        .lean()
    : [];
  const byKey = new Map();
  for (const person of found) {
    const key = canonicalPhone(person.phone);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(person);
  }
  return byKey;
}

function chatDto(chat, people) {
  const list = (chat.phone && people.get(canonicalPhone(chat.phone))) || [];
  const person = list[0] || null;
  return {
    _id: chat._id,
    phone: chat.phone || '',
    pushName: chat.pushName || '',
    person: person
      ? {
          _id: person._id,
          fullName: person.fullName,
          code: person.code ?? null,
          photo: person.photo || '',
        }
      : null,
    shared: Math.max(0, list.length - 1),
    lastMessageAt: chat.lastMessageAt,
    lastMessageText: chat.lastMessageText || '',
    lastMessageKind: chat.lastMessageKind || 'text',
    lastMessageFromMe: Boolean(chat.lastMessageFromMe),
    unread: chat.unread || 0,
  };
}

async function oneChatDto(chat) {
  return chatDto(chat, await peopleByChat([chat]));
}

function sendError(res, error) {
  if (error instanceof WhatsAppError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      whatsapp: whatsapp.snapshot().state,
      // Cobranca que ficou registrada (envio sem resposta a tempo): a tela mostra.
      ...(error.loan ? { loan: error.loan } : {}),
    });
  }
  return null;
}

async function totalUnread() {
  const [row] = await WaChat.aggregate([
    { $group: { _id: null, total: { $sum: '$unread' } } },
  ]);
  return row?.total || 0;
}

// ---------- Ligacao ----------

// GET /api/whatsapp/status - situacao, QR (quando espera a leitura) e nao lidas
router.get('/status', readLimiter, async (req, res, next) => {
  try {
    return res.json({ ...whatsapp.snapshot(), unread: await totalUnread() });
  } catch (error) {
    return next(error);
  }
});

// POST /api/whatsapp/connect - abre a conexao (mostra o QR se faltar a sessao)
router.post('/connect', linkLimiter, async (req, res, next) => {
  try {
    return res.json(await whatsapp.connect());
  } catch (error) {
    return next(error);
  }
});

// POST /api/whatsapp/pairing-code - codigo para digitar no celular, no lugar do QR
router.post('/pairing-code', codeLimiter, async (req, res, next) => {
  try {
    return res.json({ code: await whatsapp.requestPairingCode() });
  } catch (error) {
    return sendError(res, error) || next(error);
  }
});

// POST /api/whatsapp/disconnect - desvincula o aparelho e apaga a sessao
router.post('/disconnect', linkLimiter, async (req, res, next) => {
  try {
    console.warn('WhatsApp: desconectado pelo painel por ' + req.account.fullName);
    return res.json(await whatsapp.disconnect());
  } catch (error) {
    return sendError(res, error) || next(error);
  }
});

// ---------- Conversas ----------

// GET /api/whatsapp/chats?search=&before=ISO&limit=
router.get('/chats', readLimiter, async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 60));
    const filter = { lastMessageAt: { $ne: null } };

    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !Number.isNaN(before.getTime())) {
      filter.lastMessageAt = { $ne: null, $lt: before };
    }

    // Sem caracteres de controle: um byte nulo faz o banco recusar a busca.
    const search = normalizeText(String(req.query.search || ''))
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, 80);
    if (search) {
      const or = [{ pushNameSort: allWordsRegex(search) }];
      const digits = digitsOf(search);
      if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) });
      const people = await Person.find({ nameSort: allWordsRegex(search) })
        .select('phone')
        .limit(100)
        .lean();
      const keys = people.map((p) => canonicalPhone(p.phone)).filter(Boolean);
      if (keys.length) or.push({ key: { $in: keys } });
      filter.$or = or;
    }

    const chats = await WaChat.find(filter).sort({ lastMessageAt: -1 }).limit(limit).lean();
    const people = await peopleByChat(chats);
    return res.json({
      chats: chats.map((chat) => chatDto(chat, people)),
      hasMore: chats.length === limit,
    });
  } catch (error) {
    return next(error);
  }
});

// POST /api/whatsapp/chats { personId } | { loanId } - abre (ou cria) a conversa
// de uma pessoa do cadastro. Nunca de um numero digitado.
router.post('/chats', writeLimiter, async (req, res, next) => {
  try {
    const { personId, loanId } = req.body || {};
    let phone = '';

    if (loanId) {
      if (!mongoose.isValidObjectId(loanId)) {
        return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      }
      const loan = await Loan.findById(loanId).select('personPhone').lean();
      if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      phone = loan.personPhone;
      if (!phone) {
        return res
          .status(409)
          .json({ error: 'Esse empréstimo não tem WhatsApp cadastrado.' });
      }
    } else if (personId) {
      if (!mongoose.isValidObjectId(personId)) {
        return res.status(404).json({ error: 'Pessoa não encontrada.' });
      }
      const person = await Person.findById(personId).select('phone').lean();
      if (!person) return res.status(404).json({ error: 'Pessoa não encontrada.' });
      phone = person.phone;
      if (!phone) {
        return res.status(409).json({ error: 'Essa pessoa não tem WhatsApp no cadastro.' });
      }
    } else {
      return res.status(400).json({ error: 'Escolha uma pessoa do cadastro.' });
    }

    const chat = await resolveChat({ phone: digitsOf(phone) });
    if (!chat) {
      return res.status(409).json({ error: 'O WhatsApp cadastrado não é válido.' });
    }
    return res.status(201).json({ chat: await oneChatDto(chat) });
  } catch (error) {
    return next(error);
  }
});

// GET /api/whatsapp/chats/:id
router.get('/chats/:id', readLimiter, async (req, res, next) => {
  try {
    const chat = await WaChat.findById(req.params.id).lean();
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
    return res.json({ chat: await oneChatDto(chat) });
  } catch (error) {
    return next(error);
  }
});

// GET /api/whatsapp/chats/:id/messages?since=ISO | ?before=ISO&limit=
// - sem since: as mais recentes (before pagina para tras), da mais antiga a mais nova;
// - com since: so o que mudou depois disso (mensagem nova, entrega, edicao).
router.get('/chats/:id/messages', readLimiter, async (req, res, next) => {
  try {
    const chat = await WaChat.findById(req.params.id).select('_id').lean();
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });

    const now = new Date();
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    if (since && !Number.isNaN(since.getTime())) {
      // Em ordem de alteracao: se passar de 300, devolve as 300 primeiras e
      // `now` passa a ser a alteracao da ultima (hasMore: o cliente pergunta de
      // novo na hora). Antes, o excedente nunca chegava a uma conversa aberta.
      // ("$gte": mensagens alteradas no mesmo instante nao ficam de fora; as
      // repetidas a tela descarta pelo id.)
      const changed = await WaMessage.find({ chat: chat._id, updatedAt: { $gte: since } })
        .sort({ updatedAt: 1 })
        .limit(MAX_CHANGES + 1)
        .lean();
      const truncated = changed.length > MAX_CHANGES;
      const page = truncated ? changed.slice(0, MAX_CHANGES) : changed;
      return res.json({
        messages: page.map(messageDto),
        now: truncated ? page[page.length - 1].updatedAt : now,
        hasMore: truncated,
      });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter = { chat: chat._id };
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    // "ate" e nao "antes de": varias mensagens podem ter o mesmo segundo, e
    // pular a do limite as esconderia. A tela descarta as repetidas pelo id.
    if (before && !Number.isNaN(before.getTime())) filter.at = { $lte: before };
    const page = await WaMessage.find(filter)
      .sort({ at: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    return res.json({ messages: messages.map(messageDto), now, hasMore });
  } catch (error) {
    return next(error);
  }
});

// Depois de um envio sem resposta a tempo: se a mensagem apareceu (o WhatsApp
// avisa das mensagens enviadas), ela passa a valer como a cobranca; se nao
// apareceu, a cobranca e desfeita e o empréstimo pode ser cobrado de novo.
function checkAmbiguousCharge({ chatId, loanId, text, startedAt, charge, account }) {
  const timer = setTimeout(async () => {
    try {
      const echo = await WaMessage.findOne({
        chat: chatId,
        fromMe: true,
        text,
        at: { $gte: new Date(startedAt - 15000) },
      }).lean();
      if (echo) {
        await WaMessage.updateOne(
          { _id: echo._id },
          { $set: { chargeLoan: loanId, sentBy: account._id, sentByName: account.fullName } }
        );
      } else {
        await undoCharge(loanId, charge);
      }
    } catch (error) {
      console.error('WhatsApp: não foi possível conferir a cobrança sem resposta:', error.message);
    }
  }, whatsapp.config.ambiguousUndoMs);
  timer.unref?.();
}

// POST /api/whatsapp/chats/:id/messages { text, chargeLoanId? }
// chargeLoanId: e a cobranca de atraso desse emprestimo. A cobranca so conta se
// a mensagem sair: e registrada ANTES (a regra de uma a cada 30 dias vale no
// servidor) e desfeita se o envio falhar.
router.post('/chats/:id/messages', sendLimiter, async (req, res, next) => {
  let charge = null;
  let loanId = null;
  try {
    const raw = typeof req.body?.text === 'string' ? req.body.text : '';
    const text = raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
    if (!text) return res.status(400).json({ error: 'Escreva a mensagem.' });
    if (text.length > MAX_TEXT) {
      return res
        .status(400)
        .json({ error: 'A mensagem passa de ' + MAX_TEXT + ' letras. Divida em duas.' });
    }

    const chat = await WaChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });

    // Antes de mexer na cobranca: da para enviar agora?
    await whatsapp.assertCanSend();

    if (req.body?.chargeLoanId) {
      loanId = String(req.body.chargeLoanId);
      if (!mongoose.isValidObjectId(loanId)) {
        return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      }
      const loan = await Loan.findById(loanId).select('personPhone').lean();
      if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      // A cobranca de um emprestimo so vale na conversa da pessoa dele.
      if (!samePhone(loan.personPhone, chat.phone)) {
        return res
          .status(409)
          .json({ error: 'Essa cobrança é de outra pessoa. Abra a conversa dela.' });
      }
      charge = await registerCharge(loanId, req.account);
      if (!charge.ok) return res.status(charge.status).json(charge.body);
    }

    let sent;
    const startedAt = Date.now();
    try {
      sent = await whatsapp.sendText(chat, text);
    } catch (error) {
      if (charge && error?.code === 'SEND_TIMEOUT') {
        // O WhatsApp nao respondeu a tempo: a mensagem PODE ter saido. Desfazer
        // a cobranca agora faria quem tenta de novo cobrar duas vezes. Fica
        // registrada, e daqui a pouco confere se a mensagem apareceu.
        error.loan = charge.loan;
        checkAmbiguousCharge({ chatId: chat._id, loanId, text, startedAt, charge, account: req.account });
      } else if (charge) {
        await undoCharge(loanId, charge).catch((undoError) => {
          console.error('WhatsApp: não foi possível desfazer a cobrança:', undoError.message);
        });
        charge = null;
      }
      throw error;
    }

    // A mensagem JA saiu. Se o banco falhar agora, nao devolve erro (a pessoa
    // reenviaria): o proprio evento do WhatsApp grava a mensagem.
    let message;
    try {
      ({ message } = await saveMessage(chat, {
        waId: sent.waId,
        fromMe: true,
        kind: 'text',
        text,
        at: sent.at,
        status: 2,
        sentBy: req.account._id,
        sentByName: req.account.fullName,
        chargeLoan: charge ? loanId : null,
      }));
      await WaChat.updateOne(
        { _id: chat._id },
        { $set: { unread: 0, readAt: new Date() } }
      );
    } catch (saveError) {
      console.error('WhatsApp: mensagem enviada, mas não gravada agora:', saveError.message);
      message = {
        _id: new mongoose.Types.ObjectId(),
        fromMe: true,
        kind: 'text',
        text,
        at: new Date(sent.at),
        status: 2,
        sentByName: req.account.fullName,
        chargeLoan: charge ? loanId : null,
      };
    }

    return res.status(201).json({
      message: messageDto(message),
      loan: charge ? charge.loan : null,
    });
  } catch (error) {
    return sendError(res, error) || next(error);
  }
});

// POST /api/whatsapp/chats/:id/read - o administrador abriu a conversa
router.post('/chats/:id/read', writeLimiter, async (req, res, next) => {
  try {
    const chat = await WaChat.findById(req.params.id).lean();
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });

    const unread = chat.unread || 0;
    await WaChat.updateOne(
      { _id: chat._id },
      { $set: { unread: 0, readAt: new Date() } }
    );
    if (unread > 0) {
      const recent = await WaMessage.find({ chat: chat._id, fromMe: false })
        .sort({ at: -1 })
        .limit(Math.min(unread, 30))
        .select('waId')
        .lean();
      await whatsapp.sendReadReceipts(chat, recent.map((m) => m.waId));
    }
    return res.json({ ok: true, unread: await totalUnread() });
  } catch (error) {
    return next(error);
  }
});

export default router;
