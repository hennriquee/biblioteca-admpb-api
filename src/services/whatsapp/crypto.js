import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifra a sessao do WhatsApp antes de ir para o banco (AES-256-GCM).
 *
 * A chave sai de WHATSAPP_ENCRYPTION_KEY ou, se nao houver, do JWT_SECRET (que
 * o servidor ja exige), por HKDF com um rotulo proprio: a mesma senha nao
 * serve para outra coisa. O id do documento entra como dado autenticado (AAD),
 * entao um documento copiado para outro id nao decifra.
 *
 * Trocar a senha de origem torna a sessao ilegivel: o painel pede o QR de novo
 * (nunca apaga nada sozinho - ver authState.js).
 */

const PREFIX = 'v1.';
const cache = { secret: null, key: null };

function secret() {
  const value = process.env.WHATSAPP_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!value) {
    throw new Error(
      'Defina JWT_SECRET (ou WHATSAPP_ENCRYPTION_KEY) para guardar a sessao do WhatsApp.'
    );
  }
  return value;
}

function key() {
  const current = secret();
  if (cache.secret !== current) {
    cache.key = Buffer.from(
      hkdfSync('sha256', current, 'biblioteca-admpb', 'whatsapp-session-v1', 32)
    );
    cache.secret = current;
  }
  return cache.key;
}

export function seal(text, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const body = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/** Devolve o texto, ou lanca erro se a chave/o id nao baterem ou o dado foi alterado. */
export function open(sealed, aad) {
  const text = String(sealed || '');
  if (!text.startsWith(PREFIX)) throw new Error('formato desconhecido');
  const raw = Buffer.from(text.slice(PREFIX.length), 'base64');
  if (raw.length < 12 + 16) throw new Error('dado curto demais');
  const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}
