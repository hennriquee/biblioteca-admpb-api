import { parsePhoneNumberFromString } from 'libphonenumber-js';
import Book from '../../models/Book.js';
import Loan from '../../models/Loan.js';
import LoanRequest from '../../models/LoanRequest.js';
import Person from '../../models/Person.js';
import ReturnAlert from '../../models/ReturnAlert.js';
import WaChat from '../../models/WaChat.js';
import { occupiedCount } from '../occupancy.js';
import { addDays, brDate, dayOf, todayInBrazil } from '../brDates.js';
import { phoneVariants, samePhone, digitsOf } from './phone.js';
import { resolveChat, saveMessage } from './store.js';
import { whatsapp as defaultWhatsapp } from './service.js';

/**
 * ATENDIMENTO AUTOMATICO do WhatsApp da biblioteca.
 *
 * Quem escreve para o numero da biblioteca recebe um menu numerado (o WhatsApp
 * nao mostra botoes nem listas para contas comuns conectadas como aparelho:
 * so contas da API oficial do WhatsApp Business. O menu numerado funciona em
 * qualquer celular):
 *
 *   1 - Conhecer o catalogo          -> o link do acervo publico
 *   2 - Emprestimos                  -> ver os ativos / estender a devolucao
 *   3 - Falar com um administrador   -> avisa o administrador pelo WhatsApp
 *
 * Regras:
 * - So conversa com UMA pessoa (grupos, status e canais ja ficam de fora em
 *   service.js) e so mensagem NOVA e recente (nada do historico).
 * - Conversa em ATENDIMENTO HUMANO (mode "human"): o robo fica quieto. Entra
 *   nesse modo quando a pessoa pede um administrador, quando alguem responde
 *   pelo painel ou pelo celular, ou pelo botao do painel. Volta ao robo pelo
 *   botao do painel ou sozinho, depois de HUMAN_HOURS sem mensagem da equipe.
 * - Resposta fora do esperado: "Nao entendi" + as opcoes de novo.
 * - Freio: no maximo MAX_REPLIES respostas por conversa a cada 10 minutos
 *   (evita conversa sem fim com outro robo, que poderia bloquear o numero).
 * - Uma pessoa por vez em cada conversa (fila por conversa): duas mensagens
 *   seguidas sao respondidas na ordem.
 */

export const BOT_NAME = 'Atendimento automático';
const EXTENSION_BY_NAME = 'WhatsApp (pedido do leitor)';

const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);

// O WhatsApp BRASILEIRO da biblioteca: para onde ia o "Combinar" do acervo
// publico antes do robo (modelo antigo, guardado como reserva: ver
// requestChannel abaixo) e quem recebe hoje o aviso de pedido de emprestimo.
export const LEGACY_REQUESTS_WHATSAPP = '5534984241556';

export function readBotConfig(env = process.env) {
  const site =
    String(env.PUBLIC_SITE_URL || '').trim() ||
    String(env.CORS_ORIGIN || '')
      .split(',')
      .map((origin) => origin.trim())
      .find((origin) => origin.startsWith('https://')) ||
    '';
  const days = Number(env.WHATSAPP_BOT_EXTENSION_DAYS);
  const max = Number(env.WHATSAPP_BOT_MAX_EXTENSIONS);
  return {
    enabled: !FALSY.has(String(env.WHATSAPP_BOT_ENABLED ?? '').trim().toLowerCase()),
    // Bruno Henrique: recebe o aviso de "quer falar com um administrador".
    adminPhone: digitsOf(env.WHATSAPP_ADMIN_NUMBER || '5534996560351'),
    // Recebe o aviso de PEDIDO DE EMPRESTIMO (o "Combinar" do acervo publico):
    // o WhatsApp brasileiro que recebia essas mensagens antes do robo.
    requestsAdminPhone: digitsOf(env.WHATSAPP_REQUESTS_ADMIN_NUMBER || LEGACY_REQUESTS_WHATSAPP),
    // "digitando…" antes de cada resposta: base + um pouco por letra, ate o teto.
    typingMs: FALSY.has(String(env.WHATSAPP_BOT_TYPING ?? '').trim().toLowerCase()) ? 0 : 1200,
    // "online": fica online so durante a resposta (ver setTyping em service.js).
    typingOnline: String(env.WHATSAPP_BOT_TYPING ?? '').trim().toLowerCase() === 'online',
    typingPerCharMs: 8,
    typingMaxMs: 3000,
    // Freio dos avisos de pedido de emprestimo: por conversa, em 24 h.
    maxRequestNoticesPerDay: 8,
    siteUrl: site.replace(/\/+$/, ''),
    // Quantos dias cada extensao pelo WhatsApp acrescenta a devolucao.
    extensionDays: Number.isInteger(days) && days > 0 && days <= 60 ? days : 7,
    // Quantas vezes a propria pessoa pode estender o mesmo emprestimo.
    maxExtensions: Number.isInteger(max) && max >= 0 && max <= 10 ? max : 2,
    // Sem resposta por este tempo, a proxima mensagem recomeca do "Ola".
    sessionMs: 30 * 60 * 1000,
    // Mensagem mais velha que isto (chegou com o servidor fora do ar) nao
    // recebe resposta automatica: ficaria fora de contexto.
    maxAgeMs: 6 * 60 * 60 * 1000,
    // Pedido de emprestimo atrasado ainda avisa o administrador ate isto.
    maxRequestAgeMs: 7 * 24 * 60 * 60 * 1000,
    humanMs: 12 * 60 * 60 * 1000,
    // Pedido de administrador sem resposta: o robo volta depois disto.
    handoffMs: 24 * 60 * 60 * 1000,
    windowMs: 10 * 60 * 1000,
    maxReplies: 15,
    // E no maximo isto em 24 h por conversa (gente de verdade nem chega perto).
    maxRepliesPerDay: 40,
    // Resposta fora das opcoes ate este tempo depois do robo: e rajada (a
    // pessoa ainda nao leu), fica sem "Nao entendi".
    burstMs: 10 * 1000,
    // Passou do freio: o robo fica mudo nessa conversa por este tempo.
    muteMs: 12 * 60 * 60 * 1000,
  };
}

// ---------- Textos ----------

// O numero da opcao como emoji (1️⃣, 2️⃣, 0️⃣...): digito + "️" + "⃣".
// Quem responde tocando no emoji tambem e entendido (ver KEYCAP).
export function key(n) {
  return String(n) + '️⃣';
}

const GREETING = 'Olá, aqui é da Biblioteca ADMP Brasil. 📚 Como posso ajudar?';

const MAIN_OPTIONS = [
  key(1) + ' Conhecer o catálogo',
  key(2) + ' Empréstimos',
  key(3) + ' Falar com um administrador',
].join('\n');

const REPLY_HINT = 'Responda com o número da opção.';
const BACK = key(0) + ' Voltar ao menu';
const BACK_HINT = 'Digite ' + key(0) + ' para voltar ao menu.';
const CONFIRM_OPTIONS = key(1) + ' Confirmar\n' + key(0) + ' Cancelar';
const NOT_UNDERSTOOD = 'Não entendi. Por favor, selecione uma opção válida.';

function mainMenu({ greet = false } = {}) {
  return (greet ? GREETING : 'Como posso ajudar?') + '\n\n' + MAIN_OPTIONS + '\n\n' + REPLY_HINT;
}

const LOANS_MENU =
  '*Empréstimos*\n\n' +
  key(1) +
  ' Ver meus empréstimos ativos\n' +
  key(2) +
  ' Estender a data de devolução\n' +
  BACK;

const HANDOFF_OPTIONS = key(1) + ' Falar com um administrador\n' + BACK;

function bold(text) {
  // O titulo vai entre asteriscos (negrito no WhatsApp): tira os asteriscos
  // dele para nao quebrar a formatacao.
  return '*' + String(text || '').replace(/[*_~`]/g, '').trim() + '*';
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function prettyPhone(value) {
  // O WhatsApp guarda alguns celulares brasileiros sem o 9 (553496560351):
  // para mostrar, usa a forma com o 9, que e a que as pessoas reconhecem.
  const digits =
    phoneVariants(value).find((v) => /^55\d{2}9\d{8}$/.test(v)) || digitsOf(value);
  const parsed = digits ? parsePhoneNumberFromString('+' + digits) : null;
  return parsed ? parsed.formatInternational() : digits ? '+' + digits : '';
}

// ---------- Entrada ----------

const KEYCAP = /([0-9])️?⃣/g;

function normalizeInput(text) {
  return String(text || '')
    .replace(KEYCAP, '$1')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * O que a pessoa escolheu: { digit } para um numero ("2", "2.", "opção 2",
 * "2️⃣"), { word } para "menu"/"voltar", ou {} (nao e uma opcao).
 */
export function parseChoice(text) {
  const value = normalizeInput(text);
  if (!value || value.length > 30) return {};
  const digit = value.match(/^(?:opcao|opc|op|numero|n)?\s*[#(]?\s*(\d{1,2})\s*[).:-]?\s*[.!]?$/);
  if (digit) return { digit: Number(digit[1]) };
  // A linha da opcao copiada inteira ("0️⃣ Voltar ao menu", "2️⃣ Estender a
  // data de devolução"): vale o numero do comeco.
  const line = value.match(
    /^(\d)\s*[-–.)]?\s*(conhecer|emprestimos|falar|ver|estender|voltar|confirmar|cancelar)\b/
  );
  if (line) return { digit: Number(line[1]) };
  const word = value.replace(/[^a-z ]/g, '').trim();
  if (['menu', 'inicio', 'menu principal', 'voltar', 'comecar', 'recomecar'].includes(word)) {
    return { word: 'menu' };
  }
  return {};
}

function words(text) {
  return normalizeInput(text).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Na confirmacao, "sim"/"nao" (e frases que comecam assim: "Sim, por favor",
// "pode sim", "não, obrigado") valem como 1/0.
function confirmWord(step, text, kind) {
  if (step !== 'confirm' || kind !== 'text') return undefined;
  const value = words(text);
  if (/^(nao|n|cancelar|cancela|cancele)\b/.test(value)) return 0;
  if (/^(sim|s|confirmo|confirmar|confirma|pode|ok|isso|quero)\b/.test(value)) return 1;
  return undefined;
}

// Pedido escrito por extenso no menu principal ("quero renovar meu livro",
// "falar com um atendente"): vale a opcao se so UMA delas aparece.
function mainWord(text) {
  const value = words(text);
  if (!value || value.length > 120) return 0;
  const hits = [];
  if (/\b(catalogo|acervo)\b/.test(value)) hits.push(1);
  if (/\b(emprestimos?|renovar|renovacao|estender|prorrogar|prazo|devolucao)\b/.test(value)) {
    hits.push(2);
  }
  if (/\b(administrador|atendente|humano|secretaria|responsavel)\b/.test(value)) hits.push(3);
  return hits.length === 1 ? hits[0] : 0;
}

// No menu de emprestimos, o pedido por extenso tambem vale.
function loansWord(text) {
  const value = words(text);
  if (!value || value.length > 120) return undefined;
  const extend = /\b(estender|renovar|renovacao|prorrogar|prazo|mais tempo|mais dias)\b/.test(value);
  const list = /\b(ver|listar|lista|quais|meus emprestimos)\b/.test(value);
  if (extend && !list) return 2;
  if (list && !extend) return 1;
  return undefined;
}

// ---------- Pedido de emprestimo do acervo publico ----------

// O link do fim da mensagem: /solicitacao/<id> (o id e o mesmo formato de
// TOKEN_PATTERN em routes/requests.js).
export const REQUEST_LINK = /\/solicitacao\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/;
// O texto pronto (utils/whatsapp.js no front, buildRequestMessage): vale
// mesmo sem o link (servidor fora do ar na hora do pedido).
const REQUEST_BOOK = /gostaria de pegar emprestado o livro\s*["“”]([^"“”\n]{1,200})["“”]/i;
const REQUEST_NAME = /meu nome [eé]\s+(.{2,80}?)\s+(\*?\(novo cadastro\)\*?\s+)?e gostaria de pegar emprestado/i;

// Texto que a PESSOA digitou (nome, titulo, nome do perfil) indo para um
// aviso mandado pelo numero da biblioteca: o aviso nao pode carregar um link
// "oficial" de golpe. Em vez de apagar (o que apagaria tambem "Vol.II" ou
// "Sr.Marcos"), DESARMA: tira "http://", "https://" e "www." e troca o ponto
// entre letras por "․" (U+2024, parecido, que o WhatsApp nao transforma em
// link). Antes, a formatacao do WhatsApp e as quebras viram espaco (senao
// "go_lpe.com" escaparia). Numa linha so.
export function typedText(value, max = 120) {
  return String(value || '')
    .replace(/[*_~`\n\r\t]/g, ' ')
    .replace(/(?:https?:\/\/|www\.)/gi, ' ')
    // (os pontos "orientais" tambem: alguns aparelhos os leem como ".")
    .replace(/([\p{L}\p{N}-])[.。．｡](?=[\p{L}\p{N}-])/gu, '$1․')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/**
 * { token, title, name, isNew } se a mensagem e um pedido de emprestimo do
 * acervo publico (pelo link ou pelo texto pronto), ou null.
 */
export function parseRequestMessage(text) {
  const value = String(text || '');
  if (!value || value.length > 3000) return null;
  const link = value.match(REQUEST_LINK);
  const book = value.match(REQUEST_BOOK);
  if (!link && !book) return null;
  const name = value.match(REQUEST_NAME);
  return {
    token: link ? link[1] : '',
    title: book ? book[1].trim() : '',
    name: name ? name[1].replace(/[*_~`]/g, '').trim() : '',
    isNew: Boolean(name?.[2]),
  };
}

// ---------- O robo ----------

export function createBot({ whatsapp, config: overrides = {}, now = () => Date.now() } = {}) {
  const cfg = { ...readBotConfig(), ...overrides };
  const lanes = new Map();
  let stop = null;

  // Uma fila por conversa: duas mensagens seguidas sao tratadas em ordem.
  function inLane(id, task) {
    const key = String(id);
    const previous = lanes.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    lanes.set(key, tail);
    tail.then(() => {
      if (lanes.get(key) === tail) lanes.delete(key);
    });
    return run;
  }

  /** Envia e grava uma mensagem do proprio sistema. */
  async function sendAutomatic(chat, text, auto = 'bot') {
    const sent = await whatsapp.sendText(chat, text, { auto });
    try {
      await saveMessage(chat, {
        waId: sent.waId,
        fromMe: true,
        kind: 'text',
        text,
        at: sent.at,
        status: 2,
        auto,
        sentByName: BOT_NAME,
      });
    } catch (error) {
      // Ja saiu: o eco do WhatsApp grava a mensagem de qualquer jeito.
      console.error('WhatsApp: resposta automática enviada, mas não gravada agora:', error.message);
    }
    return sent;
  }

  async function setStep(chat, step, data = null) {
    await WaChat.updateOne(
      { _id: chat._id },
      { $set: { botStep: step, botData: data, botAt: new Date(now()) } }
    );
  }

  // Freio: no maximo maxReplies respostas em 10 minutos e maxRepliesPerDay em
  // 24 h por conversa (um robo do outro lado que insiste devagar, uma vez por
  // minuto, nunca estoura a janela de 10 minutos, mas estoura a do dia).
  // So conta o que SAIU (envio que falhou nao gasta a cota). As respostas de
  // uma conversa sao uma de cada vez (fila), entao conferir e depois contar
  // nao corre.
  async function canReply(chat) {
    const fresh = await WaChat.findById(chat._id)
      .select('botWindowAt botWindowCount botDayAt botDayCount')
      .lean();
    if (!fresh) return false;
    const t = now();
    const inWindow = fresh.botWindowAt && t - new Date(fresh.botWindowAt).getTime() < cfg.windowMs;
    const inDay = fresh.botDayAt && t - new Date(fresh.botDayAt).getTime() < 24 * 60 * 60 * 1000;
    const full =
      (inWindow && fresh.botWindowCount >= cfg.maxReplies) ||
      (inDay && fresh.botDayCount >= cfg.maxRepliesPerDay);
    if (!full) return true;
    // Passou do freio: provavelmente outro robo do outro lado. O robo fica
    // MUDO nesta conversa por horas (senao voltaria a cada 10 minutos e uma
    // conversa so gastaria o teto diario de todo mundo). O painel mostra
    // "silenciado", e "Devolver ao atendimento automatico" religa.
    await WaChat.updateOne(
      { _id: chat._id },
      { $set: { botMutedUntil: new Date(t + cfg.muteMs) } }
    );
    return false;
  }

  async function countReply(chat) {
    const t = new Date(now());
    const windowStart = new Date(now() - cfg.windowMs);
    const dayStart = new Date(now() - 24 * 60 * 60 * 1000);
    await WaChat.updateOne({ _id: chat._id }, [
      {
        $set: {
          botWindowCount: {
            $cond: [{ $gt: [{ $ifNull: ['$botWindowAt', new Date(0)] }, windowStart] }, { $add: [{ $ifNull: ['$botWindowCount', 0] }, 1] }, 1],
          },
          botWindowAt: {
            $cond: [{ $gt: [{ $ifNull: ['$botWindowAt', new Date(0)] }, windowStart] }, '$botWindowAt', t],
          },
          botDayCount: {
            $cond: [{ $gt: [{ $ifNull: ['$botDayAt', new Date(0)] }, dayStart] }, { $add: [{ $ifNull: ['$botDayCount', 0] }, 1] }, 1],
          },
          botDayAt: {
            $cond: [{ $gt: [{ $ifNull: ['$botDayAt', new Date(0)] }, dayStart] }, '$botDayAt', t],
          },
        },
      },
    ]);
  }

  // "digitando…" na conversa por um instante antes da resposta, como uma
  // pessoa (mais tempo para texto maior, ate o teto). Sem conexao ou sem o
  // recurso (testes), segue direto.
  async function typeFirst(chat, text) {
    if (!cfg.typingMs || typeof whatsapp.setTyping !== 'function') return false;
    if (!(await whatsapp.setTyping(chat, true, { online: cfg.typingOnline }))) return false;
    const ms = Math.min(cfg.typingMaxMs, cfg.typingMs + String(text).length * cfg.typingPerCharMs);
    await new Promise((resolve) => setTimeout(resolve, ms));
    return true;
  }

  async function reply(chat, text) {
    if (!(await canReply(chat))) {
      console.warn('WhatsApp: atendimento automático silenciado numa conversa (muitas mensagens seguidas).');
      return false;
    }
    const typing = await typeFirst(chat, text);
    try {
      await sendAutomatic(chat, text, 'bot');
    } catch (error) {
      // A mensagem nao saiu: tira o "digitando…" (senao fica ate o WhatsApp
      // vencer o sinal sozinho).
      if (typing) whatsapp.setTyping(chat, false, { online: cfg.typingOnline }).catch(() => {});
      throw error;
    }
    // Saiu: a mensagem ja tira o "digitando…". No modo "online", volta a
    // "offline" (o celular volta a receber as notificacoes).
    if (typing && cfg.typingOnline) {
      whatsapp.setTyping(chat, false, { online: true }).catch(() => {});
    }
    await countReply(chat);
    return true;
  }

  // ---------- Emprestimos da pessoa ----------

  async function peopleOf(chat) {
    const variants = phoneVariants(chat.phone);
    if (!variants.length) return [];
    return Person.find({ phone: { $in: variants } }).select('_id fullName').lean();
  }

  async function activeLoansOf(chat, people) {
    const variants = phoneVariants(chat.phone);
    const or = [];
    if (people.length) or.push({ person: { $in: people.map((p) => p._id) } });
    if (variants.length) or.push({ personPhone: { $in: variants } });
    if (!or.length) return [];
    return Loan.find({ status: 'ativo', $or: or })
      .sort({ dueDate: 1, startDate: 1 })
      .limit(20)
      .lean();
  }

  function belongsTo(loan, chat, people) {
    if (!loan || loan.status !== 'ativo') return false;
    if (samePhone(loan.personPhone, chat.phone)) return true;
    return people.some((p) => String(p._id) === String(loan.person));
  }

  async function someoneWaiting(loan) {
    const [alerts, pending] = await Promise.all([
      ReturnAlert.countDocuments({ book: loan.book }),
      LoanRequest.countDocuments({ book: loan.book, status: 'pendente' }),
    ]);
    if (!alerts && !pending) return false;
    const book = await Book.findById(loan.book).select('copies').lean();
    if (!book) return false;
    const out = await occupiedCount(loan.book);
    return (book.copies || 1) - out <= 0;
  }

  /** Pode estender? { ok, from, to } ou { ok: false, reason }. */
  async function extensionCheck(loan) {
    const title = bold(loan.bookTitle);
    if (!loan.dueDate) {
      return { ok: false, reason: title + ' não tem data de devolução definida.' };
    }
    const today = todayInBrazil();
    const due = dayOf(loan.dueDate);
    if (today > due) {
      return {
        ok: false,
        reason:
          'Não é possível estender ' +
          title +
          ' por aqui: o prazo de devolução venceu em ' +
          brDate(due) +
          '.',
      };
    }
    const used = (loan.dueExtensions || []).filter((e) => e.via === 'whatsapp').length;
    if (used >= cfg.maxExtensions) {
      return {
        ok: false,
        reason:
          'O prazo de ' +
          title +
          ' já foi estendido pelo WhatsApp ' +
          (cfg.maxExtensions === 1 ? 'uma vez, o máximo permitido.' : cfg.maxExtensions + ' vezes, o máximo permitido.'),
      };
    }
    if (await someoneWaiting(loan)) {
      return {
        ok: false,
        reason: 'Não é possível estender ' + title + ': há leitores aguardando este livro.',
      };
    }
    return { ok: true, from: due, to: addDays(due, cfg.extensionDays) };
  }

  // whose: com o numero em mais de uma ficha (familia), diz de quem e.
  function loanLine(loan, whose = false) {
    const due = dayOf(loan.dueDate);
    const who = whose && loan.personName ? ' (' + firstName(loan.personName) + ')' : '';
    const head = '• ' + bold(loan.bookTitle) + who;
    if (!due) return head + ' – sem data de devolução definida';
    if (todayInBrazil() > due) return head + ' – devolução em atraso desde ' + brDate(due);
    return head + ' – devolução até ' + brDate(due);
  }

  function manyOwners(loans) {
    return new Set(loans.map((l) => String(l.person))).size > 1;
  }

  // ---------- Passos ----------

  async function showMain(chat, { greet = false, prefix = '' } = {}) {
    await setStep(chat, 'menu');
    await reply(chat, (prefix ? prefix + '\n\n' : '') + mainMenu({ greet }));
  }

  async function chooseMain(chat, option) {
    if (option === 1) {
      const link = cfg.siteUrl ? cfg.siteUrl + '/catalogo' : '';
      await setStep(chat, 'done');
      await reply(
        chat,
        (link
          ? 'Acesse o catálogo da biblioteca:\n' + link
          : 'O catálogo da biblioteca está disponível no site da biblioteca.') +
          '\n\n' +
          BACK_HINT
      );
      return;
    }
    if (option === 2) return openLoans(chat);
    if (option === 3) return handoff(chat);
    return showMain(chat, { prefix: NOT_UNDERSTOOD });
  }

  async function openLoans(chat, { prefix = '' } = {}) {
    const people = await peopleOf(chat);
    const loans = await activeLoansOf(chat, people);
    if (!people.length && !loans.length) {
      await setStep(chat, 'blocked');
      await reply(
        chat,
        'Não encontramos um cadastro vinculado a este número de WhatsApp.\n\n' + HANDOFF_OPTIONS
      );
      return;
    }
    if (!loans.length) {
      await setStep(chat, 'done');
      await reply(chat, 'Você não possui empréstimos ativos no momento.\n\n' + BACK_HINT);
      return;
    }
    await setStep(chat, 'loans');
    await reply(chat, (prefix ? prefix + '\n\n' : '') + LOANS_MENU);
  }

  async function listLoans(chat) {
    const people = await peopleOf(chat);
    const loans = await activeLoansOf(chat, people);
    if (!loans.length) return openLoans(chat);
    await setStep(chat, 'loans');
    await reply(
      chat,
      (loans.length === 1 ? 'Seu empréstimo ativo:' : 'Seus empréstimos ativos:') +
        '\n\n' +
        loans.map((loan) => loanLine(loan, manyOwners(loans))).join('\n') +
        '\n\n' +
        key(2) +
        ' Estender a data de devolução\n' +
        BACK
    );
  }

  async function startExtension(chat, { prefix = '' } = {}) {
    const people = await peopleOf(chat);
    const loans = await activeLoansOf(chat, people);
    if (!loans.length) return openLoans(chat);
    if (loans.length === 1) return offerExtension(chat, loans[0]);
    const shown = loans.slice(0, 9);
    await setStep(chat, 'pick-loan', { ids: shown.map((l) => String(l._id)) });
    await reply(
      chat,
      (prefix ? prefix + '\n\n' : '') +
        'Qual empréstimo deseja estender?\n\n' +
        shown
          .map(
            (loan, index) =>
              key(index + 1) + ' ' + loanLine(loan, manyOwners(shown)).slice(2)
          )
          .join('\n') +
        '\n' +
        BACK
    );
  }

  async function offerExtension(chat, loan) {
    const check = await extensionCheck(loan);
    if (!check.ok) {
      await setStep(chat, 'blocked');
      await reply(chat, check.reason + '\n\n' + HANDOFF_OPTIONS);
      return;
    }
    await setStep(chat, 'confirm', { id: String(loan._id), from: check.from, to: check.to });
    await reply(
      chat,
      'Confirma a extensão?\n\n' +
        bold(loan.bookTitle) +
        '\nDevolução atual: ' +
        brDate(check.from) +
        '\nNova devolução: ' +
        brDate(check.to) +
        '\n\n' +
        CONFIRM_OPTIONS
    );
  }

  async function confirmExtension(chat, data) {
    const people = await peopleOf(chat);
    const loan = data?.id ? await Loan.findById(data.id).lean() : null;
    if (!belongsTo(loan, chat, people)) {
      return openLoans(chat, { prefix: 'Este empréstimo não está mais ativo.' });
    }
    const check = await extensionCheck(loan);
    if (!check.ok) {
      await setStep(chat, 'blocked');
      await reply(chat, check.reason + '\n\n' + HANDOFF_OPTIONS);
      return;
    }
    if (check.from !== data.from || check.to !== data.to) {
      // O prazo mudou entre a pergunta e a resposta: pergunta de novo.
      return offerExtension(chat, loan);
    }
    const to = new Date(check.to + 'T00:00:00Z');
    const updated = await Loan.findOneAndUpdate(
      { _id: loan._id, status: 'ativo', dueDate: loan.dueDate },
      {
        $set: { dueDate: to, reminderSentAt: null },
        $push: {
          dueExtensions: {
            from: loan.dueDate,
            to,
            at: new Date(now()),
            by: null,
            byName: EXTENSION_BY_NAME,
            via: 'whatsapp',
          },
        },
      },
      { new: true }
    );
    if (!updated) {
      return openLoans(chat, {
        prefix: 'Os dados deste empréstimo acabaram de mudar. Confira novamente.',
      });
    }
    console.log('WhatsApp: prazo estendido pelo atendimento automático.');
    await setStep(chat, 'done');
    await reply(
      chat,
      'Pronto. A nova data de devolução de ' +
        bold(loan.bookTitle) +
        ' é ' +
        brDate(check.to) +
        '.\n\n' +
        BACK_HINT
    );
  }

  async function handoff(chat) {
    const at = new Date(now());
    const alreadyAsked =
      chat.handoffAt && now() - new Date(chat.handoffAt).getTime() < 30 * 60 * 1000;
    await WaChat.updateOne(
      { _id: chat._id },
      {
        $set: {
          mode: 'human',
          humanUntil: new Date(now() + cfg.handoffMs),
          handoffAt: alreadyAsked ? chat.handoffAt : at,
          handoffReason: alreadyAsked && chat.handoffReason ? chat.handoffReason : 'admin',
          botStep: '',
          botData: null,
          botAt: at,
        },
      }
    );
    // O administrador e avisado MESMO se a confirmacao para a pessoa falhar
    // (WhatsApp lento, teto do dia): senao a conversa ficaria pausada sem
    // ninguem saber.
    try {
      await reply(
        chat,
        'Certo. Sua solicitação foi encaminhada a um administrador, que continuará o atendimento por aqui assim que possível.'
      );
    } finally {
      if (!alreadyAsked) await notifyAdmin(chat);
    }
  }

  async function notifyAdmin(chat) {
    if (!cfg.adminPhone) return;
    try {
      const people = await peopleOf(chat);
      // Numero de mais de uma ficha (familia): nao da para saber quem e.
      const name =
        people.length === 1
          ? people[0].fullName
          : people.length > 1
            ? (chat.pushName ? chat.pushName + ', ' : '') +
              'número de ' +
              people.map((p) => p.fullName).join(' / ')
            : chat.pushName || 'Contato sem nome';
      const phone = prettyPhone(chat.phone);
      const link = cfg.siteUrl ? cfg.siteUrl + '/conversas/' + chat._id : '';
      const admin = await resolveChat({ phone: cfg.adminPhone });
      if (!admin) return;
      await sendAutomatic(
        admin,
        '*Biblioteca ADMP Brasil – atendimento*\n\n' +
          name +
          (phone ? ' (' + phone + ')' : '') +
          ' quer falar com um administrador pelo WhatsApp.' +
          (link ? '\n\nAbrir a conversa no painel:\n' + link : ''),
        'handoff'
      );
    } catch (error) {
      // O pedido continua marcado no painel ("Aguardando administrador").
      console.error('WhatsApp: não foi possível avisar o administrador:', error.message);
    }
  }

  // ---------- Pedido de emprestimo (o "Combinar" do acervo publico) ----------

  // Mais um aviso de pedido por esta conversa cabe no freio do dia? (Conta
  // so se couber: a mesma conta e feita de uma vez no banco.)
  async function takeRequestNotice(chat) {
    const dayStart = new Date(now() - 24 * 60 * 60 * 1000);
    const t = new Date(now());
    const fresh = await WaChat.findOneAndUpdate(
      {
        _id: chat._id,
        $or: [
          { requestDayAt: null },
          { requestDayAt: { $lte: dayStart } },
          { requestDayCount: { $lt: cfg.maxRequestNoticesPerDay } },
        ],
      },
      [
        {
          $set: {
            requestDayCount: {
              $cond: [
                { $gt: [{ $ifNull: ['$requestDayAt', new Date(0)] }, dayStart] },
                { $add: [{ $ifNull: ['$requestDayCount', 0] }, 1] },
                1,
              ],
            },
            requestDayAt: {
              $cond: [
                { $gt: [{ $ifNull: ['$requestDayAt', new Date(0)] }, dayStart] },
                '$requestDayAt',
                t,
              ],
            },
          },
        },
      ],
      { new: true }
    ).lean();
    return Boolean(fresh);
  }

  async function notifyRequest(chat, { request, parsed, title }) {
    if (!cfg.requestsAdminPhone) return;
    try {
      if (!(await takeRequestNotice(chat))) {
        console.warn('WhatsApp: muitos pedidos de empréstimo da mesma conversa hoje; aviso ao administrador não enviado.');
        return;
      }
      // O nome e o titulo sem a solicitacao no banco sao o que a pessoa DIGITOU
      // na mensagem (marcados como tal). O nome do formulario tambem foi
      // digitado por ela: todos passam por typedText (sem link clicavel).
      const name =
        (typedText(request?.requesterName) ||
          typedText(parsed.name) ||
          typedText(chat.pushName) ||
          'Contato sem nome') +
        (request ? (request.requesterIsNew ? ' (novo cadastro)' : '') : parsed.isNew ? ' (novo cadastro)' : '');
      const phone = prettyPhone(chat.phone);
      const day = request?.pickupDate ? dayOf(request.pickupDate) : '';
      const approve =
        request && cfg.siteUrl ? cfg.siteUrl + '/solicitacao/' + encodeURIComponent(request.token) : '';
      const conversation = cfg.siteUrl ? cfg.siteUrl + '/conversas/' + chat._id : '';
      const admin = await resolveChat({ phone: cfg.requestsAdminPhone });
      if (!admin) return;
      await sendAutomatic(
        admin,
        '*Biblioteca ADMP Brasil – pedido de empréstimo* 📚\n\n' +
          name +
          ' quer pegar emprestado ' +
          bold(title) +
          '.' +
          (phone ? '\nWhatsApp: ' + phone : '') +
          (day ? '\nDia de preferência para pegar: ' + brDate(day) : '') +
          (request ? '' : '\n(nome e livro como a pessoa escreveu na mensagem)') +
          (approve
            ? '\n\nAprovar a solicitação e preencher as datas no painel:\n' + approve
            : request
              ? ''
              : parsed.token
                ? '\n\nO link desta solicitação não vale mais (já foi registrada, virou empréstimo, foi excluída ou venceu): confira em Empréstimos › Solicitados.'
                : '\n\nO pedido chegou sem o link da solicitação: registre em Empréstimos › Solicitados.') +
          (conversation ? '\n\nConversa no painel:\n' + conversation : ''),
        'request'
      );
    } catch (error) {
      // O pedido continua marcado no painel ("Pedido de empréstimo").
      console.error('WhatsApp: não foi possível avisar o administrador do pedido:', error.message);
    }
  }

  /**
   * A mensagem e o pedido pronto do acervo publico ("gostaria de pegar
   * emprestado o livro ..." com o link /solicitacao/<id>): o robo confirma
   * para a pessoa, passa a conversa para um administrador e avisa o
   * administrador dos pedidos. quiet: um administrador ja esta conversando
   * aqui (o robo nao se mete; so o aviso sai). Devolve false quando nao e um
   * pedido de verdade (link que nao existe e sem o texto do pedido): segue o
   * atendimento normal.
   */
  async function handleRequest(chat, parsed, { quiet = false, staff = false } = {}) {
    let request = parsed.token ? await LoanRequest.findOne({ token: parsed.token }).lean() : null;
    const typedTitle = typedText(parsed.title);
    if (!request && !typedTitle) return false;
    const title = request?.bookTitle || typedTitle;
    // O link ja chegou por OUTRA conversa: aqui nao se usa o nome de la.
    const otherChat = request?.waChat && String(request.waChat) !== String(chat._id);
    // Alguem da equipe colou aqui o link de um pedido que ja chegou por outra
    // conversa (copiado do aviso): nao e um pedido dele. Fica quieto.
    if (staff && otherChat) return true;
    const first = firstName(
      (!otherChat && request?.requesterName) || typedText(parsed.name) || typedText(chat.pushName)
    );

    // A equipe ja registrou (a pessoa mandou a mensagem de novo depois).
    if (request && request.status !== 'pendente') {
      if (quiet) return true;
      await setStep(chat, 'done');
      await reply(
        chat,
        'A sua solicitação do livro ' +
          bold(title) +
          ' já foi registrada pela equipe da biblioteca' +
          (request.pickupDate ? ' (retirada prevista em ' + brDate(dayOf(request.pickupDate)) + ')' : '') +
          '. 📚\n\n' +
          BACK_HINT
      );
      return true;
    }

    // Um aviso por link: o mesmo link de novo (mensagem repetida) nao avisa
    // outra vez. Sem link, a mesma mensagem em 30 minutos tambem nao. O link
    // fica com a PRIMEIRA conversa que o mandou: outra conversa mandando o
    // mesmo link (encaminhado, ou o mesmo nome pedindo o mesmo livro) recebe a
    // resposta, mas nao toma o link nem gera aviso novo.
    let notify;
    if (request) {
      const claimed = await LoanRequest.findOneAndUpdate(
        {
          _id: request._id,
          status: 'pendente',
          waNotifiedAt: null,
          $or: [{ waChat: null }, { waChat: chat._id }],
        },
        { $set: { waNotifiedAt: new Date(now()), waChat: chat._id, waPhone: chat.phone || '' } },
        { new: true }
      ).lean();
      notify = Boolean(claimed);
      if (claimed) request = claimed;
    } else {
      const requestKey = normalizeInput(title + '|' + (parsed.name || ''));
      const repeated =
        chat.lastRequestKey === requestKey &&
        chat.lastRequestAt &&
        now() - new Date(chat.lastRequestAt).getTime() < 30 * 60 * 1000;
      notify = !repeated;
      if (notify) {
        await WaChat.updateOne(
          { _id: chat._id },
          { $set: { lastRequestKey: requestKey, lastRequestAt: new Date(now()) } }
        );
      }
    }

    // A conversa passa para um administrador (o robo fica quieto) e aparece
    // no painel como "Pedido de empréstimo".
    const at = new Date(now());
    const humanUntil = Math.max(
      now() + cfg.handoffMs,
      chat.mode === 'human' && chat.humanUntil ? new Date(chat.humanUntil).getTime() : 0
    );
    await WaChat.updateOne(
      { _id: chat._id },
      {
        $set: {
          mode: 'human',
          humanUntil: new Date(humanUntil),
          handoffAt: chat.mode === 'human' && chat.handoffAt ? chat.handoffAt : at,
          handoffReason: 'request',
          botStep: '',
          botData: null,
          botAt: at,
        },
      }
    );

    try {
      if (!quiet) {
        await reply(
          chat,
          'Olá' +
            (first ? ', ' + first : '') +
            '! Recebemos o seu pedido do livro ' +
            bold(title) +
            '. 📚\n\n' +
            'Vou passar o seu pedido para um de nossos administradores, que entrará em contato com você assim que possível.'
        );
      }
    } finally {
      // O administrador e avisado mesmo se a resposta a pessoa falhar.
      if (notify) await notifyRequest(chat, { request, parsed, title });
    }
    return true;
  }

  // ---------- Entrada de cada mensagem ----------

  async function handle({ chat: eventChat, message, text, kind }) {
    if (!cfg.enabled || !whatsapp.isOpen()) return;
    const at = message?.at ? new Date(message.at).getTime() : now();
    const age = now() - at;
    // Pedido de emprestimo pronto do acervo publico: vem antes de tudo (vale
    // ate com um administrador ja na conversa ou com o robo silenciado - e um
    // pedido explicito, nao um "ok").
    const request = kind === 'text' ? parseRequestMessage(text) : null;
    // Pedido que chegou atrasado (o servidor ficou fora do ar por horas): o
    // administrador ainda e avisado, mas a pessoa nao recebe a resposta
    // automatica (sairia fora de hora). Mais velho que isto, nem o aviso.
    const lateRequest = request && age > cfg.maxAgeMs && age <= cfg.maxRequestAgeMs;
    if (age > cfg.maxAgeMs && !lateRequest) return;

    let chat = await WaChat.findById(eventChat._id).lean();
    if (!chat) return;

    // O numero que recebe os avisos (ou o do administrador) reencaminhando o
    // proprio aviso de pedido para ca nao vira um pedido novo.
    const staff = [cfg.adminPhone, cfg.requestsAdminPhone].some(
      (phone) => phone && samePhone(chat.phone, phone)
    );
    const forwardedNotice = staff && /pedido de empr[ée]stimo/i.test(String(text).slice(0, 120));

    if (request && !forwardedNotice) {
      const humanActive =
        chat.mode === 'human' && chat.humanUntil && new Date(chat.humanUntil).getTime() > now();
      const muted = chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now();
      // Administrador conversando (sem pedido esperando), robo silenciado ou
      // pedido atrasado: a pessoa nao recebe a resposta automatica, so o
      // administrador e avisado.
      const quiet = Boolean((humanActive && !chat.handoffAt) || muted || lateRequest);
      if (await handleRequest(chat, request, { quiet, staff })) return;
    }
    if (age > cfg.maxAgeMs) return;

    if (chat.mode === 'human') {
      if (chat.humanUntil && new Date(chat.humanUntil).getTime() > now()) return;
      // O atendimento humano venceu: o robo volta, do comeco.
      await WaChat.updateOne(
        { _id: chat._id, mode: 'human' },
        {
          $set: {
            mode: 'bot',
            humanUntil: null,
            handoffAt: null,
            handoffReason: '',
            botStep: '',
            botData: null,
          },
        }
      );
      chat = await WaChat.findById(chat._id).lean();
      if (!chat || chat.mode !== 'bot') return;
    }

    const expired =
      !chat.botStep ||
      !chat.botAt ||
      now() - new Date(chat.botAt).getTime() > (Number(chat.botData?.ttlMs) || cfg.sessionMs);
    const choice = kind === 'text' ? parseChoice(text) : {};

    // Estourou o freio (outro robo do outro lado?): mudo por um tempo. Mas
    // um pedido de administrador ainda passa (o aviso ao administrador nao
    // depende do freio): ninguem fica sem atendimento sem o painel saber.
    if (chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now()) {
      const wantsAdmin =
        (chat.botStep === 'blocked' && !expired && choice.digit === 1) ||
        ((expired || ['menu', 'done'].includes(chat.botStep)) &&
          (choice.digit === 3 || (kind === 'text' && mainWord(text) === 3)));
      if (wantsAdmin) return handoff(chat);
      return;
    }

    // O numero do administrador recebe os avisos de atendimento: responder
    // "ok" a um aviso nao pode puxar o menu. Para testar o robo por ele,
    // basta mandar "menu".
    // (Vale tambem para o numero que recebe os avisos de pedido de emprestimo.)
    if (staff && expired && choice.word !== 'menu') return;

    if (expired) return showMain(chat, { greet: true });

    // Rajada logo depois do MENU ("Oi" / "Boa tarde" / "Tudo bem?" em
    // sequencia, ou o que se acumulou com o servidor fora do ar): o que vem
    // fora das opcoes nao vira uma fila de "Nao entendi". Vale so nos passos
    // de menu (10 s: ninguem le o menu e responde em menos que isso). Nos
    // passos com pergunta (emprestimos, confirmar) a resposta e sempre tratada.
    const sentBefore = at < new Date(chat.botAt).getTime() + cfg.burstMs;
    const digit = choice.digit ?? confirmWord(chat.botStep, text, kind);
    if (choice.word === 'menu') return showMain(chat);

    switch (chat.botStep) {
      case 'menu': {
        const option = digit ?? (kind === 'text' ? mainWord(text) : 0);
        if (option === 0 && digit === 0) return showMain(chat);
        if (![1, 2, 3].includes(option) && sentBefore) return undefined;
        return chooseMain(chat, option);
      }
      case 'done': {
        if (digit === 1 || digit === 2 || digit === 3) return chooseMain(chat, digit);
        if (sentBefore && digit !== 0) return undefined;
        return showMain(chat);
      }
      case 'loans': {
        const option = digit ?? (kind === 'text' ? loansWord(text) : undefined);
        if (option === 1) return listLoans(chat);
        if (option === 2) return startExtension(chat);
        if (option === 0) return showMain(chat);
        return openLoans(chat, { prefix: NOT_UNDERSTOOD });
      }
      case 'pick-loan': {
        if (digit === 0) return openLoans(chat);
        const ids = chat.botData?.ids || [];
        if (digit >= 1 && digit <= ids.length) {
          const people = await peopleOf(chat);
          const loan = await Loan.findById(ids[digit - 1]).lean();
          if (!belongsTo(loan, chat, people)) {
            return openLoans(chat, { prefix: 'Este empréstimo não está mais ativo.' });
          }
          return offerExtension(chat, loan);
        }
        return startExtension(chat, { prefix: NOT_UNDERSTOOD });
      }
      case 'confirm': {
        if (digit === 1) return confirmExtension(chat, chat.botData);
        if (digit === 0) return openLoans(chat, { prefix: 'Extensão cancelada.' });
        await reply(chat, NOT_UNDERSTOOD + '\n\n' + CONFIRM_OPTIONS);
        return undefined;
      }
      case 'blocked': {
        if (digit === 1) return handoff(chat);
        if (digit === 0) return showMain(chat);
        await reply(chat, NOT_UNDERSTOOD + '\n\n' + HANDOFF_OPTIONS);
        return undefined;
      }
      default:
        return showMain(chat, { greet: true });
    }
  }

  /** A equipe respondeu (painel ou celular): o robo fica quieto nessa conversa. */
  async function humanTookOver(chatId) {
    await WaChat.updateOne(
      { _id: chatId },
      {
        $set: {
          mode: 'human',
          humanUntil: new Date(now() + cfg.humanMs),
          handoffAt: null,
          handoffReason: '',
          botStep: '',
          botData: null,
        },
      }
    );
  }

  function onEvent(event) {
    if (event.type === 'incoming') {
      return inLane(event.chat._id, () => handle(event)).catch((error) => {
        console.error('WhatsApp: o atendimento automático falhou numa mensagem:', error.message);
      });
    }
    if (event.type === 'phone-out') {
      return humanTookOver(event.chat._id).catch(() => {});
    }
    return undefined;
  }

  return {
    config: cfg,
    start() {
      if (stop) return;
      stop = whatsapp.onEvent(onEvent);
      if (!cfg.siteUrl) {
        console.warn('WhatsApp: sem PUBLIC_SITE_URL/CORS_ORIGIN https: os links do atendimento ficam sem endereço.');
      }
    },
    stop() {
      stop?.();
      stop = null;
    },
    handle: (event) => inLane(event.chat._id, () => handle(event)),
    // Direto (fora da fila): o painel nao espera uma resposta do robo terminar.
    humanTookOver,
    sendAutomatic,
  };
}

/** O atendimento que o servidor usa (ligado em server.js). */
export const bot = createBot({ whatsapp: defaultWhatsapp });

// Reconectando ha mais que isto, o "Combinar" vai para o brasileiro: a
// mensagem para o +54 ficaria horas sem resposta.
const RECONNECT_GRACE_MS = 15 * 60 * 1000;

// O WhatsApp da biblioteca recebe agora (ou vai receber em instantes)?
// - aberto, ou outra copia do servidor com a conexao (standby, no deploy);
// - conectando/reconectando COM sessao salva e fora do ar ha pouco tempo
//   (servidor acordando, queda rapida). Sem sessao, conectando e o QR.
function receivingSoon(status, now) {
  if (status.state === 'open' || status.state === 'standby') return true;
  if (status.state !== 'connecting' && status.state !== 'reconnecting') return false;
  if (!status.hasSession) return false;
  const down = status.downSince ? Date.parse(status.downSince) : NaN;
  return Number.isFinite(down) && now - down < RECONNECT_GRACE_MS;
}

/**
 * Para qual WhatsApp vai o "Combinar" do acervo publico:
 * - "robo" (padrao): o numero da biblioteca conectado ao painel (+54), onde o
 *   robo confirma o pedido e avisa o administrador dos pedidos;
 * - "brasil": o MODELO ANTIGO, guardado como reserva - a mensagem vai direto
 *   para o WhatsApp brasileiro (LIBRARY_WHATSAPP_BR), e a equipe combina por
 *   la, como antes do robo. Escolhido com REQUESTS_WHATSAPP=brasil no Render.
 * Mesmo no "robo", se o WhatsApp da biblioteca nao esta conectado (QR por
 * ler, sessao quebrada, desligado) ou o robo esta desligado, vai para o
 * brasileiro: ninguem fica sem resposta.
 * Devolve { number, via: "robo" | "brasil" }.
 */
export function requestChannel({
  env = process.env,
  whatsapp = defaultWhatsapp,
  botConfig = bot.config,
  now = Date.now(),
} = {}) {
  const legacy = digitsOf(env.LIBRARY_WHATSAPP_BR || LEGACY_REQUESTS_WHATSAPP);
  const mode = String(env.REQUESTS_WHATSAPP || 'robo').trim().toLowerCase();
  if (mode === 'brasil' || !botConfig.enabled) return { number: legacy, via: 'brasil' };
  const status = whatsapp.snapshot();
  const ready = status.enabled && !status.broken && receivingSoon(status, now);
  const number = digitsOf(whatsapp.config?.number || status.number);
  return ready && number ? { number, via: 'robo' } : { number: legacy, via: 'brasil' };
}
