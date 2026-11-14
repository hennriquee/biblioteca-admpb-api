import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import Loan from '../models/Loan.js';
import LoanRequest from '../models/LoanRequest.js';
import Person from '../models/Person.js';
// (do robo, desligado em 12/11/2026: as respostas cadastradas e o entendimento de texto)
// import WaAnswer from '../models/WaAnswer.js';
import WaChat from '../models/WaChat.js';
import WaMessage from '../models/WaMessage.js';
// import WaUnknown from '../models/WaUnknown.js';
// import { fold as foldText } from '../services/whatsapp/intents.js';
// import { contentFindings } from '../services/whatsapp/policy.js';
import { requireAdmin } from '../middleware/auth.js';
import { normalizeText } from '../models/Book.js';
import { allWordsRegex, escapeRegex } from '../services/search.js';
import { registerCharge, undoCharge } from '../services/charges.js';
import { shortName } from '../services/people.js';
import { WhatsAppError, whatsapp } from '../services/whatsapp/service.js';
// import { bot, REQUEST_LINK } from '../services/whatsapp/bot.js'; // (robo desligado)
import { REQUEST_LINK } from '../services/whatsapp/requestLink.js';
import {
  assertFloorFree,
  endFloor,
  FloorError,
  floorStatus,
  lockSendTurn,
  noteActivity,
} from '../services/whatsapp/floor.js';
import { refreshLastMessage, resolveChat, saveMessage } from '../services/whatsapp/store.js';
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
 * - NAO existe rota para desconectar o WhatsApp: o numero fica fixo. So da
 *   para apagar a sessao quando ela ja quebrou (/recover-session);
 * - envio com limite por administrador (e um teto diario geral).
 */

const MAX_TEXT = 4096;
const MAX_CHANGES = 300;

const router = Router();
router.use(requireAdmin);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  // CONEXAO SOB DEMANDA (service.js): um administrador usando as Conversas
  // mantem o WhatsApp conectado (e o acorda, se estava dormindo). A consulta
  // de status SEM ?active=1 e a bolinha de nao lidas das outras telas: essa
  // nao conta como "usando".
  const background = req.method === 'GET' && req.path === '/status' && req.query.active !== '1';
  if (!background) whatsapp.touch();
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
// Conectar fala com os servidores do WhatsApp (abrir a tela sem conexao ja
// pede o QR, entao o limite e folgado).
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
    // "bot" | "overdue" | "handoff": mensagem que o proprio sistema mandou.
    auto: message.auto || '',
    errorCode: message.status === 0 ? message.errorCode || '' : '',
  };
}

// Mensagem com o link de uma solicitacao do acervo publico (/solicitacao/<id>):
// leva junto em que pe ela esta, para a conversa mostrar o botao "Aprovar".
// request = { token, state: "pending" | "registered" | "gone", bookTitle,
// personName }. (O link ja esta no texto da mensagem; o painel e so de
// administrador.)
async function withRequests(dtos) {
  const tokens = new Map();
  for (const dto of dtos) {
    const match = dto.kind === 'text' && dto.text ? dto.text.match(REQUEST_LINK) : null;
    if (match) tokens.set(dto._id, match[1]);
  }
  if (!tokens.size) return dtos;
  const found = await LoanRequest.find({ token: { $in: [...new Set(tokens.values())] } })
    .select('token status bookTitle personName')
    .lean();
  const byToken = new Map(found.map((request) => [request.token, request]));
  return dtos.map((dto) => {
    const token = tokens.get(dto._id);
    if (!token) return dto;
    const request = byToken.get(token);
    return {
      ...dto,
      request: {
        token,
        state: !request ? 'gone' : request.status === 'pendente' ? 'pending' : 'registered',
        bookTitle: request?.bookTitle || '',
        personName: request?.status === 'pendente' ? '' : request?.personName || '',
      },
    };
  });
}

// ---- Do robo, desligado em 12/11/2026 (os campos sairam do banco) ----
// O robo esta quieto nesta conversa agora? (o modo humano vence sozinho)
// function attendanceOf(chat) {
//   const until = chat.humanUntil ? new Date(chat.humanUntil) : null;
//   const human = chat.mode === 'human' && until && until.getTime() > Date.now();
//   return {
//     mode: human ? 'human' : 'bot',
//     until: human ? until : null,
//     waiting: Boolean(human && chat.handoffAt),
//     waitingSince: human && chat.handoffAt ? chat.handoffAt : null,
//     reason: human && chat.handoffAt ? (chat.handoffReason === 'request' ? 'request' : 'admin') : '',
//     muted: Boolean(!human && chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > Date.now()),
//   };
// }

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

// MENSAGENS TEMPORARIAS (services/whatsapp/retention.js): cada mensagem some
// do painel disappearDays dias depois de enviada. A limpeza roda de meia em
// meia hora; ate la, o que ja venceu nao aparece.
const DAY_MS = 24 * 60 * 60 * 1000;

function disappearMs() {
  const days = Number(whatsapp.config.disappearDays) || 0;
  return days > 0 ? days * DAY_MS : 0;
}

// Mensagem enviada antes disto ja sumiu (null = nada some).
function visibleFrom() {
  const ms = disappearMs();
  return ms ? new Date(Date.now() - ms) : null;
}

function chatDto(chat, people) {
  const list = (chat.phone && people.get(canonicalPhone(chat.phone))) || [];
  const person = list[0] || null;
  const ms = disappearMs();
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
    // attendance: attendanceOf(chat), // (robo desligado)
    // Dias ate cada mensagem sumir (0 = nunca) e quando a conversa inteira
    // some, se ninguem mais escrever (null = sem mensagens ou nunca).
    disappearDays: ms ? whatsapp.config.disappearDays : 0,
    expiresAt:
      ms && chat.lastMessageAt ? new Date(new Date(chat.lastMessageAt).getTime() + ms) : null,
  };
}

async function oneChatDto(chat) {
  return chatDto(chat, await peopleByChat([chat]));
}

function sendError(res, error) {
  // Uma conversa por vez (floor.js): outra conversa esta em andamento ou
  // acabou ha pouco. A tela mostra quem e ate quando.
  if (error instanceof FloorError) {
    return res.status(409).json({ error: error.message, code: error.code, floor: error.floor });
  }
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
  const from = visibleFrom();
  const [row] = await WaChat.aggregate([
    // (a conversa que ja sumiu da lista nao conta)
    ...(from ? [{ $match: { lastMessageAt: { $gte: from } } }] : []),
    { $group: { _id: null, total: { $sum: '$unread' } } },
  ]);
  return row?.total || 0;
}

// ---------- Ligacao ----------

// GET /api/whatsapp/status - situacao, QR (quando espera a leitura) e nao lidas
router.get('/status', readLimiter, async (req, res, next) => {
  try {
    return res.json({
      ...whatsapp.snapshot(),
      unread: await totalUnread(),
      // Uma conversa por vez (floor.js): com quem a biblioteca esta falando
      // agora, ou ate quando espera para a proxima (null = livre).
      floor: await floorStatus().catch(() => null),
      // Aquecimento e pausa do fiscal (policy.js): tetos do dia.
      protection: await whatsapp.policyStatus().catch(() => null),
    });
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

// POST /api/whatsapp/recover-session - SO com a sessao quebrada (ilegivel ou
// recusada pelo WhatsApp): apaga e mostra o QR de novo. Com a sessao boa, o
// servico recusa (409): nao ha como desconectar o numero pelo painel.
router.post('/recover-session', linkLimiter, async (req, res, next) => {
  try {
    const snapshot = await whatsapp.recoverBrokenSession();
    console.warn('WhatsApp: sessão quebrada apagada pelo painel por ' + req.account.fullName);
    return res.json(snapshot);
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
    // A conversa cuja ultima mensagem ja venceu sumiu (mesmo antes da limpeza).
    const from = visibleFrom();
    if (from) filter.lastMessageAt.$gte = from;

    const before = req.query.before ? new Date(String(req.query.before)) : null;
    if (before && !Number.isNaN(before.getTime())) {
      filter.lastMessageAt.$lt = before;
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
    // Mensagens que ja venceram (mensagens temporarias) nao aparecem.
    const from = visibleFrom();
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    if (since && !Number.isNaN(since.getTime())) {
      // Em ordem de alteracao: se passar de 300, devolve as 300 primeiras e
      // `now` passa a ser a alteracao da ultima (hasMore: o cliente pergunta de
      // novo na hora). Antes, o excedente nunca chegava a uma conversa aberta.
      // ("$gte": mensagens alteradas no mesmo instante nao ficam de fora; as
      // repetidas a tela descarta pelo id.)
      const changed = await WaMessage.find({
        chat: chat._id,
        updatedAt: { $gte: since },
        ...(from ? { at: { $gte: from } } : {}),
      })
        .sort({ updatedAt: 1 })
        .limit(MAX_CHANGES + 1)
        .lean();
      const truncated = changed.length > MAX_CHANGES;
      const page = truncated ? changed.slice(0, MAX_CHANGES) : changed;
      return res.json({
        messages: await withRequests(page.map(messageDto)),
        now: truncated ? page[page.length - 1].updatedAt : now,
        hasMore: truncated,
      });
    }

    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const filter = { chat: chat._id };
    if (from) filter.at = { $gte: from };
    const before = req.query.before ? new Date(String(req.query.before)) : null;
    // "ate" e nao "antes de": varias mensagens podem ter o mesmo segundo, e
    // pular a do limite as esconderia. A tela descarta as repetidas pelo id.
    if (before && !Number.isNaN(before.getTime())) filter.at = { ...filter.at, $lte: before };
    const page = await WaMessage.find(filter)
      .sort({ at: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = page.length > limit;
    const messages = page.slice(0, limit).reverse();
    return res.json({ messages: await withRequests(messages.map(messageDto)), now, hasMore });
  } catch (error) {
    return next(error);
  }
});

/**
 * A mensagem do painel com o nome de quem esta falando, em negrito, na
 * primeira linha: "*Bruno Henrique:*\nOlá...". O nome e o primeiro nome e o
 * primeiro sobrenome; com "de/da/do/das/dos" vai o seguinte tambem ("Maria da
 * Silva", nao "Maria da") - a mesma regra de shortName (services/people.js).
 * Sem nome (conta sem nome), sai so o texto.
 */
export function signedText(fullName, text) {
  const name = shortName(String(fullName || '').replace(/[*_~`]/g, ' '));
  return name ? '*' + name + ':*\n' + text : text;
}

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
        // Agora e "do painel": a previa da lista sai sem a linha do nome.
        await refreshLastMessage(chatId);
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
  // Uma conversa por vez (floor.js): a fila de envios, solta no fim (finally).
  let unlock = null;
  try {
    const raw = typeof req.body?.text === 'string' ? req.body.text : '';
    const typed = raw
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
    if (!typed) return res.status(400).json({ error: 'Escreva a mensagem.' });
    if (typed.length > MAX_TEXT) {
      return res
        .status(400)
        .json({ error: 'A mensagem passa de ' + MAX_TEXT + ' letras. Divida em duas.' });
    }

    const chat = await WaChat.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });

    // A pessoa ve quem esta falando: a mensagem sai com o nome do
    // administrador em negrito na primeira linha (ver signedText). E o que
    // vai e o que fica gravado (o painel mostra o mesmo que a pessoa recebeu).
    const text = signedText(req.account.fullName, typed);

    // Antes de mexer na cobranca: da para enviar agora?
    await whatsapp.assertCanSend();

    // UMA CONVERSA POR VEZ: um envio de cada vez; outra conversa em
    // andamento (ou que acabou ha pouco) recusa aqui, antes de registrar
    // cobranca ou enviar. A vez so e anotada depois que a mensagem sai.
    unlock = await lockSendTurn();
    await assertFloorFree({ chatId: chat._id });

    if (req.body?.chargeLoanId) {
      loanId = String(req.body.chargeLoanId);
      if (!mongoose.isValidObjectId(loanId)) {
        return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      }
      const loan = await Loan.findById(loanId).select('personPhone').lean();
      if (!loan) return res.status(404).json({ error: 'Empréstimo não encontrado.' });
      // A cobranca de um emprestimo so vale na conversa da pessoa dele.
      if (!samePhone(loan.personPhone, chat.phone)) {
        return res.status(409).json({ error: 'Essa cobrança é de outra pessoa. Abra a conversa dela.' });
      }
      charge = await registerCharge(loanId, req.account);
      if (!charge.ok) return res.status(charge.status).json(charge.body);
    }

    let sent;
    const startedAt = Date.now();
    try {
      // (um instante de "digitando…" antes; o fiscal confere tudo: policy.js)
      sent = await whatsapp.sendText(chat, text, { typing: 'panel' });
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
      // Sem resposta a tempo, a mensagem PODE ter saido: conta como conversa
      // em andamento (nao arrisca duas pessoas ao mesmo tempo).
      if (error?.code === 'SEND_TIMEOUT') {
        await noteActivity({ chatId: chat._id, byName: req.account.fullName, force: true }).catch(() => {});
      }
      throw error;
    }

    // Saiu: esta e a conversa em andamento a partir de agora.
    await noteActivity({ chatId: chat._id, byName: req.account.fullName, force: true }).catch((error) => {
      console.error('WhatsApp: não foi possível anotar a conversa em andamento:', error.message);
    });

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
        // A lista mostra o que foi digitado, sem o nome (o "Você:" ja diz).
        preview: typed,
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

    // (do robo, desligado em 12/11/2026: "um administrador respondeu, o
    // atendimento automatico fica quieto aqui" - nao ha mais robo para pausar)
    // await bot.humanTookOver(chat._id).catch((error) => {
    //   console.error('WhatsApp: não foi possível pausar o atendimento automático:', error.message);
    // });

    // (A conversa pode ter sido apagada do painel durante o envio: a mensagem
    // saiu do mesmo jeito, entao a resposta e de sucesso, sem a conversa.)
    const fresh = await WaChat.findById(chat._id).lean();
    return res.status(201).json({
      message: messageDto(message),
      loan: charge ? charge.loan : null,
      chat: fresh ? await oneChatDto(fresh) : null,
    });
  } catch (error) {
    return sendError(res, error) || next(error);
  } finally {
    unlock?.();
  }
});

// POST /api/whatsapp/floor/end { chatId? } - "Encerrar conversa": a conversa
// em andamento termina agora e o intervalo ate a proxima comeca a contar
// (floor.js). chatId: so encerra se a vez ainda for dessa conversa.
router.post('/floor/end', writeLimiter, async (req, res, next) => {
  try {
    const chatId = req.body?.chatId ? String(req.body.chatId) : null;
    if (chatId && !mongoose.isValidObjectId(chatId)) {
      return res.status(404).json({ error: 'Conversa não encontrada.' });
    }
    await endFloor({ chatId });
    return res.json({ floor: await floorStatus() });
  } catch (error) {
    return next(error);
  }
});

// ---- ATENDIMENTO AUTOMATICO (robo), DESLIGADO em 12/11/2026 ----
// Sem robo nao ha "assumir" nem "devolver ao atendimento automatico": toda
// conversa e de um administrador, pelo painel.
// // POST /api/whatsapp/chats/:id/attendance { mode: "human" | "bot" }
// // human: o administrador assume (o robo fica quieto por 12 h, renovadas a
// // cada resposta); bot: devolve a conversa ao atendimento automatico.
// router.post('/chats/:id/attendance', writeLimiter, async (req, res, next) => {
//   try {
//     const mode = req.body?.mode;
//     if (mode !== 'human' && mode !== 'bot') {
//       return res.status(400).json({ error: 'Escolha quem atende a conversa.' });
//     }
//     const chat = await WaChat.findById(req.params.id).select('_id').lean();
//     if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
//     if (mode === 'human') {
//       await bot.humanTookOver(chat._id);
//     } else {
//       await WaChat.updateOne(
//         { _id: chat._id },
//         {
//           $set: {
//             mode: 'bot',
//             humanUntil: null,
//             handoffAt: null,
//             botStep: '',
//             botData: null,
//             botAt: null,
//             // religar tambem desfaz o silencio do freio contra outro robo
//             botMutedUntil: null,
//             botWindowAt: null,
//             botWindowCount: 0,
//             botDayAt: null,
//             botDayCount: 0,
//           },
//         }
//       );
//     }
//     const fresh = await WaChat.findById(chat._id).lean();
//     if (!fresh) return res.status(404).json({ error: 'Conversa não encontrada.' });
//     return res.json({ chat: await oneChatDto(fresh) });
//   } catch (error) {
//     return next(error);
//   }
// });

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

// DELETE /api/whatsapp/chats/:id - apaga a conversa DO PAINEL (para todos os
// administradores): a conversa e as mensagens dela saem do banco. No celular
// da biblioteca e no da pessoa nada muda. Se a pessoa escrever de novo, a
// conversa volta, so com o que chegar dali em diante.
router.delete('/chats/:id', writeLimiter, async (req, res, next) => {
  try {
    // Apaga primeiro: dois pedidos ao mesmo tempo, so um apaga (e conta).
    const chat = await WaChat.findOneAndDelete({ _id: req.params.id }).select('_id').lean();
    if (!chat) return res.status(404).json({ error: 'Conversa não encontrada.' });
    // Os envios de hoje continuam contando nos tetos diarios (protecao do numero).
    await whatsapp.keepSendCounts(chat._id);
    const { deletedCount = 0 } = await WaMessage.deleteMany({ chat: chat._id });
    // Era a conversa em andamento (uma por vez): ela acabou.
    await endFloor({ chatId: chat._id }).catch(() => {});
    console.warn(
      'WhatsApp: conversa apagada do painel por ' +
        req.account.fullName +
        ' (' +
        deletedCount +
        (deletedCount === 1 ? ' mensagem).' : ' mensagens).')
    );
    return res.json({ ok: true, unread: await totalUnread() });
  } catch (error) {
    return next(error);
  }
});

// ---- DESLIGADO em 12/11/2026, junto com o robo ----
// As respostas cadastradas (wa_answers) e as perguntas sem resposta
// (wa_unknowns) SAIRAM DO BANCO (ver prepareDatabase em server.js).
// // ---------- Respostas do robo (a "base de conhecimento") ----------
// //
// // O administrador ensina o atendimento automatico: "quando a mensagem tiver
// // estas palavras-chave, responda isto" (models/WaAnswer.js). As perguntas que
// // o robo NAO soube responder ficam em wa_unknowns, para virarem respostas.
//
// const MAX_ANSWERS = 100;
// const MAX_KEYWORDS = 20;
// const MAX_VARIANTS = 5;
// const MAX_ANSWER_LENGTH = 900;
// // Sozinhas, estas palavras aparecem em quase toda mensagem: a resposta
// // "roubaria" qualquer conversa.
// // (uma expressao feita SO destas palavras - "o livro", "como faz" - tambem e
// // recusada: ela "sequestraria" pedidos como "quero renovar o livro")
// const TOO_GENERIC = new Set(
//   (
//     'a o e as os um uma uns umas de do da dos das em no na nos nas ao aos para pra pro por pelo pela com sem que se ' +
//     'eu tu ele ela nos vos eles elas voce voces vc vcs me te lhe meu minha meus minhas seu sua seus suas teu tua ' +
//     'esse essa este esta isso isto aquele aquela ai aqui la ja nao sim ok oi ola bom boa dia tarde noite ' +
//     'como qual quais quando quanto onde porque pq quem cade ' +
//     'quero queria pode posso tem tenho ter ser estar e foi vai vou fazer faz fiz preciso precisa gostaria saber sei ' +
//     'livro livros biblioteca obrigado obrigada mais muito pouco tudo nada algo alguem coisa coisas favor'
//   ).split(' ')
// );
//
// function answerDto(answer) {
//   return {
//     _id: answer._id,
//     title: answer.title,
//     keywords: answer.keywords || [],
//     answers: answer.answers || [],
//     enabled: answer.enabled !== false,
//     hits: answer.hits || 0,
//     lastHitAt: answer.lastHitAt || null,
//     updatedByName: answer.updatedByName || '',
//     updatedAt: answer.updatedAt,
//   };
// }
//
// // { title, keywords, answers, enabled } conferidos, ou { error }.
// function cleanAnswer(body) {
//   const title = typeof body?.title === 'string' ? body.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
//   if (!title) return { error: 'Dê um nome para a resposta (ex.: Horário de funcionamento).' };
//
//   const rawKeywords = Array.isArray(body?.keywords) ? body.keywords : [];
//   const keywords = [];
//   for (const item of rawKeywords) {
//     if (typeof item !== 'string') continue;
//     const keyword = foldText(item).slice(0, 40).trim();
//     if (!keyword || keywords.includes(keyword)) continue;
//     const words = keyword.split(' ');
//     if (words.length > 1 && words.every((word) => TOO_GENERIC.has(word))) {
//       return {
//         error:
//           'A expressão “' + keyword + '” só tem palavras comuns (apareceria em quase toda conversa). Inclua a palavra do assunto, como “horário” ou “estacionamento”.',
//       };
//     }
//     if (words.length === 1 && (keyword.length < 3 || TOO_GENERIC.has(keyword))) {
//       return {
//         error:
//           'A palavra-chave “' + keyword + '” é comum demais sozinha (apareceria em quase toda conversa). Use uma expressão, como “' + keyword + ' de funcionamento”.',
//       };
//     }
//     keywords.push(keyword);
//   }
//   if (!keywords.length) return { error: 'Informe pelo menos uma palavra-chave.' };
//   if (keywords.length > MAX_KEYWORDS) return { error: 'No máximo ' + MAX_KEYWORDS + ' palavras-chave por resposta.' };
//
//   const rawAnswers = Array.isArray(body?.answers) ? body.answers : [];
//   const answers = [];
//   for (const item of rawAnswers) {
//     if (typeof item !== 'string') continue;
//     const text = item
//       .replace(/\r\n?/g, '\n')
//       // eslint-disable-next-line no-control-regex
//       .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
//       .trim();
//     if (!text) continue;
//     if (text.length > MAX_ANSWER_LENGTH) {
//       return { error: 'Cada resposta pode ter até ' + MAX_ANSWER_LENGTH + ' letras.' };
//     }
//     const { blocks } = contentFindings(text);
//     if (blocks.length) return { error: blocks[0].msg };
//     if (!answers.includes(text)) answers.push(text);
//   }
//   if (!answers.length) return { error: 'Escreva a resposta.' };
//   if (answers.length > MAX_VARIANTS) return { error: 'No máximo ' + MAX_VARIANTS + ' jeitos de responder.' };
//
//   // (so desliga com false de verdade ou o texto "false")
//   const enabled = !(body?.enabled === false || String(body?.enabled).toLowerCase() === 'false');
//   return { title, keywords, answers, enabled };
// }
//
// const UNDERSTOOD_LABELS = {
//   stop: 'Pedido para parar de receber avisos',
//   resume: 'Pedido para voltar a receber avisos',
//   admin: 'Quer falar com um administrador',
//   bot: 'Perguntou se é um robô',
//   extend: 'Quer estender (renovar) um empréstimo',
//   loans: 'Quer ver os empréstimos / a data de devolução',
//   borrow: 'Quer saber como pegar um livro',
//   catalog: 'Quer ver o catálogo',
//   greeting: 'Cumprimento',
//   thanks: 'Agradecimento / despedida',
//   ack: '“Ok” (o robô não responde)',
// };
//
// // GET /api/whatsapp/answers - as respostas cadastradas e as perguntas sem resposta
// router.get('/answers', readLimiter, async (req, res, next) => {
//   try {
//     const [items, unknown] = await Promise.all([
//       WaAnswer.find().sort({ title: 1 }).limit(MAX_ANSWERS).lean(),
//       WaUnknown.find().sort({ count: -1, lastAt: -1 }).limit(40).lean(),
//     ]);
//     return res.json({
//       items: items.map(answerDto),
//       unknown: unknown.map((u) => ({ _id: u._id, text: u.text, count: u.count, lastAt: u.lastAt })),
//       smart: bot.config.smart !== false,
//       limits: { answers: MAX_ANSWERS, keywords: MAX_KEYWORDS, variants: MAX_VARIANTS, length: MAX_ANSWER_LENGTH },
//     });
//   } catch (error) {
//     return next(error);
//   }
// });
//
// // POST /api/whatsapp/answers/test { text } - o que o robo entenderia (sem enviar nada)
// router.post('/answers/test', writeLimiter, async (req, res, next) => {
//   try {
//     const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 400) : '';
//     if (!text.trim()) return res.status(400).json({ error: 'Escreva uma mensagem para testar.' });
//     bot.reloadAnswers();
//     const understood = await bot.understand(text);
//     const label =
//       understood.id === 'custom'
//         ? 'Resposta cadastrada: ' + (understood.entry?.title || '')
//         : understood.id
//           ? UNDERSTOOD_LABELS[understood.id] || understood.id
//           : understood.book
//             ? 'Busca no acervo por “' + understood.book + '”'
//             : 'Não entendeu (cairia no menu / “Não entendi”)';
//     return res.json({
//       understood: Boolean(understood.id || understood.book),
//       id: understood.id || (understood.book ? 'book' : ''),
//       label,
//       answer: understood.id === 'custom' ? understood.entry?.answers?.[0] || '' : '',
//       answerId: understood.id === 'custom' ? understood.entry?._id || null : null,
//     });
//   } catch (error) {
//     return next(error);
//   }
// });
//
// // POST /api/whatsapp/answers { title, keywords: [], answers: [], enabled? }
// router.post('/answers', writeLimiter, async (req, res, next) => {
//   try {
//     const clean = cleanAnswer(req.body);
//     if (clean.error) return res.status(400).json({ error: clean.error });
//     if ((await WaAnswer.countDocuments()) >= MAX_ANSWERS) {
//       return res.status(409).json({ error: 'Limite de ' + MAX_ANSWERS + ' respostas. Apague uma antes de criar outra.' });
//     }
//     const answer = await WaAnswer.create({ ...clean, updatedByName: req.account.fullName });
//     // Dois pedidos ao mesmo tempo podem passar da conta acima: confere depois
//     // de criar e desfaz o que passou do limite (o mais novo).
//     const overflow = await WaAnswer.find().sort({ createdAt: 1, _id: 1 }).skip(MAX_ANSWERS).select('_id').lean();
//     if (overflow.some((item) => String(item._id) === String(answer._id))) {
//       await WaAnswer.deleteOne({ _id: answer._id });
//       return res.status(409).json({ error: 'Limite de ' + MAX_ANSWERS + ' respostas. Apague uma antes de criar outra.' });
//     }
//     bot.reloadAnswers();
//     return res.status(201).json({ answer: answerDto(answer) });
//   } catch (error) {
//     return next(error);
//   }
// });
//
// function validId(value) {
//   return typeof value === 'string' && mongoose.isValidObjectId(value);
// }
//
// // PUT /api/whatsapp/answers/:answerId
// router.put('/answers/:answerId', writeLimiter, async (req, res, next) => {
//   try {
//     if (!validId(req.params.answerId)) return res.status(404).json({ error: 'Resposta não encontrada.' });
//     const clean = cleanAnswer(req.body);
//     if (clean.error) return res.status(400).json({ error: clean.error });
//     const answer = await WaAnswer.findOneAndUpdate(
//       { _id: req.params.answerId },
//       { $set: { ...clean, updatedByName: req.account.fullName } },
//       { new: true }
//     ).lean();
//     if (!answer) return res.status(404).json({ error: 'Resposta não encontrada.' });
//     bot.reloadAnswers();
//     return res.json({ answer: answerDto(answer) });
//   } catch (error) {
//     return next(error);
//   }
// });
//
// // DELETE /api/whatsapp/answers/:answerId
// router.delete('/answers/:answerId', writeLimiter, async (req, res, next) => {
//   try {
//     if (!validId(req.params.answerId)) return res.status(404).json({ error: 'Resposta não encontrada.' });
//     const gone = await WaAnswer.findOneAndDelete({ _id: req.params.answerId }).select('_id').lean();
//     if (!gone) return res.status(404).json({ error: 'Resposta não encontrada.' });
//     bot.reloadAnswers();
//     return res.json({ ok: true });
//   } catch (error) {
//     return next(error);
//   }
// });
//
// // DELETE /api/whatsapp/unknowns/:unknownId - tira uma pergunta da lista
// router.delete('/unknowns/:unknownId', writeLimiter, async (req, res, next) => {
//   try {
//     if (!validId(req.params.unknownId)) return res.status(404).json({ error: 'Pergunta não encontrada.' });
//     await WaUnknown.deleteOne({ _id: req.params.unknownId });
//     return res.json({ ok: true });
//   } catch (error) {
//     return next(error);
//   }
// });

export default router;
