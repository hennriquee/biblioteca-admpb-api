/**
 * "Avise-me quando voltar" do acervo publico: quem abre no /catalogo um livro
 * que esta todo emprestado pode pedir uma notificacao no proprio celular (ou
 * computador) para quando ele voltar para a estante.
 *
 * Como funciona, sem login e sem custo: e o Web Push, o padrao de notificacao
 * dos navegadores. O navegador da pessoa cria uma "inscricao" (um endereco no
 * servico de notificacao do fabricante: Google no Chrome/Android, Apple no
 * iPhone, Mozilla no Firefox, Microsoft no Edge), o catalogo manda essa
 * inscricao para ca (routes/alerts.js) e, quando a devolucao e confirmada no
 * painel, este servidor manda a mensagem para aquele endereco. Nenhum dado
 * pessoal entra no caminho.
 *
 * As mensagens vao assinadas por um par de chaves (VAPID) deste servidor. As
 * chaves sao criadas sozinhas no primeiro uso e ficam guardadas no banco (ver
 * models/Setting.js) - nao ha nada para configurar. Quem quiser usar chaves
 * proprias define VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no ambiente.
 */
import webpush from "web-push";
import Book from "../models/Book.js";
import Loan from "../models/Loan.js";
import ReturnAlert from "../models/ReturnAlert.js";
import Setting from "../models/Setting.js";

// Servicos de notificacao dos navegadores. O servidor so manda mensagem para
// enderecos destes servicos: sem essa lista, qualquer um poderia cadastrar um
// endereco qualquer (inclusive da rede interna do Render) e fazer o servidor
// chamar esse endereco a cada devolucao. Navegador novo com outro servico
// entra aqui.
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com", // Chrome, Android, Samsung Internet, Opera, Brave
  "android.googleapis.com", // inscricoes antigas do Chrome
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari (iPhone com o catalogo na tela de inicio, Mac)
]);
const PUSH_HOST_SUFFIXES = [
  ".notify.windows.com", // Edge (ex.: wns2-par02p.notify.windows.com)
];

// Os enderecos reais tem de 150 a 500 caracteres; o teto so barra lixo.
const MAX_ENDPOINT_LENGTH = 1024;

// Forma que o endereco precisa ter: "https://" + host feito so de letras,
// numeros, ponto e hifen (sem porta e sem usuario) + caminho com os
// caracteres normais de endereco. Nao basta conferir o host com new URL: o
// web-push conecta lendo o endereco com o url.parse antigo do Node, que corta
// o host em outros caracteres. "https://127.0.0.1;.notify.windows.com/x"
// passaria pela lista (new URL le o host inteiro, que termina no sufixo
// aceito) e a conexao iria para 127.0.0.1. Com o host so desses caracteres,
// os dois leem o mesmo host.
const ENDPOINT_SHAPE =
  /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[A-Za-z0-9\-._~%!$&()*+,;=:@/?]*)?$/i;
export const MAX_TITLE_LENGTH = 160;

// Tetos contra quem tentar encher o banco de pedidos falsos. Uma pessoa de
// verdade nao chega perto de nenhum deles.
export const MAX_ALERTS_PER_DEVICE = 30;
export const MAX_ALERTS_PER_BOOK = 500;
export const MAX_ALERTS_TOTAL = 20000;

// Celular desligado ou sem internet: o servico do fabricante segura a
// mensagem por ate 3 dias e entrega quando ele voltar. Depois disso a
// noticia ja nao vale (o livro pode ter saido de novo) e e descartada.
const PUSH_TTL_SECONDS = 3 * 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10 * 1000;
// Quantas mensagens saem ao mesmo tempo quando muita gente pediu aviso do
// mesmo livro.
const SEND_CONCURRENCY = 5;

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// ---------- Chaves (VAPID) ----------

// Quem assina as mensagens. O servico da Apple exige um endereco https ou um
// e-mail; o padrao e o endereco do site (o primeiro https de CORS_ORIGIN).
function vapidSubject() {
  const configured = (process.env.VAPID_SUBJECT || "").trim();
  if (configured) return configured;
  const site = String(process.env.CORS_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .find((origin) => origin.startsWith("https://"));
  return site || "mailto:avisos@biblioteca-admpb.invalid";
}

async function loadKeys() {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  if (publicKey && privateKey) return { publicKey, privateKey };

  // $setOnInsert com upsert: o par gerado aqui so e gravado se ainda nao
  // existir nenhum. Dois servidores subindo juntos acabam com o MESMO par (o
  // que chegou primeiro), nunca com dois.
  const fresh = webpush.generateVAPIDKeys();
  const saved = await Setting.findOneAndUpdate(
    { _id: "webpush" },
    { $setOnInsert: { value: fresh } },
    { upsert: true, new: true, lean: true },
  );
  return saved.value;
}

let keysPromise = null;

// Carrega as chaves uma vez e deixa o web-push pronto para assinar. Se falhar
// (banco fora, chave do ambiente com erro), tenta de novo na proxima chamada.
export function getPushKeys() {
  if (!keysPromise) {
    keysPromise = loadKeys()
      .then((keys) => {
        webpush.setVapidDetails(vapidSubject(), keys.publicKey, keys.privateKey);
        return keys;
      })
      .catch((error) => {
        keysPromise = null;
        throw error;
      });
  }
  return keysPromise;
}

// ---------- Leitura do que o catalogo manda ----------

function isPushHost(hostname) {
  return (
    PUSH_HOSTS.has(hostname) ||
    PUSH_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

function keyBytes(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  return Buffer.from(value, "base64url");
}

/** Id de livro valido (texto de 24 hexadecimais) ou null. */
export function readBookId(value) {
  return typeof value === "string" && OBJECT_ID.test(value) ? value : null;
}

/**
 * Endereco de notificacao como texto simples, ou null. Usado para CONSULTAR e
 * CANCELAR: precisa ser texto - um objeto como { "$ne": null } viraria um
 * operador do Mongo e acharia o pedido de outra pessoa.
 */
export function readEndpoint(value) {
  if (typeof value !== "string") return null;
  const endpoint = value.trim();
  return endpoint && endpoint.length <= MAX_ENDPOINT_LENGTH ? endpoint : null;
}

/**
 * A inscricao que o navegador criou (PushSubscription.toJSON()), conferida:
 * endereco https de um servico de notificacao conhecido e as duas chaves no
 * tamanho certo. Devolve { endpoint, p256dh, auth } ou null.
 */
export function readSubscription(raw) {
  if (!raw || typeof raw !== "object") return null;
  const endpoint = readEndpoint(raw.endpoint);
  if (!endpoint) return null;

  const shape = ENDPOINT_SHAPE.exec(endpoint);
  if (!shape) return null;
  const host = shape[1].toLowerCase();
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  // Conferencia dupla: o host que a forma separou tem de ser o mesmo que o
  // new URL le, e tem de ser de um servico de notificacao conhecido.
  if (url.hostname !== host || !isPushHost(host)) return null;

  const keys = raw.keys && typeof raw.keys === "object" ? raw.keys : {};
  const p256dh = keyBytes(keys.p256dh);
  const auth = keyBytes(keys.auth);
  // p256dh: ponto da curva P-256 sem compressao (65 bytes, comeca com 0x04).
  // auth: segredo de 16 bytes.
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return null;
  if (!auth || auth.length !== 16) return null;

  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

/** Titulo para o texto da notificacao: texto curto, sem caracteres de controle. */
export function readTitle(value) {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_TITLE_LENGTH)
    : "";
}

// ---------- Situacao do livro ----------

/**
 * Livro com TODOS os exemplares emprestados agora? Devolve o livro ({ _id,
 * title, copies }) com `fullyLoaned`, ou null se ele nao existe.
 */
export async function bookAvailability(bookId) {
  const book = await Book.findById(bookId).select("title copies").lean();
  if (!book) return null;
  const loaned = await Loan.countDocuments({ book: book._id, status: "ativo" });
  return { ...book, fullyLoaned: loaned >= (book.copies || 1) };
}

// ---------- Envio ----------

function messageFor(alert, book) {
  const title = alert.bookTitle || book.title;
  const id = String(book._id);
  return JSON.stringify({
    title: "Livro disponível na biblioteca",
    body:
      "“" +
      title +
      "” voltou para a estante. Procure a equipe da biblioteca para pegar emprestado.",
    // O toque na notificacao abre o catalogo ja com este livro aberto.
    url: "/catalogo?livro=" + id,
    tag: "livro-" + id,
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Falha temporaria do servico do fabricante (sem resposta, demora, 429 ou
// 5xx): tenta de novo depois destas esperas. Exportado so para os testes
// poderem encurtar.
export const RETRY_DELAYS_MS = [30 * 1000, 2 * 60 * 1000];
// Marca de "enviando" mais velha que isso e de um envio que nao terminou
// (servidor caiu ou dormiu no meio): o pedido pode ser tomado de novo. Bem
// acima do pior caso de um envio (3 tentativas de 10 s mais as esperas).
const CLAIM_STALE_MS = 10 * 60 * 1000;
// Rodadas de falha passageira (cada uma ja com as novas tentativas) antes de
// o pedido ser descartado.
const MAX_FAILED_ROUNDS = 5;

// Erros de rede que nao passam esperando: o endereco nao existe (DNS), recusa
// a conexao ou tem certificado errado. Servico de verdade nao faz isso - e o
// caso de um pedido com endereco inventado ("0-x.notify.windows.com"), que
// nao pode ficar segurando a fila nem o banco.
const PERMANENT_NETWORK_ERRORS = new Set([
  "ENOTFOUND",
  "ECONNREFUSED",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function isTemporary(error) {
  if (PERMANENT_NETWORK_ERRORS.has(error.code)) return false;
  const status = error.statusCode;
  return !status || status === 429 || status >= 500;
}

// Antes de cada nova tentativa: o pedido ainda existe (a pessoa pode ter
// cancelado na espera) e o livro continua na estante (pode ter saido de novo)?
async function stillWanted(alert, book) {
  if (!(await ReturnAlert.exists({ _id: alert._id }))) return "cancelled";
  const now = await bookAvailability(book._id);
  return now && !now.fullyLoaned ? "yes" : "waiting";
}

// Manda a notificacao de um pedido. Devolve:
// - "sent": entregue ao servico do fabricante;
// - "gone": a inscricao nao existe mais;
// - "failed": recusada de vez (nao adianta tentar de novo);
// - "later": falha passageira que nao passou com as novas tentativas;
// - "cancelled": a pessoa cancelou durante as tentativas;
// - "waiting": o livro saiu de novo durante as tentativas.
async function deliver(alert, book) {
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const wanted = await stillWanted(alert, book);
      if (wanted !== "yes") return wanted;
    }
    try {
      await webpush.sendNotification(
        { endpoint: alert.endpoint, keys: { p256dh: alert.p256dh, auth: alert.auth } },
        messageFor(alert, book),
        { TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS, urgency: "normal" },
      );
      return "sent";
    } catch (error) {
      // 404/410: a inscricao deixou de existir (a pessoa limpou os dados do
      // navegador, desinstalou o app ou bloqueou as notificacoes).
      if (error.statusCode === 404 || error.statusCode === 410) return "gone";
      const temporary = isTemporary(error);
      if (temporary && attempt < RETRY_DELAYS_MS.length) {
        await wait(RETRY_DELAYS_MS[attempt]);
        continue;
      }
      console.error(
        "[avisos] Falha ao avisar sobre o livro " +
          String(book._id) +
          " (" +
          (error.statusCode || error.code || "sem resposta") +
          "): " +
          (error.body || error.message) +
          (temporary ? " O pedido fica guardado para tentar de novo." : ""),
      );
      return temporary ? "later" : "failed";
    }
  }
}

// Marca o pedido como "enviando" e devolve-o, ou null se outro envio ja o
// marcou (e a marca ainda nao e velha).
function claim(alert) {
  return ReturnAlert.findOneAndUpdate(
    {
      _id: alert._id,
      $or: [
        { sendingAt: null },
        { sendingAt: { $lt: new Date(Date.now() - CLAIM_STALE_MS) } },
      ],
    },
    { $set: { sendingAt: new Date() } },
    { new: true, lean: true },
  );
}

// Tira a marca de "enviando": o pedido volta a esperar.
function release(alert, extra = {}) {
  return ReturnAlert.findOneAndUpdate(
    { _id: alert._id },
    { $set: { sendingAt: null }, ...extra },
    { new: true, lean: true },
  );
}

// Fim do pedido depois de um envio que terminou (entregue ou recusado).
async function finish(alert) {
  // So apaga se a pessoa nao renovou o pedido enquanto o envio acontecia (a
  // renovacao troca o createdAt): o pedido renovado e para a PROXIMA
  // devolucao e continua esperando.
  const removed = await ReturnAlert.deleteOne({
    _id: alert._id,
    createdAt: alert.createdAt,
  });
  if (!removed.deletedCount) await release(alert);
}

async function notifyIfAvailable(bookId) {
  // Quase toda devolucao nao tem ninguem esperando: uma consulta so e acabou.
  if (!(await ReturnAlert.exists({ book: bookId }))) return;

  const book = await bookAvailability(bookId);
  if (!book) {
    // Livro excluido: os pedidos dele nao tem mais o que avisar.
    await ReturnAlert.deleteMany({ book: bookId });
    return;
  }
  if (book.fullyLoaned) return;

  await getPushKeys();
  const pending = await ReturnAlert.find({ book: book._id }).lean();

  let sent = 0;
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const alert = pending[next];
      next += 1;
      // So quem marcou manda: duas devolucoes do mesmo livro ao mesmo tempo
      // (dois exemplares) nunca mandam o aviso duas vezes para o mesmo
      // aparelho.
      const claimed = await claim(alert);
      if (!claimed) continue;
      const result = await deliver(claimed, book);
      if (result === "sent") sent += 1;
      if (result === "gone") {
        // Os outros pedidos desse aparelho tambem nao serviriam mais.
        await ReturnAlert.deleteMany({ endpoint: claimed.endpoint });
      } else if (result === "later") {
        // Volta a esperar (ver retryPendingAlerts) - mas nao para sempre.
        const kept = await release(claimed, { $inc: { failures: 1 } });
        if (kept && kept.failures >= MAX_FAILED_ROUNDS) {
          await ReturnAlert.deleteOne({ _id: kept._id, sendingAt: null });
        }
      } else if (result === "waiting") {
        await release(claimed);
      } else if (result !== "cancelled") {
        await finish(claimed);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(SEND_CONCURRENCY, pending.length) }, worker),
  );

  if (sent) {
    console.log(
      "[avisos] " + sent + " aviso(s) de livro disponível enviado(s) (" + book.title + ").",
    );
  }
}

function logCheckFailure(bookId, error) {
  console.error(
    "[avisos] Não foi possível conferir os avisos do livro " + String(bookId) + ":",
    error.message,
  );
}

/**
 * Chamado quando um exemplar pode ter voltado para a estante (devolucao
 * confirmada, emprestimo apagado, quantidade aumentada). Confere a situacao
 * e avisa quem estava esperando o livro.
 *
 * Nao espera o envio e nunca lanca erro: a resposta para o painel sai na
 * hora, e uma falha no aviso fica so no log - a devolucao ja esta gravada (e
 * o pedido continua guardado; ver retryPendingAlerts).
 */
export function announceAvailability(bookId) {
  notifyIfAvailable(bookId).catch((error) => logCheckFailure(bookId, error));
}

/**
 * Rede de seguranca, chamada quando o servidor inicia (no Render gratuito,
 * cada vez que ele acorda): avisa os pedidos que ficaram para tras - livro
 * que ja esta na estante, mas cujo aviso nao saiu (servico do fabricante fora
 * do ar, servidor que caiu no meio do envio, devolucao que aconteceu no mesmo
 * instante do pedido). Roda em segundo plano, um livro por vez.
 */
export function retryPendingAlerts() {
  (async () => {
    const books = await ReturnAlert.distinct("book");
    for (const bookId of books) {
      await notifyIfAvailable(bookId).catch((error) => logCheckFailure(bookId, error));
    }
  })().catch((error) => {
    console.error("[avisos] Não foi possível conferir os avisos pendentes:", error.message);
  });
}
