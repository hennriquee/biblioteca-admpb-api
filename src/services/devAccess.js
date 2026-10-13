/**
 * O LOGIN RESERVADO DE MANUTENCAO.
 *
 * Digitar "/usuariomaster" no usuario e "senha_forte" na senha na tela de entrada nao faz
 * login de administrador: abre a tela de manutencao, a unica em que se cria
 * administrador, se desfaz administrador e se troca senha de alguem.
 *
 * Por que isso nao e uma conta no banco: nenhuma conta de verdade pode ter
 * esse nome (o login aceito tem so letras, numeros, ponto, hifen e "_", e "/"
 * nao esta na lista - ver USERNAME_PATTERN em services/credentials.js), entao
 * os dois nunca se confundem e ninguem consegue cadastrar um login parecido
 * para se passar por manutencao.
 *
 * TROQUE ISSO NO SERVIDOR: como o valor padrao esta escrito aqui, qualquer um
 * que leia o codigo sabe qual e. Em producao, defina DEV_USERNAME e
 * DEV_PASSWORD no .env (no Render, em Environment) e so voce passa por aqui.
 */
const DEFAULT_USERNAME = "/usuariomaster";
const DEFAULT_PASSWORD = "senha_forte";

export function devUsername() {
  return (process.env.DEV_USERNAME || DEFAULT_USERNAME).trim().toLowerCase();
}

function devPassword() {
  return process.env.DEV_PASSWORD || DEFAULT_PASSWORD;
}

// "username" ja chega sem espacos e em minusculas (ver routes/auth.js).
export function isDevLogin(username, password) {
  return username === devUsername() && password === devPassword();
}

// O login de manutencao ainda e o que esta escrito aqui no codigo?
export function usingDefaultDevLogin() {
  return !process.env.DEV_USERNAME || !process.env.DEV_PASSWORD;
}
