/**
 * As regras de login e senha, num lugar so: elas valem igual para quem a tela
 * de manutencao transforma em administrador e para o administrador que troca a
 * propria senha.
 */
import Person from "../models/Person.js";
import { devUsername } from "./devAccess.js";

// "/" nao entra na lista de proposito: e o que mantem o login de manutencao
// ("/usuariomaster") impossivel de cadastrar como conta de verdade.
const USERNAME_PATTERN = /^[a-z0-9._-]{3,20}$/;
const MIN_PASSWORD = 6;

const USERNAME_ERROR =
  "O usuário deve ter de 3 a 20 caracteres, só letras, números, ponto, hífen ou _.";
const PASSWORD_ERROR =
  "A senha precisa ter pelo menos " + MIN_PASSWORD + " caracteres.";

// Esse texto TEM a forma de um login de conta? Usado para avisar, ao iniciar
// o servidor, se o login de manutencao foi configurado com um nome que poderia
// ser de uma conta de verdade (ele e checado antes do banco, entao esconderia
// a conta de quem tivesse esse login).
export function isAccountUsernameShape(value) {
  return USERNAME_PATTERN.test(cleanUsername(value));
}

export function cleanUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

/**
 * Confere o login digitado. Devolve { username } ou { error }.
 * Nao vai ao banco: quem precisa checar se o login ja esta em uso chama
 * usernameTaken().
 */
export function readUsername(value) {
  const username = cleanUsername(value);
  if (!USERNAME_PATTERN.test(username)) return { error: USERNAME_ERROR };
  // Cinto e suspensorio: o padrao acima ja barra a "/", mas se algum dia ele
  // mudar, o login de manutencao continua reservado.
  if (username === devUsername()) {
    return { error: "Esse usuário é reservado pelo sistema. Escolha outro." };
  }
  return { username };
}

export function readPassword(value) {
  const password = String(value || "");
  if (password.length < MIN_PASSWORD) return { error: PASSWORD_ERROR };
  return { password };
}

// Ja existe OUTRA pessoa com esse login? (exceptId = a propria, ao editar.)
export async function usernameTaken(username, exceptId) {
  const filter = { username };
  if (exceptId) filter._id = { $ne: exceptId };
  return Boolean(await Person.exists(filter));
}
