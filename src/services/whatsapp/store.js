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
  const last = await WaMessage.findOne({ chat: into._id }).sort({ at: -1 }).lean();
  const set = {};
  if (last) {
    set.lastMessageAt = last.at;
    set.lastMessageText = previewOf(last.kind, last.text);
    set.lastMessageKind = last.kind;
    set.lastMessageFromMe = last.fromMe;
  }
  await WaChat.updateOne(
    { _id: into._id },
    { $set: set, $inc: { unread: from.unread || 0 } }
  );
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
    countUnread = false,
  }
) {
  const when = at instanceof Date ? at : new Date(at || Date.now());
  const set = {};
  if (sentBy) {
    set.sentBy = sentBy;
    set.sentByName = sentByName;
  }
  if (chargeLoan) set.chargeLoan = chargeLoan;

  const update = {
    $setOnInsert: { fromMe, kind, text, at: when },
    $max: { status },
  };
  if (Object.keys(set).length) update.$set = set;

  const result = await WaMessage.updateOne({ chat: chat._id, waId }, update, {
    upsert: true,
  });
  const inserted = result.upsertedCount === 1;

  if (inserted) {
    await WaChat.updateOne(
      {
        _id: chat._id,
        $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: when } }],
      },
      {
        $set: {
          lastMessageAt: when,
          lastMessageText: previewOf(kind, text),
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

/** O status de entrega so sobe (enviada -> entregue -> lida). */
export async function raiseStatus(chatId, waId, status) {
  await WaMessage.updateOne(
    { chat: chatId, waId, fromMe: true },
    { $max: { status } }
  );
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
              : previewOf(last.kind, last.text),
            lastMessageKind: last.kind,
            lastMessageFromMe: last.fromMe,
          },
        }
      : { $set: { lastMessageAt: null, lastMessageText: '' } }
  );
}
