import crypto from "node:crypto";
import jwt from "jsonwebtoken";

/**
 * reCAPTCHA do site inteiro (acervo publico, login e painel).
 *
 * Quem abre qualquer pagina do site marca o "Nao sou um robo" do Google. O
 * app manda a resposta do Google para ca (POST /api/public/captcha), o
 * servidor confere com o Google e devolve um PASSE: um token assinado, que
 * vale por PASS_HOURS. TODA rota de /api (menos o health check e a entrada
 * do proprio captcha) exige esse passe no cabecalho X-Catalogo-Passe
 * (requireSitePass). Assim, um robo nao consegue martelar a consulta do
 * acervo, nem tentar senhas no login, sem antes passar pelo Google - e mesmo
 * com um passe na mao, cada passe tem o seu limite de pedidos por minuto no
 * acervo publico (ver server.js).
 *
 * O passe so prova "um humano marcou a caixa neste aparelho": quem pode mexer
 * no painel continua sendo decidido pelo login (middleware/auth.js). O nome
 * do cabecalho e o texto "passe-acervo" ficaram do tempo em que so o
 * catalogo pedia a caixa; foram mantidos para os passes ja entregues e os
 * apps ja instalados continuarem valendo.
 *
 * O passe e assinado com uma chave DERIVADA do JWT_SECRET, e nao com a mesma:
 * ele nunca serve de login no painel, e o login nunca serve de passe.
 *
 * Ligado so quando as duas chaves estao no ambiente (RECAPTCHA_SITE_KEY e
 * RECAPTCHA_SECRET_KEY, criadas em https://www.google.com/recaptcha/admin,
 * tipo "Desafio (v2)" > "Caixa de selecao Nao sou um robo"). Sem elas, o
 * catalogo continua aberto como antes e o servidor avisa no log ao iniciar.
 */

// Por quanto tempo o passe vale: quem entrou no domingo de manha nao marca a
// caixa de novo a cada vez que abre o site no mesmo dia.
export const PASS_HOURS = 12;
export const PASS_HEADER = "x-catalogo-passe";

const VERIFY_URL = "https://www.google.com/recaptcha/api/siteverify";
const VERIFY_TIMEOUT_MS = 10000;
// A resposta do Google tem uns 500 a 2000 caracteres; bem acima disso nao e dele.
const MAX_TOKEN_LENGTH = 8000;

function siteKey() {
  return (process.env.RECAPTCHA_SITE_KEY || "").trim();
}

function secretKey() {
  return (process.env.RECAPTCHA_SECRET_KEY || "").trim();
}

export function captchaEnabled() {
  return Boolean(siteKey() && secretKey());
}

// O que o app precisa para desenhar a caixa. A chave do site e publica (vai
// no HTML de qualquer site com reCAPTCHA); a secreta nunca sai daqui.
export function captchaConfig() {
  return captchaEnabled()
    ? { enabled: true, siteKey: siteKey() }
    : { enabled: false, siteKey: null };
}

function passSecret() {
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update("passe-do-acervo-publico")
    .digest("hex");
}

export function issuePass() {
  const token = jwt.sign({ typ: "passe-acervo" }, passSecret(), {
    expiresIn: PASS_HOURS + "h",
    jwtid: crypto.randomUUID(),
  });
  // Em segundos, e nao uma data: o app conta o vencimento no relogio do
  // proprio aparelho (que pode estar errado).
  return { pass: token, expiresIn: PASS_HOURS * 3600 };
}

// Erro com o status e a mensagem que vao para quem chamou.
function captchaError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * Confere com o Google a resposta da caixa. Resolve sem valor quando ela e
 * valida; senao lanca um erro com status e mensagem em portugues.
 */
export async function verifyCaptcha(token, remoteIp) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) {
    throw captchaError(400, "Marque a caixa “Não sou um robô” para continuar.");
  }

  const body = new URLSearchParams({ secret: secretKey(), response: token });
  if (remoteIp) body.set("remoteip", remoteIp);

  let result;
  try {
    const response = await fetch(VERIFY_URL, {
      method: "POST",
      body,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error("Google respondeu " + response.status);
    result = await response.json();
  } catch (error) {
    console.error("[captcha] Não foi possível conferir com o Google:", error.message);
    throw captchaError(
      503,
      "Não foi possível conferir a verificação agora. Tente de novo em instantes.",
    );
  }

  if (result?.success === true) return;

  const codes = Array.isArray(result?.["error-codes"]) ? result["error-codes"] : [];
  // Chave secreta errada ou faltando: e configuracao do servidor, nao culpa
  // de quem marcou a caixa. Fica no log para quem publica.
  if (codes.some((code) => /secret/.test(code))) {
    console.error(
      "[captcha] O Google recusou a chave secreta (" + codes.join(", ") + "). " +
        "Confira RECAPTCHA_SECRET_KEY no ambiente.",
    );
    throw captchaError(
      503,
      "A verificação do site está com um problema. Avise a equipe da biblioteca.",
    );
  }
  // Resposta vencida (a caixa fica valida por 2 minutos) ou ja usada.
  throw captchaError(
    400,
    "A verificação expirou. Marque a caixa “Não sou um robô” de novo.",
    "CAPTCHA_EXPIRED",
  );
}

/**
 * Le o passe do site, sem recusar nada: passe valido deixa o id dele em
 * req.sitePassId (a chave dos limites por passe, em server.js). Vem antes dos
 * limites de pedidos, que tratam diferente quem tem passe.
 */
export function readSitePass(req, res, next) {
  if (!captchaEnabled()) return next();
  const token = req.get(PASS_HEADER);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, passSecret());
    if (payload.typ === "passe-acervo" && payload.jti) req.sitePassId = payload.jti;
  } catch {
    /* passe vencido ou falso: segue como quem nao tem passe */
  }
  return next();
}

/**
 * Exige o passe do site (lido antes por readSitePass). Desligado (sem as
 * chaves no ambiente), deixa tudo passar, como antes.
 */
export function requireSitePass(req, res, next) {
  if (!captchaEnabled() || req.sitePassId) return next();
  return res.status(403).json({
    error: "Confirme que você não é um robô para continuar.",
    code: "CAPTCHA_REQUIRED",
  });
}

// Aviso no log ao iniciar (como o do login de manutencao).
export function warnAboutCaptcha() {
  if (captchaEnabled()) return;
  if (siteKey() || secretKey()) {
    console.warn(
      "ATENÇÃO: o reCAPTCHA do site está DESLIGADO porque só uma das duas chaves foi definida. " +
        "Defina RECAPTCHA_SITE_KEY e RECAPTCHA_SECRET_KEY no ambiente (no Render: Environment).",
    );
    return;
  }
  console.warn(
    "Aviso: o reCAPTCHA do site está desligado (sem RECAPTCHA_SITE_KEY e RECAPTCHA_SECRET_KEY). " +
      "O site abre sem a verificação \"Não sou um robô\".",
  );
}
