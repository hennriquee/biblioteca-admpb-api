import WaChat from '../../models/WaChat.js';
import WaMessage from '../../models/WaMessage.js';
import { dropEmptyChat, refreshLastMessage } from './store.js';

/**
 * MENSAGENS TEMPORARIAS NO PAINEL. O WhatsApp da biblioteca apaga cada
 * mensagem 7 dias depois de enviada; o painel faz o mesmo com a copia dele:
 * - a mensagem mais velha que o prazo sai do banco;
 * - a conversa que ficou sem mensagens sai da lista (e do banco);
 * - a conversa aberta pelo cadastro em que ninguem escreveu tambem sai,
 *   passado o mesmo prazo.
 * O prazo e WHATSAPP_DISAPPEAR_DAYS (padrao 7; 0 = guardar para sempre).
 *
 * So roda onde o WhatsApp roda (o servidor do Render): o backend/.env local
 * aponta para o banco de PRODUCAO. Rodar duas vezes nao faz mal (o Render
 * sobrepoe duas copias no deploy).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function createRetention({
  whatsapp,
  config: overrides = {},
  now = () => Date.now(),
} = {}) {
  const cfg = {
    days: whatsapp?.config?.disappearDays ?? 7,
    enabled: Boolean(whatsapp?.config?.enabled),
    everyMs: 30 * 60 * 1000,
    firstRunMs: 60 * 1000,
    ...overrides,
  };
  let timer = null;
  let first = null;
  let running = null;

  async function sweep() {
    if (!(cfg.days > 0)) return { messages: 0, chats: 0 };
    const cutoff = new Date(now() - cfg.days * DAY_MS);

    const { deletedCount: messages = 0 } = await WaMessage.deleteMany({ at: { $lt: cutoff } });

    // "Nao lidas" nao pode passar das mensagens recebidas que sobraram. (So
    // troca se o numero ainda e o lido: uma mensagem chegando no meio soma por
    // cima e vence.)
    if (messages) {
      const unreadChats = await WaChat.find({ unread: { $gt: 0 } }).select('_id unread').lean();
      for (const chat of unreadChats) {
        const left = await WaMessage.countDocuments({ chat: chat._id, fromMe: false });
        if (left < chat.unread) {
          await WaChat.updateOne({ _id: chat._id, unread: chat.unread }, { $set: { unread: left } });
        }
      }
    }

    let chats = 0;
    const stale = await WaChat.find({
      $or: [
        // A ultima mensagem e mais velha que o prazo: nao sobrou nenhuma.
        { lastMessageAt: { $lt: cutoff } },
        // Aberta pelo cadastro e ninguem escreveu.
        { lastMessageAt: null, createdAt: { $lt: cutoff } },
      ],
    }).lean();
    for (const chat of stale) {
      if (await WaMessage.exists({ chat: chat._id })) {
        // A "ultima mensagem" estava atrasada: a conversa ainda tem mensagens.
        await refreshLastMessage(chat._id);
        continue;
      }
      if (await dropEmptyChat(chat)) chats += 1;
    }

    if (messages || chats) {
      console.log(
        'WhatsApp: mensagens temporárias: ' +
          messages +
          (messages === 1 ? ' mensagem' : ' mensagens') +
          ' e ' +
          chats +
          (chats === 1 ? ' conversa' : ' conversas') +
          ' com mais de ' +
          cfg.days +
          ' dias saíram do painel.'
      );
    }
    return { messages, chats };
  }

  // Uma rodada por vez.
  function run() {
    if (!running) {
      running = sweep().finally(() => {
        running = null;
      });
    }
    return running;
  }

  function tick() {
    run().catch((error) => {
      console.error('WhatsApp: não foi possível apagar as mensagens vencidas:', error.message);
    });
  }

  return {
    config: cfg,
    run,
    start() {
      if (!cfg.enabled || !(cfg.days > 0) || timer) return;
      first = setTimeout(tick, cfg.firstRunMs);
      first.unref?.();
      timer = setInterval(tick, cfg.everyMs);
      timer.unref?.();
    },
    stop() {
      clearTimeout(first);
      clearInterval(timer);
      first = null;
      timer = null;
    },
  };
}
