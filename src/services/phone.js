import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Recebe so os digitos com DDI (ex.: 5534997885466), como o front envia, e
 * confere se e um numero real do pais indicado. Vazio e permitido (o campo e
 * opcional). Devolve null quando o numero e invalido.
 */
export function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  const parsed = parsePhoneNumberFromString("+" + digits);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number.slice(1); // tira o "+": formato aceito pelo wa.me
}

// O telefone com quase tudo escondido, para o que e publico: so o codigo do
// pais e os 2 ultimos digitos (5534997885466 -> "+55 *******66"). O numero de
// asteriscos e sempre o mesmo, para nao contar o tamanho do numero. Vazio
// quando nao ha telefone.
export function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  const country = parsePhoneNumberFromString("+" + digits)?.countryCallingCode;
  return (country ? "+" + country + " " : "") + "*******" + digits.slice(-2);
}

export const PHONE_ERROR =
  "WhatsApp inválido. Confira o país, o DDD e o número.";
