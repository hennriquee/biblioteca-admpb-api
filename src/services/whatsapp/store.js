import WaChat from '../../models/WaChat.js';
import WaMessage from '../../models/WaMessage.js';
import { normalizeText } from '../../models/Book.js';
import { previewOf } from './content.js';
import { chatKeyFor, digitsOf, jidFromPhone } from './phone.js';

/**
 * Conversas e mensagens no banco. Tudo aqui e idempotente: a mesma mensagem
 * chegando de novo (reconexao, historico, envio + evento do proprio envio) nao
 * duplica nem soma "nao lida" duas vezes.
 */

/** Move as mensagens de uma conversa para outra e apaga a primeira. */
async function mergeChats(from, into) {
  const cursor = WaMessage.find({ chat: from._id }).cursor();
  for await (const message of cursor) {
    try {
      await WaMessage.updateOne({ _id: message._id }, { $set: { chat: into._id } });
    } catch (error) {
      if (error.code !== 11000) throw error;
      // A outra conversa ja tem essa mensagem.
      await WaMessage.deleteOne({ _id: message._id });
    }
  }
  // (A "ultima mensagem" e recalculada no fim, por refreshLastMessage: assim a
  // previa segue as mesmas regras - apagada, assinatura do painel.)
  const set = {};
  // Atendimento humano em curso na conversa que some passa para a que fica
  // (senao o "Aguardando administrador" sumiria e o robo responderia no meio).
  const fromUntil = from.humanUntil ? new Date(from.humanUntil).getTime() : 0;
  const intoUntil = into.humanUntil ? new Date(into.humanUntil).getTime() : 0;
  if (from.mode === 'human' && fromUntil > Date.now() && fromUntil > intoUntil) {
    set.mode = 'human';
    set.humanUntil = from.humanUntil;
    if (from.handoffAt) set.handoffAt = from.handoffAt;
  } else if (from.handoffAt && into.mode === 'human' && !into.handoffAt) {
    set.handoffAt = from.handoffAt;
  }
  await WaChat.updateOne(
    { _id: into._id },
    { ...(Object.keys(set).length ? { $set: set } : {}), $inc: { unread: from.unread || 0 } }
  );
  await refreshLastMessage(into._id);
  await WaChat.deleteOne({ _id: from._id });
}

/**
 * Acha (e, se create, cria) a conversa. phone/lid sao o que o WhatsApp
 * informou. authoritative: a informacao veio do proprio WhatsApp (uma mensagem
 * ou a confirmacao de que o numero existe) - so ai ela vale como o endereco
 * para enviar; uma conversa aberta a partir do cadastro so preenche o que falta.
 */
export async function resolveChat({
  phone = '',
  lid = '',
  pushName = '',
  create = true,
  authoritative = false,
}) {
  const key = chatKeyFor({ phone, lid });
  if (!key) return null;

  const hasPhone = Boolean(digitsOf(phone));
  let chat = await WaChat.findOne({ key });
  // So o LID (sem numero): a conversa que JA conhece esse LID e a certa, e a
  // chave dela NAO muda. (Sem isso, uma mensagem so com LID renomeava a conversa
  // do numero para "lid:..." e a conversa se dividia em duas.)
  if (!chat && !hasPhone && lid) chat = await WaChat.findOne({ lid });
  if (lid && hasPhone) {
    const other = await WaChat.findOne({
      lid,
      ...(chat ? { _id: { $ne: chat._id } } : {}),
    });
    if (other) {
      if (!chat) {
        // A conversa so tinha o LID; agora o numero apareceu.
        try {
          chat = await WaChat.findOneAndUpdate(
            { _id: other._id },
            { $set: { key } },
            { new: true }
          );
        } catch (error) {
          if (error.code !== 11000) throw error;
          chat = await WaChat.findOne({ key });
          if (chat) await mergeChats(other, chat);
        }
      } else {
        await mergeChats(other, chat);
        chat = await WaChat.findById(chat._id);
      }
    }
  }

  if (!chat) {
    if (!create) return null;
    chat = await WaChat.findOneAndUpdate(
      { key },
      { $setOnInsert: { key } },
      { upsert: true, new: true }
    );
  }

  const set = {};
  const digits = digitsOf(phone);
  if (digits) {
    if (authoritative || !chat.phone) {
      if (chat.phone !== digits) set.phone = digits;
      if (chat.jid !== jidFromPhone(digits)) set.jid = jidFromPhone(digits);
    }
    if (authoritative) set.checkedAt = new Date();
  }
  if (lid && chat.lid !== lid) set.lid = lid;
  if (pushName && chat.pushName !== pushName) {
    set.pushName = pushName;
    // Sem acento e em minusculas, para a busca achar "Joao" em "João".
    set.pushNameSort = normalizeText(pushName);
  }
  if (Object.keys(set).length) {
    chat = await WaChat.findByIdAndUpdate(chat._id, { $set: set }, { new: true });
  }
  return chat;
}

/**
 * Grava uma mensagem. countUnread: se for recebida (e nova), soma uma "nao lida".
 * @returns {Promise<{ inserted: boolean, message: object }>}
 */
export async function saveMessage(
  chat,
  {
    waId,
    fromMe,
    kind = 'text',
    text = '',
    at,
    status = 2,
    sentBy = null,
    sentByName = '',
    chargeLoan = null,
    auto = '',
    countUnread = false,
    // O que a lista de conversas mostra como "ultima mensagem", se nao for o
    // proprio texto (a mensagem do painel sem a linha do nome de quem enviou).
    preview = null,
  }
) {
  const when = at instanceof Date ? at : new Date(at || Date.now());
  const set = {};
  if (sentBy) {
    set.sentBy = sentBy;
    set.sentByName = sentByName;
  }
  if (chargeLoan) set.chargeLoan = chargeLoan;
  if (auto) {
    set.auto = auto;
    set.sentByName = sentByName;
  }

  // O status entra so na criacao; depois so muda por raiseStatus (que sabe
  // tratar o "erro", que e menor que "enviada" mas tem de valer).
  const update = { $setOnInsert: { fromMe, kind, text, at: when, status } };
  if (Object.keys(set).length) update.$set = set;

  const result = await WaMessage.updateOne({ chat: chat._id, waId }, update, {
    upsert: true,
  });
  const inserted = result.upsertedCount === 1;
  if (!inserted && fromMe) await raiseStatus(chat._id, waId, status);

  // O eco do WhatsApp chegou antes e ja gravou a mensagem (com o texto
  // inteiro): a lista passa a mostrar a previa certa, se ela ainda e a ultima.
  if (!inserted && preview !== null) {
    const saved = await WaMessage.findOne({ chat: chat._id, waId }).select('at').lean();
    if (saved) {
      await WaChat.updateOne(
        { _id: chat._id, lastMessageAt: saved.at },
        { $set: { lastMessageText: previewOf(kind, preview) } }
      );
    }
  }

  if (inserted) {
    await WaChat.updateOne(
      {
        _id: chat._id,
        $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: when } }],
      },
      {
        $set: {
          lastMessageAt: when,
          lastMessageText: previewOf(kind, preview ?? text),
          lastMessageKind: kind,
          lastMessageFromMe: fromMe,
        },
      }
    );
    // So soma quando a mensagem e NOVA aqui (inserted): receber a mesma de
    // novo nao conta duas vezes. Nao compara com a hora da leitura: mensagem
    // que chega atrasada (o servidor dormia) tambem e "nao lida".
    if (countUnread && !fromMe) {
      await WaChat.updateOne({ _id: chat._id }, { $inc: { unread: 1 } });
    }
  }

  const message = await WaMessage.findOne({ chat: chat._id, waId }).lean();
  return { inserted, message };
}

/**
 * Status de entrega das mensagens da biblioteca. Sobe (enviando -> enviada ->
 * entregue -> lida), com uma excecao: o ERRO (0). O WhatsApp avisa do erro
 * DEPOIS de aceitar o envio (o servidor dele recusou ou o aparelho nao abriu
 * a mensagem); antes isso era descartado, porque 0 < 2, e o painel seguia
 * mostrando "enviada" para uma mensagem que nunca chegou.
 * - erro: vale se a mensagem ainda nao foi entregue;
 * - enviando/enviada: nao apagam um erro;
 * - entregue/lida: valem sempre (a mensagem chegou, mesmo depois de um erro).
 * @returns {Promise<boolean>} se a mensagem existe (para tentar de novo se nao).
 */
export async function raiseStatus(chatId, waId, status, errorCode = '') {
  const filter = { chat: chatId, waId, fromMe: true };
  if (status === 0) {
    const result = await WaMessage.updateOne(
      { ...filter, status: { $lt: 3 } },
      { $set: { status: 0, errorCode: String(errorCode || '').slice(0, 40) } }
    );
    if (result.matchedCount) return true;
    return Boolean(await WaMessage.exists(filter));
  }
  const result = await WaMessage.updateOne(
    status >= 3
      ? { ...filter, status: { $lt: status } }
      : { ...filter, status: { $gt: 0, $lt: status } },
    { $set: { status } }
  );
  if (result.matchedCount) return true;
  return Boolean(await WaMessage.exists(filter));
}

export async function markDeleted(chatId, waId) {
  const result = await WaMessage.findOneAndUpdate(
    { chat: chatId, waId },
    { $set: { deleted: true, text: '', kind: 'text' } },
    { new: true }
  );
  if (result) await refreshLastMessage(chatId);
}

export async function markEdited(chatId, waId, text) {
  const result = await WaMessage.findOneAndUpdate(
    { chat: chatId, waId, deleted: false },
    { $set: { text, edited: true } },
    { new: true }
  );
  if (result) await refreshLastMessage(chatId);
}

/** Recalcula a "ultima mensagem" mostrada na lista. */
export async function refreshLastMessage(chatId) {
  const last = await WaMessage.findOne({ chat: chatId }).sort({ at: -1 }).lean();
  await WaChat.updateOne(
    { _id: chatId },
    last
      ? {
          $set: {
            lastMessageAt: last.at,
            lastMessageText: last.deleted
              ? 'Mensagem apagada'
              : previewOf(
                  last.kind,
                  // Do painel: sem a linha do nome de quem enviou (ver
                  // signedText em routes/whatsapp.js).
                  last.sentBy ? String(last.text || '').replace(/^\*[^*\n]+:\*\n/, '') : last.text
                ),
            lastMessageKind: last.kind,
            lastMessageFromMe: last.fromMe,
          },
        }
      : { $set: { lastMessageAt: null, lastMessageText: '' } }
  );
}
