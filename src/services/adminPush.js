/**
 * NOTIFICACOES DO APP para os ADMINISTRADORES (Configurações > Notificações).
 *
 * Cada administrador escolhe o que quer receber (Person.notify) e ativa em
 * cada aparelho dele (models/AdminDevice.js). Quando acontece um dos assuntos
 * abaixo, o servidor manda um Web Push SO para quem escolheu aquele assunto -
 * o mesmo padrao, as mesmas chaves e a mesma conferencia de endereco do
 * "Avise-me quando voltar" do acervo (services/returnAlerts.js):
 *
 * - "requests": SOLICITACAO NOVA de emprestimo feita no acervo publico. A
 *   notificacao traz o botao "Registrar solicitação", que abre o painel ja no
 *   "Registrar solicitação" preenchido - o mesmo caminho do link que vai na
 *   mensagem (/solicitacao/<id>);
 * - "loans": EMPRESTIMO NOVO registrado no painel por outro administrador;
 * - "suggestions": livro sugerido no acervo publico;
 * - "messages": mensagem nova no WhatsApp da biblioteca (uma por conversa a
 *   cada MESSAGE_GAP_MS, para o celular nao tocar a cada linha).
 *
 * Nao tem nada de WhatsApp aqui: e notificacao do proprio app, no aparelho do
 * administrador. Nunca lanca erro para quem chama: a falha fica no log.
 */
import webpush from "web-push";
import AdminDevice from "../models/AdminDevice.js";
import Person from "../models/Person.js";
import { getPushKeys, readSubscription } from "./returnAlerts.js";

export const NOTIFY_KINDS = ["requests", "loans", "suggestions", "messages"];

// Teto de aparelhos por administrador (celular, computador de casa, da
// igreja...): o mais antigo sai quando passa.
export const MAX_DEVICES_PER_ADMIN = 10;
// Falhas seguidas (servico do fabricante fora) antes de o aparelho sair.
const MAX_FAILURES = 10;
const STALE_DEVICE_MS = 3 * 24 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 10 * 1000;
// Quanto tempo o servico do fabricante segura a notificacao com o aparelho
// desligado: depois disso a noticia ja nao serve.
const TTL_SECONDS = {
  requests: 2 * 24 * 60 * 60,
  loans: 2 * 24 * 60 * 60,
  suggestions: 3 * 24 * 60 * 60,
  messages: 12 * 60 * 60,
  test: 60 * 60,
};
// Mensagens: no maximo uma notificacao por conversa neste intervalo.
const MESSAGE_GAP_MS = 10 * 60 * 1000;
const SEND_CONCURRENCY = 5;

/** { requests, suggestions, messages } so com true/false. */
export function readKinds(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return Object.fromEntries(NOTIFY_KINDS.map((kind) => [kind, source[kind] === true]));
}

/** O nome do aparelho a partir do navegador ("Edge no Windows"). */
export function deviceLabel(userAgent) {
  const ua = String(userAgent || "");
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Chrome\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Navegador";
  const system = /Android/.test(ua)
    ? "Android"
    : /iPhone|iPad|iPod/.test(ua)
      ? "iPhone/iPad"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return system ? browser + " no " + system : browser;
}

/**
 * Liga este aparelho (a inscricao que o navegador criou) a conta. Devolve o
 * aparelho, ou null se a inscricao nao e de um servico conhecido.
 */
export async function saveDevice(personId, rawSubscription, userAgent) {
  const subscription = readSubscription(rawSubscription);
  if (!subscription) return null;
  const device = await AdminDevice.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    {
      $set: {
        person: personId,
        p256dh: subscription.p256dh,
        auth: subscription.auth,
        label: deviceLabel(userAgent).slice(0, 60),
        failures: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  // Passou do teto: saem os mais antigos.
  const extra = await AdminDevice.find({ person: personId })
    .sort({ updatedAt: -1, _id: -1 })
    .skip(MAX_DEVICES_PER_ADMIN)
    .select("_id")
    .lean();
  if (extra.length) await AdminDevice.deleteMany({ _id: { $in: extra.map((d) => d._id) } });
  return device;
}

function isGone(error) {
  return error?.statusCode === 404 || error?.statusCode === 410;
}

// Envia para um aparelho. true = entregue ao servico do fabricante.
async function deliver(device, payload, ttl, urgency) {
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      { TTL: ttl, timeout: PUSH_TIMEOUT_MS, urgency },
    );
    if (device.failures || !device.lastOkAt || Date.now() - new Date(device.lastOkAt).getTime() > 60 * 60 * 1000) {
      await AdminDevice.updateOne({ _id: device._id }, { $set: { failures: 0, lastOkAt: new Date() } });
    }
    return true;
  } catch (error) {
    if (isGone(error)) {
      // A inscricao deixou de existir (dados do navegador apagados, permissao
      // retirada): o aparelho sai da lista.
      await AdminDevice.deleteOne({ _id: device._id });
      return false;
    }
    const kept = await AdminDevice.findOneAndUpdate(
      { _id: device._id },
      { $inc: { failures: 1 } },
      { new: true },
    ).lean();
    // So sai depois de muitas falhas E sem nenhuma entrega ha dias (o
    // servico do fabricante fora do ar por algumas horas nao tira ninguem).
    const lastOk = kept?.lastOkAt || kept?.createdAt;
    if (
      kept &&
      kept.failures >= MAX_FAILURES &&
      (!lastOk || Date.now() - new Date(lastOk).getTime() > STALE_DEVICE_MS)
    ) {
      await AdminDevice.deleteOne({ _id: kept._id });
    }
    console.error(
      "[notificacoes] Falha ao notificar um aparelho de administrador (" +
        (error?.statusCode || error?.code || "sem resposta") +
        "): " +
        (error?.body || error?.message || ""),
    );
    return false;
  }
}

async function sendToDevices(devices, message, kind) {
  if (!devices.length) return 0;
  await getPushKeys();
  const payload = JSON.stringify(message);
  const ttl = TTL_SECONDS[kind] || TTL_SECONDS.test;
  const urgency = kind === "suggestions" || kind === "loans" ? "normal" : "high";
  let next = 0;
  let sent = 0;
  async function worker() {
    while (next < devices.length) {
      const device = devices[next];
      next += 1;
      if (await deliver(device, payload, ttl, urgency)) sent += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, devices.length) }, worker));
  return sent;
}

/**
 * Os administradores (que AINDA tem login) que escolheram o assunto, menos
 * exceptPerson (quem fez a acao nao precisa ser avisado dela).
 */
async function devicesFor(kind, exceptPerson) {
  const people = await Person.find({
    username: { $type: "string" },
    ["notify." + kind]: true,
    ...(exceptPerson ? { _id: { $ne: exceptPerson } } : {}),
  })
    .select("_id")
    .lean();
  if (!people.length) return [];
  return AdminDevice.find({ person: { $in: people.map((p) => p._id) } }).lean();
}

/**
 * Avisa quem escolheu o assunto. Nao espera nem lanca erro (a resposta de
 * quem chamou sai na hora). message = { title, body, url, tag, actions }.
 */
export function notifyAdmins(kind, message, { exceptPerson = null } = {}) {
  if (!NOTIFY_KINDS.includes(kind)) return;
  (async () => {
    const devices = await devicesFor(kind, exceptPerson);
    await sendToDevices(devices, { kind, ...message }, kind);
  })().catch((error) => {
    console.error("[notificacoes] Não foi possível avisar os administradores:", error.message);
  });
}

/** Notificacao de teste para os aparelhos DESTE administrador. */
export async function sendTest(personId) {
  const devices = await AdminDevice.find({ person: personId }).lean();
  const sent = await sendToDevices(
    devices,
    {
      kind: "test",
      title: "Notificações da biblioteca",
      body: "Tudo certo: este aparelho recebe as notificações que você escolheu.",
      url: "/configuracoes/notificacoes",
      tag: "teste",
    },
    "test",
  );
  return { devices: devices.length, sent };
}

// ---------- Os textos de cada assunto ----------

function oneLine(value, max) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function brDay(date) {
  const day = new Date(date);
  if (Number.isNaN(day.getTime())) return "";
  return day.toISOString().slice(0, 10).split("-").reverse().slice(0, 2).join("/");
}

/** Solicitacao nova do acervo publico (pendente, com o link). */
export function notifyNewRequest(request) {
  const url = "/solicitacao/" + encodeURIComponent(request.token);
  const when = brDay(request.pickupDate);
  notifyAdmins("requests", {
    title: "Nova solicitação de empréstimo",
    body:
      oneLine(request.requesterName, 80) +
      (request.requesterIsNew ? " (novo cadastro)" : "") +
      " quer pegar “" +
      oneLine(request.bookTitle, 90) +
      "”" +
      (when ? " · retirada em " + when : "") +
      ".",
    url,
    tag: "solicitacao-" + request.token,
    actions: [
      { action: "registrar", title: "Registrar solicitação", url },
      { action: "ver", title: "Ver notificações", url: "/inicio?notificacoes=1" },
    ],
  });
}

/**
 * Emprestimo novo registrado no painel (Novo empréstimo ou uma solicitacao
 * que virou emprestimo). Quem registrou nao recebe (exceptPerson).
 */
export function notifyNewLoan(loan, { exceptPerson = null } = {}) {
  const url = "/emprestimos";
  const when = brDay(loan.dueDate);
  notifyAdmins(
    "loans",
    {
      title: "Novo empréstimo",
      body:
        oneLine(loan.personName, 80) +
        " levou “" +
        oneLine(loan.bookTitle, 90) +
        "”" +
        (when ? " · devolução até " + when : "") +
        (loan.approvedByName ? " (registrado por " + oneLine(loan.approvedByName, 40).split(" ")[0] + ")" : "") +
        ".",
      url,
      tag: "emprestimo-" + String(loan._id),
      actions: [{ action: "ver", title: "Ver empréstimos", url }],
    },
    { exceptPerson },
  );
}

/** Livro sugerido no acervo publico. */
export function notifyNewSuggestion({ title, author }) {
  const url = "/configuracoes/sugestoes";
  notifyAdmins("suggestions", {
    title: "Livro sugerido no catálogo",
    body: "“" + oneLine(title, 100) + "”" + (author ? " – " + oneLine(author, 60) : "") + ".",
    url,
    tag: "sugestoes",
    actions: [{ action: "ver", title: "Ver sugestões", url }],
  });
}

const lastMessagePush = new Map();

/**
 * Mensagem nova no WhatsApp da biblioteca. Uma notificacao por conversa a
 * cada MESSAGE_GAP_MS (a mesma "etiqueta" troca a anterior no aparelho).
 */
export function notifyNewMessage({ chat, who, preview, now = Date.now() }) {
  const id = String(chat?._id || "");
  if (!id) return;
  const last = lastMessagePush.get(id) || 0;
  if (now - last < MESSAGE_GAP_MS) return;
  lastMessagePush.set(id, now);
  // (a memoria nao cresce sem fim)
  if (lastMessagePush.size > 500) {
    for (const [key, at] of lastMessagePush) if (now - at >= MESSAGE_GAP_MS) lastMessagePush.delete(key);
  }
  const url = "/conversas/" + id;
  notifyAdmins("messages", {
    title: "Mensagem no WhatsApp da biblioteca",
    body: oneLine(who, 60) + ": " + (oneLine(preview, 110) || "nova mensagem"),
    url,
    tag: "conversa-" + id,
    actions: [{ action: "responder", title: "Responder", url }],
  });
}
