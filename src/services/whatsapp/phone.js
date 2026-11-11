/**
 * Telefones e enderecos (JID) do WhatsApp.
 *
 * O WhatsApp as vezes escreve o mesmo celular de dois jeitos: no Brasil, com
 * e sem o 9 depois do DDD (5534997885466 / 553497885466); na Argentina, com e
 * sem o 9 depois do 54 (5491164610665 / 541164610665). O cadastro guarda um
 * jeito e o WhatsApp responde com o outro, entao toda comparacao passa pela
 * chave abaixo, que tira esse 9.
 */

export function digitsOf(value) {
  return String(value || '').replace(/\D/g, '');
}

/** O numero sem o 9 de celular (Brasil e Argentina). Outros paises ficam como estao. */
export function canonicalPhone(value) {
  const digits = digitsOf(value);
  // Brasil: 55 + DDD (2) + 9 + 8 digitos.
  if (/^55\d{2}9\d{8}$/.test(digits)) return digits.slice(0, 4) + digits.slice(5);
  // Argentina: 54 + 9 + DDD e numero (10 digitos).
  if (/^549\d{10}$/.test(digits)) return '54' + digits.slice(3);
  return digits;
}

/** Os dois numeros sao do mesmo aparelho? (Vazio nunca e igual a nada.) */
export function samePhone(a, b) {
  const first = canonicalPhone(a);
  return Boolean(first) && first === canonicalPhone(b);
}

/**
 * Todas as formas em que esse numero pode estar gravado no cadastro (para
 * procurar a pessoa por telefone).
 */
export function phoneVariants(value) {
  const digits = digitsOf(value);
  if (!digits) return [];
  const canonical = canonicalPhone(digits);
  const out = new Set([digits, canonical]);
  // Brasil: 55 + DDD + 8 digitos de celular (comecam com 6 a 9) -> com o 9.
  if (/^55\d{2}[6-9]\d{7}$/.test(canonical)) {
    out.add(canonical.slice(0, 4) + '9' + canonical.slice(4));
  }
  // Argentina: 54 + 10 digitos -> com o 9.
  if (/^54\d{10}$/.test(canonical)) out.add('549' + canonical.slice(2));
  return [...out];
}

/** "5534997885466:12@s.whatsapp.net" -> "5534997885466". LID e outros: "". */
export function phoneFromJid(jid) {
  const text = String(jid || '');
  const at = text.indexOf('@');
  if (at < 0) return '';
  const server = text.slice(at + 1);
  if (server !== 's.whatsapp.net' && server !== 'c.us') return '';
  return digitsOf(text.slice(0, at).split(':')[0]);
}

/** "123456789:5@lid" -> "123456789@lid" (sem o aparelho). Outros: "". */
export function lidFromJid(jid) {
  const text = String(jid || '');
  const at = text.indexOf('@');
  if (at < 0 || text.slice(at + 1) !== 'lid') return '';
  return text.slice(0, at).split(':')[0] + '@lid';
}

export function jidFromPhone(phone) {
  const digits = digitsOf(phone);
  return digits ? digits + '@s.whatsapp.net' : '';
}

/** A chave da conversa: o numero (sem o 9) ou, so com LID, "lid:<codigo>". */
export function chatKeyFor({ phone, lid }) {
  const canonical = canonicalPhone(phone);
  if (canonical) return canonical;
  const code = String(lid || '').split('@')[0];
  return code ? 'lid:' + code : '';
}
