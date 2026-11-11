import { randomUUID } from 'node:crypto';
import Setting from '../../models/Setting.js';

/**
 * Trava de "quem esta com o WhatsApp": so UMA copia do servidor pode manter a
 * sessao aberta por vez.
 *
 * Duas copias com a mesma sessao brigam (o WhatsApp derruba uma) e, pior,
 * gravam chaves de criptografia por cima uma da outra, o que estraga a sessao.
 * Isso acontece de verdade em dois momentos: na troca de versao do Render (a
 * antiga e a nova ficam de pe juntas por alguns segundos) e quando alguem roda
 * o backend no computador com o mesmo banco.
 *
 * A trava e um documento no banco, com prazo: quem a tem a renova de tempos em
 * tempos; se a copia some sem avisar, ela vence sozinha e outra assume. Ao
 * desligar com calma, a copia a solta na hora (release).
 */

const LEASE_ID = 'whatsapp-lease';

export function createLease({
  ttlMs = 45 * 1000,
  now = () => Date.now(),
  id = randomUUID(),
} = {}) {
  /** Pega a trava (ou renova a que ja e sua). true = e sua. */
  async function acquire() {
    const t = now();
    try {
      const doc = await Setting.findOneAndUpdate(
        {
          _id: LEASE_ID,
          $or: [
            { 'value.holder': id },
            { 'value.until': { $lt: t } },
            { value: null },
          ],
        },
        { $set: { value: { holder: id, until: t + ttlMs } } },
        { upsert: true, new: true }
      );
      return doc?.value?.holder === id;
    } catch (error) {
      // Ja existe e e de outra copia: o upsert tenta criar o mesmo _id.
      if (error.code === 11000) return false;
      throw error;
    }
  }

  async function release() {
    await Setting.updateOne(
      { _id: LEASE_ID, 'value.holder': id },
      { $set: { value: { holder: null, until: 0 } } }
    );
  }

  return { id, acquire, renew: acquire, release };
}
