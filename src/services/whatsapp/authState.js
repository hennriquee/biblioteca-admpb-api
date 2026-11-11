import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';
import WaAuth from '../../models/WaAuth.js';
import { open, seal } from './crypto.js';

/**
 * A sessao do Baileys (credenciais + chaves de criptografia) guardada no
 * MongoDB, cifrada. E o equivalente do useMultiFileAuthState do Baileys, que a
 * propria documentacao dele manda trocar por banco em producao.
 *
 * Devolve:
 * - status "saved": ha sessao salva e legivel (reconecta sem QR);
 * - status "new": nao ha sessao (precisa do QR);
 * - status "unreadable": ha sessao, mas ela nao decifra (a senha de origem da
 *   chave mudou?). NAO apaga nada: apagar por engano uma sessao boa obrigaria
 *   a ler o QR de novo. Quem decide e o administrador (clear()).
 */

const CREDS_ID = 'creds';

function pack(value, id) {
  return seal(JSON.stringify(value, BufferJSON.replacer), id);
}

function unpack(text, id) {
  return JSON.parse(open(text, id), BufferJSON.reviver);
}

export async function useMongoAuthState({ Model = WaAuth } = {}) {
  // Escritas em fila: o Baileys avisa varias mudancas seguidas e a ultima tem
  // de ser a que fica.
  let tail = Promise.resolve();
  function enqueue(task) {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  }

  /** Espera as gravacoes em andamento terminarem. */
  async function flush() {
    await tail;
  }

  async function clear() {
    await enqueue(() => Model.deleteMany({}));
  }

  const saved = await Model.findById(CREDS_ID).lean();
  let creds;
  let status;
  if (saved) {
    try {
      creds = unpack(saved.value, CREDS_ID);
      status = 'saved';
    } catch {
      return { status: 'unreadable', clear, flush };
    }
  } else {
    // Sem credenciais, qualquer chave que sobrou nao serve para nada.
    await Model.deleteMany({});
    creds = initAuthCreds();
    status = 'new';
  }

  const keys = {
    async get(type, ids) {
      const docIds = ids.map((id) => type + ':' + id);
      const docs = await Model.find({ _id: { $in: docIds } }).lean();
      const byId = new Map(docs.map((doc) => [doc._id, doc.value]));
      const out = {};
      ids.forEach((id, index) => {
        const sealed = byId.get(docIds[index]);
        let value = null;
        if (sealed) {
          try {
            value = unpack(sealed, docIds[index]);
          } catch {
            value = null; // peca ilegivel = peca que nao existe
          }
        }
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value);
        }
        out[id] = value;
      });
      return out;
    },

    async set(data) {
      const ops = [];
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          const value = data[type][id];
          const docId = type + ':' + id;
          if (value) {
            ops.push({
              updateOne: {
                filter: { _id: docId },
                update: { $set: { value: pack(value, docId) } },
                upsert: true,
              },
            });
          } else {
            ops.push({ deleteOne: { filter: { _id: docId } } });
          }
        }
      }
      if (ops.length) await enqueue(() => Model.bulkWrite(ops, { ordered: false }));
    },
  };

  return {
    status,
    state: { creds, keys },
    // Le as credenciais NA HORA de gravar: o Baileys as atualiza no lugar.
    saveCreds: () =>
      enqueue(() =>
        Model.updateOne(
          { _id: CREDS_ID },
          { $set: { value: pack(creds, CREDS_ID) } },
          { upsert: true }
        )
      ),
    clear,
    flush,
  };
}
