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

export const PHONE_ERROR =
  "WhatsApp inválido. Confira o país, o DDD e o número.";
