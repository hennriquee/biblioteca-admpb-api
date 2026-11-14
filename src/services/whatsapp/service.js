import makeWASocket, {
  Browsers,
  DEFAULT_CONNECTION_CONFIG,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  generateMessageIDV2,
  isLidUser,
  isPnUser,
  makeCacheableSignalKeyStore,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import LoanRequest from '../../models/LoanRequest.js';
import Setting from '../../models/Setting.js';
import WaAuth from '../../models/WaAuth.js';
import WaChat from '../../models/WaChat.js';
import WaContact from '../../models/WaContact.js';
import WaMessage from '../../models/WaMessage.js';
import { useMongoAuthState } from './authState.js';
import { describeMessage } from './content.js';
import { between, defaultRng, typingPlan } from './humanize.js';
import { createLease } from './lease.js';
import {
  auditOutgoing,
  backfillContacts,
  brazilHour,
  contactOf,
  limitsFor,
  noteInbound,
  noteProactive,
  noteRestriction,
  pauseProactive,
  purposeOf,
  readHealth,
  readPolicyConfig,
  readRestriction,
  restartWarmup,
  unengagedRecent,
  warmupDay,
  warmupStartAt,
} from './policy.js';
import {
  digitsOf,
  lidFromJid,
  phoneFromJid,
  samePhone,
} from './phone.js';
import {
  markDeleted,
  markEdited,
  noteEphemeral,
  raiseStatus,
  resolveChat,
  saveMessage,
} from './store.js';

/**
 * A ligacao do painel com o WhatsApp da biblioteca (Baileys).
 *
 * O servidor entra no WhatsApp como um "aparelho conectado" do numero da
 * biblioteca (o mesmo que o WhatsApp Web). O QR code so e lido UMA vez: a
 * sessao fica guardada, cifrada, no MongoDB (authState.js) e o servidor volta
 * sozinho a cada reinicio.
 *
 * Estados (state):
 * - disabled      desligado neste servidor (WHATSAPP_ENABLED=false);
 * - sleeping      sessao salva, conexao fechada DE PROPOSITO (sob demanda:
 *                 ninguem nas Conversas); abre ao entrar na tela;
 * - idle          sem conexao e sem tentativa em andamento (falta o QR);
 * - standby       outra copia do servidor esta com a conexao (lease.js);
 * - connecting    abrindo a conexao;
 * - qr            esperando o QR (ou o codigo) ser lido no celular;
 * - open          conectado;
 * - reconnecting  caiu e vai tentar de novo;
 * - logged-out    o celular desconectou este aparelho (precisa do QR);
 * - wrong-number  alguem leu o QR com OUTRO numero: desfeito na hora;
 * - unreadable    ha sessao salva, mas a chave de cifra mudou;
 * - error         o WhatsApp recusou a conexao.
 *
 * Seguranca: o numero aceito vem do servidor (WHATSAPP_NUMBER) e nunca do
 * front; a sessao nunca e apagada por engano; nada sensivel vai para o log.
 *
 * NUMERO FIXO: o painel NAO desconecta o WhatsApp (nao ha rota nem metodo para
 * isso). A sessao so e apagada quando ela ja nao serve mais: o proprio celular
 * desvinculou o aparelho (logged-out), alguem leu o QR com outro numero
 * (wrong-number) ou a sessao salva quebrou de vez (recoverBrokenSession, que
 * so funciona nesse caso). Fora isso, o servidor reconecta sozinho, sempre.
 */

export class WhatsAppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);
// (settings) Envios das ultimas 24 h de conversas apagadas: ver keepSendCounts.
const SENT_LOG = 'whatsapp-sent-log';
// (settings) De qual numero sao as conversas do banco (ver #claimNumber), e
// a saude/restricao do numero (policy.js), que nao passam para um numero novo.
const NUMBER_KEY = 'whatsapp-number';
const HEALTH_KEY = 'whatsapp-health';
const RESTRICTION_KEY = 'whatsapp-restriction';

/**
 * Ligado por padrao SO no Render (que define RENDER=true): em qualquer outro
 * lugar - o computador de quem desenvolve, onde o .env costuma apontar para o
 * banco de producao - o padrao e desligado, para nunca disputar a conexao do
 * WhatsApp com o servidor de verdade. WHATSAPP_ENABLED=true/false decide
 * sempre, nos dois sentidos.
 */
function isEnabled(env) {
  const explicit = String(env.WHATSAPP_ENABLED ?? '').trim().toLowerCase();
  if (explicit) return !FALSY.has(explicit);
  return Boolean(String(env.RENDER ?? '').trim());
}

/**
 * MENSAGENS TEMPORARIAS (WHATSAPP_DISAPPEAR_DAYS, padrao 7): cada mensagem
 * some do painel esse tanto de dias depois de enviada, como no WhatsApp da
 * biblioteca. 0 = o painel guarda para sempre. (Minimo de 1 dia: os tetos
 * diarios de envio contam as mensagens das ultimas 24 h.)
 */
export function readDisappearDays(env = process.env) {
  const raw = String(env.WHATSAPP_DISAPPEAR_DAYS ?? '').trim();
  if (!raw) return 7;
  const days = Number(raw.replace(',', '.'));
  if (!Number.isFinite(days) || days < 0) return 7;
  return days > 0 && days < 1 ? 1 : days;
}

// De quantas em quantas horas a conexao sob demanda abre sozinha para buscar
// o que chegou (WHATSAPP_SYNC_HOURS, padrao 3; 0 = nunca; minimo meia hora).
function readSyncMs(env) {
  const raw = String(env.WHATSAPP_SYNC_HOURS ?? '').trim();
  const hours = raw ? Number(raw.replace(',', '.')) : 3;
  if (!Number.isFinite(hours) || hours < 0) return 3 * 60 * 60 * 1000;
  if (hours === 0) return 0;
  return Math.max(0.5, hours) * 60 * 60 * 1000;
}

export function readConfig(env = process.env) {
  const number = digitsOf(env.WHATSAPP_NUMBER || '13657963315');
  return {
    // Dias ate cada mensagem sumir do painel (0 = nunca).
    disappearDays: readDisappearDays(env),
    enabled: isEnabled(env),
    // O numero da biblioteca: +1 365 796 3315 (Canada, desde 13/11/2026; o
    // anterior era o argentino +54 9 11 6461-0665).
    number,
    // CONEXAO SOB DEMANDA (padrao; WHATSAPP_MODE=always volta ao antigo,
    // conectado o tempo todo): o servidor so fica conectado ao WhatsApp
    // enquanto um administrador esta na tela Conversas (e um pouco depois).
    // Fora disso a conexao fica FECHADA (a sessao continua salva, sem QR) e
    // abre sozinha de tempos em tempos (syncEveryMs) por alguns minutos, so
    // para receber o que chegou - como alguem que abre o WhatsApp Web, olha
    // e fecha. O WhatsApp guarda as mensagens para o aparelho e entrega tudo
    // quando ele conecta de novo.
    mode: String(env.WHATSAPP_MODE ?? '').trim().toLowerCase() === 'always' ? 'always' : 'on-demand',
    // Sem ninguem nas Conversas por este tempo (sorteado), a conexao fecha.
    awakeIdleMs: [6 * 60 * 1000, 11 * 60 * 1000],
    // As idas sozinhas: de quanto em quanto tempo (+-20%), por quanto tempo
    // e em que horario de Brasilia (fora dele, so na proxima).
    syncEveryMs: readSyncMs(env),
    syncStayMs: [2 * 60 * 1000, 4 * 60 * 1000],
    syncFromHour: 7,
    syncToHour: 22,
    // So fecha depois deste tempo sem chegar nada (o WhatsApp entrega as
    // mensagens guardadas aos poucos logo depois de conectar).
    quietMs: 20 * 1000,
    // Depois de conectar, fica aberta pelo menos isto (a entrega do que
    // estava guardado comeca logo, mas pode demorar alguns segundos).
    minOpenMs: 60 * 1000,
    // Teto de mensagens enviadas pelo painel nas ultimas 24 horas.
    dailyLimit: Number(env.WHATSAPP_DAILY_LIMIT) > 0 ? Number(env.WHATSAPP_DAILY_LIMIT) : 300,
    logLevel: env.WHATSAPP_LOG_LEVEL || 'warn',
    retryBaseMs: 2000,
    retryMaxMs: 60 * 1000,
    standbyRetryMs: 10 * 1000,
    heartbeatMs: 15 * 1000,
    leaseTtlMs: 45 * 1000,
    sendTimeoutMs: 25 * 1000,
    // Envio sem resposta a tempo e AMBIGUO (a mensagem pode ter saido): a
    // cobranca so e desfeita se, depois deste prazo, a mensagem nao aparecer.
    ambiguousUndoMs: 90 * 1000,
    // Quanto do historico (que o WhatsApp manda ao vincular) entra no painel.
    historyDays: 90,
    historyMax: 5000,
    // De quanto em quanto tempo confere de novo se o numero tem WhatsApp.
    recheckMs: 30 * 24 * 60 * 60 * 1000,
    // Conexao recusada (erro) com sessao salva: tenta de novo devagar, para
    // voltar sozinho quando o problema passar.
    slowRetryMs: 10 * 60 * 1000,
    // Conta recusada (403) varias vezes seguidas: cada nova tentativa espera
    // o dobro, ate este teto (bater na porta de 10 em 10 minutos numa conta
    // restrita so chama mais atencao).
    forbiddenRetryMaxMs: 6 * 60 * 60 * 1000,
    // Versao do cliente (latestClientVersion): vale por este tempo; depois,
    // a proxima conexao busca de novo (o WhatsApp Web se atualiza sozinho).
    versionTtlMs: 6 * 60 * 60 * 1000,
    // Versao recusada (405): espera antes de tentar de novo com a versao
    // buscada outra vez; recusas seguidas dobram a espera ate o teto.
    versionRetryMs: 60 * 1000,
    versionRetryMaxMs: 60 * 60 * 1000,
    // PRESENCA: "session" (padrao) = como uma pessoa no WhatsApp Web: fica
    // "online" quando vai ler/responder e sai sozinha um tempo sorteado
    // depois da ultima acao. "off" = nunca fica online (so o "digitando…").
    // Enquanto esta online, o celular da biblioteca nao toca para mensagem
    // nova (sao segundos); WHATSAPP_PRESENCE=off desfaz.
    presence: ['off', 'false', '0', 'no', 'nao', 'não'].includes(String(env.WHATSAPP_PRESENCE ?? '').trim().toLowerCase())
      ? 'off'
      : 'session',
    presenceIdleMs: [15 * 1000, 50 * 1000],
    // Depois de conectar, pergunta ao WhatsApp se a conta esta restrita
    // para iniciar conversas (uma vez por conexao, sem pressa).
    restrictionCheckMs: [20 * 1000, 60 * 1000],
    // Por quanto tempo um "digitando…" da PESSOA vale sem novo sinal.
    composingTtlMs: 12 * 1000,
    // Pais informado ao WhatsApp como o do navegador (o Baileys manda "US"
    // se nada for dito). So vale a partir do proximo vinculo/conexao.
    countryCode: /^[A-Za-z]{2}$/.test(String(env.WHATSAPP_COUNTRY ?? '').trim())
      ? String(env.WHATSAPP_COUNTRY).trim().toUpperCase()
      : '',
    // Teto das mensagens AUTOMATICAS (robo de atendimento, avisos) em 24 h.
    autoDailyLimit:
      Number(env.WHATSAPP_AUTO_DAILY_LIMIT) > 0 ? Number(env.WHATSAPP_AUTO_DAILY_LIMIT) : 500,
    // Intervalo entre duas mensagens para conversas DIFERENTES (como uma
    // pessoa trocando de conversa): sorteado nesta faixa a cada vez.
    switchGapMs: [1800, 5500],
    // "digitando…" das mensagens do painel (a pessoa ja digitou no painel:
    // so um instante, para o envio nao ser instantaneo).
    panelTypingMs: [700, 2200],
    // As regras do fiscal (policy.js).
    policy: readPolicyConfig(env),
  };
}

/**
 * VERSAO DO CLIENTE anunciada ao WhatsApp. A que vem embutida no Baileys (e a
 * que o fetchLatestBaileysVersion le do repositorio dele) fica parada no dia
 * em que a biblioteca saiu - em 14/11/2026 era a de julho, meses atras do
 * WhatsApp Web de verdade. Um "navegador" que nunca se atualiza e marca de
 * cliente nao oficial, e o WhatsApp recusa (405) a versao velha demais. Por
 * isso: a versao do proprio WhatsApp Web (web.whatsapp.com) e, sem ela, a do
 * Baileys; das que vierem, a MAIS NOVA (nunca abaixo da embutida). null = nao
 * deu para saber (o socket usa a embutida).
 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function validVersion(result) {
  const v = result?.isLatest ? result.version : null;
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isSafeInteger(n) && n >= 0) && v[0] === 2
    ? v
    : null;
}

export async function latestClientVersion({
  web = fetchLatestWaWebVersion,
  baileys = fetchLatestBaileysVersion,
  timeoutMs = 5000,
  embedded = DEFAULT_CONNECTION_CONFIG.version,
} = {}) {
  const found = await Promise.all(
    [web, baileys].map((fetcher) =>
      withTimeout(Promise.resolve().then(() => fetcher()), timeoutMs)
        .then(validVersion)
        .catch(() => null)
    )
  );
  const sources = ['web.whatsapp.com', 'Baileys'];
  const list = found.map((version, i) => (version ? { version, source: sources[i] } : null)).filter(Boolean);
  if (!list.length) return null;
  const newest = list.sort((a, b) => compareVersions(a.version, b.version)).at(-1);
  return Array.isArray(embedded) && compareVersions(newest.version, embedded) < 0
    ? { version: [...embedded], source: 'embutida' }
    : newest;
}

function withTimeout(promise, ms, code = 'TIMEOUT', message = 'O WhatsApp demorou demais para responder.') {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new WhatsAppError(code, message, 504)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

// Tenta de novo, com espera, antes de desistir (falha passageira do banco).
async function retrying(task, waits = [250, 1000, 3000]) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= waits.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, waits[attempt]));
    }
  }
}

function toMs(timestamp) {
  const seconds =
    typeof timestamp === 'number'
      ? timestamp
      : typeof timestamp?.toNumber === 'function'
        ? timestamp.toNumber()
        : Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}

function lastDigits(value) {
  const digits = digitsOf(value);
  return digits ? 'terminado em ' + digits.slice(-4) : 'desconhecido';
}

// O que o servidor faz por padrao: abrir o socket de verdade.
function defaultSocketFactory(options) {
  return makeWASocket({
    ...options,
    auth: {
      creds: options.auth.creds,
      keys: makeCacheableSignalKeyStore(options.auth.keys, options.logger),
    },
  });
}

export class WhatsAppService {
  #cfg;
  #socketFactory;
  #authFactory;
  #sessionExists;
  #lease;
  #logger;

  #sock = null;
  #gen = 0;
  #auth = null;
  #state = 'idle';
  #since = Date.now();
  // Desde quando a conexao NAO esta aberta (null = aberta agora). Conta desde
  // a subida do servidor; nao reinicia a cada nova tentativa de reconectar.
  #downSince = Date.now();
  #qr = null;
  #notice = '';
  #attempts = 0;
  #connecting = false;
  #started = false;
  #closing = false;
  #version;
  // A versao veio pronta (testes): nunca busca. Senao, quando foi buscada.
  #versionFixed = false;
  #versionAt = 0;
  #versionLookup;
  // Recusas seguidas da versao (405).
  #rejectedVersion = 0;
  #retryTimer = null;
  #heartbeat = null;
  #queue = Promise.resolve();
  #historyQueue = Promise.resolve();
  // A sessao salva quebrou de vez (ilegivel ou recusada varias vezes): so ai
  // recoverBrokenSession pode apaga-la.
  #broken = false;
  // Ids das mensagens que ESTE servidor enviou (painel, robo, avisos), para o
  // eco delas nao parecer mensagem escrita no celular.
  #ownIds = new Map();
  #listeners = new Set();
  // Uma mensagem de cada vez, como uma pessoa so no aparelho (ver #paced).
  #outbox = Promise.resolve();
  #lastOut = null;
  #wait;
  #rng;
  #now;
  #warmupAt = null;
  #freshLink = false;
  // Presenca (ver #goOnline): online agora? e o relogio que tira o "online".
  #online = false;
  #idleTimer = null;
  // Quantos envios estao no "digitando…"/envio agora (ver #stayOnline).
  #busy = 0;
  // Conversas cuja presenca ja foi pedida nesta conexao (jid -> quando).
  #subscribed = new Map();
  // Quem esta "digitando…" para a biblioteca agora (jid -> quando avisou).
  #composing = new Map();
  // A restricao da Meta para iniciar conversas ({ until, type } ou null).
  #restriction = null;
  #forbidden = 0;
  #last463 = 0;
  #capStatus = '';
  // Conexao sob demanda: ate quando ela deve ficar aberta, o relogio que a
  // fecha, o que a abre sozinha, quando chegou o ultimo evento e quantos
  // envios estao em andamento (nada fecha no meio de um).
  #awakeUntil = 0;
  #sleepTimer = null;
  #syncTimer = null;
  #lastEventAt = 0;
  #inflight = 0;

  constructor(overrides = {}) {
    this.#init(overrides);
  }

  #init(overrides) {
    this.#cfg = { ...readConfig(), ...(overrides.config || {}) };
    this.#socketFactory = overrides.socketFactory || defaultSocketFactory;
    this.#authFactory = overrides.authFactory || (() => useMongoAuthState());
    this.#sessionExists =
      overrides.sessionExists || (async () => Boolean(await WaAuth.exists({ _id: 'creds' })));
    this.#lease = overrides.lease || createLease({ ttlMs: this.#cfg.leaseTtlMs });
    this.#logger =
      overrides.logger || pino({ level: this.#cfg.logLevel }, pino.destination(2));
    this.#version = overrides.version;
    this.#versionFixed = overrides.version !== undefined;
    this.#versionAt = 0;
    this.#versionLookup = overrides.versionLookup || (() => latestClientVersion());
    this.#wait = overrides.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#rng = overrides.rng || defaultRng;
    this.#now = overrides.now || (() => Date.now());
    this.#warmupAt = null;
    this.#state = this.#cfg.enabled ? 'idle' : 'disabled';
  }

  /** So para testes: troca as pecas (socket, trava, sessao) antes de iniciar. */
  configure(overrides) {
    if (this.#started || this.#sock) {
      throw new Error('configure() só vale antes de iniciar.');
    }
    this.#init(overrides);
  }

  get config() {
    return this.#cfg;
  }

  // ---------- Estado ----------

  #setState(state, notice = '') {
    if (state !== this.#state) {
      console.log('WhatsApp: ' + state);
    }
    if (state === 'open') this.#downSince = null;
    else if (this.#downSince === null) this.#downSince = Date.now();
    this.#state = state;
    this.#notice = notice;
    this.#since = Date.now();
    if (state !== 'qr') this.#qr = null;
  }

  /** O que o painel pode saber. Nunca devolve credenciais. */
  snapshot() {
    return {
      enabled: this.#cfg.enabled,
      state: this.#state,
      connected: this.#state === 'open',
      qr: this.#state === 'qr' ? this.#qr : null,
      // (dormindo: a sessao esta salva no banco, so nao carregada agora)
      hasSession: Boolean(this.#auth?.state?.creds?.me) || this.#state === 'sleeping',
      // "on-demand" (conecta so com alguem nas Conversas) ou "always".
      mode: this.#cfg.mode,
      // Sessao quebrada: o painel oferece apagar e ler o QR de novo.
      broken: this.#broken,
      number: this.#cfg.number,
      notice: this.#notice,
      // A Meta restringiu o numero para INICIAR conversas ate esta hora
      // (null = sem restricao conhecida). O painel avisa a equipe.
      restriction:
        this.#restriction && new Date(this.#restriction.until).getTime() > Date.now()
          ? { until: this.#restriction.until, type: this.#restriction.type || '' }
          : null,
      since: new Date(this.#since).toISOString(),
      downSince: this.#downSince === null ? null : new Date(this.#downSince).toISOString(),
    };
  }

  // ---------- Ligar e desligar ----------

  /** Ao subir o servidor: se ja ha sessao salva, reconecta sozinho. */
  async start() {
    if (this.#started) return;
    this.#started = true;
    if (!this.#cfg.enabled) {
      this.#setState('disabled', 'O WhatsApp está desligado neste servidor.');
      return;
    }
    // Quem ja escreveu nas conversas do painel vira contato (opt-in): as
    // conversas anteriores a esta versao nao tinham esse registro.
    // (o indice unico dos contatos: se nao puder ser criado - registros
    // repetidos de antes -, avisa no log em vez de falhar calado)
    WaContact.init().catch((error) =>
      console.warn('WhatsApp: índice dos contatos não criado (' + error.message + ').')
    );
    backfillContacts()
      .then((added) => {
        if (added) console.log('WhatsApp: ' + added + ' contato(s) que já escreveram registrados.');
      })
      .catch((error) => console.error('WhatsApp: não foi possível registrar os contatos:', error.message));
    try {
      if (await this.#sessionExists()) {
        // Sob demanda: ao subir, uma ida curta para buscar o que chegou com o
        // servidor fora do ar (e conferir o numero); depois, dorme.
        if (this.#onDemand()) this.#extendAwake(this.#pick(this.#cfg.syncStayMs));
        await this.connect({ auto: true });
      }
    } catch (error) {
      console.error('WhatsApp: não foi possível iniciar:', error.message);
    }
  }

  // ---------- Conexao sob demanda ----------

  #onDemand() {
    return this.#cfg.enabled && this.#cfg.mode === 'on-demand';
  }

  #pick([min, max]) {
    return Math.round(between(min, max, this.#rng));
  }

  // Alguem quer a conexao aberta ate (pelo menos) daqui a ms.
  #extendAwake(ms) {
    this.#awakeUntil = Math.max(this.#awakeUntil, this.#now() + ms);
    this.#scheduleSleep();
  }

  #wanted() {
    return this.#now() < this.#awakeUntil;
  }

  /**
   * Um administrador esta usando as Conversas (as rotas do painel chamam a
   * cada consulta): a conexao abre, se estava dormindo, e fica aberta ate uns
   * minutos depois da ultima consulta. Sem efeito com WHATSAPP_MODE=always.
   */
  touch() {
    if (!this.#onDemand() || this.#closing) return;
    this.#extendAwake(this.#pick(this.#cfg.awakeIdleMs));
    if (this.#state === 'sleeping') this.connect({ auto: true }).catch(() => {});
  }

  #scheduleSleep(ms) {
    if (!this.#onDemand() || this.#closing) return;
    clearTimeout(this.#sleepTimer);
    const wait = Math.max(1000, ms ?? this.#awakeUntil - this.#now());
    this.#sleepTimer = setTimeout(() => {
      this.#maybeSleep().catch((error) => {
        console.error('WhatsApp: não foi possível fechar a conexão ociosa:', error.message);
      });
    }, wait);
    this.#sleepTimer.unref?.();
  }

  // Ninguem mais nas Conversas: fecha (sem desvincular) se nada estiver
  // chegando nem saindo agora.
  async #maybeSleep() {
    if (!this.#onDemand() || this.#closing) return;
    if (this.#wanted()) return this.#scheduleSleep();
    const busy =
      this.#connecting ||
      this.#inflight > 0 ||
      this.#busy > 0 ||
      this.#now() - this.#lastEventAt < this.#cfg.quietMs;
    if (busy) return this.#scheduleSleep(Math.min(15 * 1000, this.#cfg.quietMs));
    const registered = Boolean(this.#auth?.state?.creds?.me);
    // Vinculando (QR na tela) ou sem sessao: nao ha o que fechar - o QR vence sozinho.
    if (!registered) return undefined;
    if (['open', 'connecting', 'reconnecting'].includes(this.#state)) {
      await this.#goToSleep();
    } else if (this.#state === 'standby') {
      await this.#sleepNow();
    }
    return undefined;
  }

  /** Fecha a conexao aberta SEM desvincular: a sessao continua salva. */
  async #goToSleep() {
    const sock = this.#sock;
    if (sock && this.#online) {
      await withTimeout(Promise.resolve(sock.sendPresenceUpdate?.('unavailable')), 3000).catch(() => {});
    }
    // Termina de gravar o que ja chegou: depois de fechar, o que estiver na
    // fila deste socket seria ignorado (e o WhatsApp ja considera entregue).
    const deadline = this.#now() + 20 * 1000;
    for (;;) {
      const queue = this.#queue;
      const history = this.#historyQueue;
      await Promise.race([Promise.all([queue, history]), this.#wait(Math.max(0, deadline - this.#now()))]);
      if ((queue === this.#queue && history === this.#historyQueue) || this.#now() >= deadline) break;
    }
    // Alguem voltou as Conversas (ou um envio comecou) enquanto esperava.
    if (this.#wanted() || this.#inflight > 0 || this.#busy > 0) return this.#scheduleSleep();
    if (this.#sock !== sock) return undefined; // a conexao ja mudou sozinha
    this.#teardownSocket();
    // Ja e "dormindo" para quem pergunta (o status nao diz "conectado" sem
    // conexao, e quem voltar as Conversas agora reconecta na hora).
    this.#setState('sleeping', '');
    // A sessao e gravada inteira antes de soltar a trava; a proxima abertura
    // le do banco (outra copia do servidor pode conectar no meio).
    await this.#auth?.flush?.()?.catch?.(() => {});
    // Alguem reconectou enquanto gravava: a conexao nova usa esta sessao e
    // esta trava - nada de soltar.
    if (this.#sock || this.#connecting || this.#state !== 'sleeping') return this.#scheduleSleep();
    this.#auth = null;
    await this.#sleepNow();
    // E se alguem voltou as Conversas bem agora, abre de novo.
    if (this.#wanted()) this.connect({ auto: true }).catch(() => {});
    return undefined;
  }

  async #sleepNow() {
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#sleepTimer);
    this.#stopHeartbeat();
    await this.#lease.release().catch(() => {});
    this.#setState(
      'sleeping',
      'Conectado só enquanto alguém usa as Conversas. Abrindo esta tela, ele conecta em instantes.'
    );
    this.#scheduleSync();
  }

  // Dormindo: abre sozinho de tempos em tempos, so para receber o que chegou.
  #scheduleSync() {
    clearTimeout(this.#syncTimer);
    const every = this.#cfg.syncEveryMs;
    if (!this.#onDemand() || !every || this.#closing) return;
    this.#syncTimer = setTimeout(() => this.#syncNow(), Math.round(every * (0.8 + this.#rng() * 0.4)));
    this.#syncTimer.unref?.();
  }

  #syncNow() {
    if (this.#state !== 'sleeping' || this.#closing) return;
    const hour = brazilHour(new Date(this.#now()));
    if (hour < this.#cfg.syncFromHour || hour >= this.#cfg.syncToHour) {
      this.#scheduleSync();
      return;
    }
    this.#extendAwake(this.#pick(this.#cfg.syncStayMs));
    this.connect({ auto: true }).catch(() => {});
  }

  /** Abre a conexao (e o QR, se faltar a sessao). Pode ser chamado a vontade. */
  async connect({ auto = false } = {}) {
    if (!this.#cfg.enabled || this.#closing) return this.snapshot();
    if (this.#connecting) return this.snapshot();
    if (this.#sock && ['connecting', 'qr', 'open'].includes(this.#state)) {
      return this.snapshot();
    }
    this.#connecting = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#syncTimer);
    try {
      // Sob demanda: nova tentativa automatica (queda, trava, ida sozinha que
      // ja passou) sem ninguem nas Conversas - dorme em vez de conectar.
      if (auto && this.#onDemand() && !this.#wanted()) {
        const saved = Boolean(this.#auth?.state?.creds?.me) || (await this.#sessionExists());
        if (saved) {
          // (o socket que caiu ja saiu em #onClose; o que ainda estiver na
          // fila dele termina de gravar)
          if (this.#sock) this.#teardownSocket();
          await this.#sleepNow();
          return this.snapshot();
        }
      }
      if (!(await this.#lease.acquire())) {
        this.#setState(
          'standby',
          'Outra cópia do servidor está com a conexão do WhatsApp. Esta aguarda a vez.'
        );
        this.#scheduleRetry(this.#cfg.standbyRetryMs);
        return this.snapshot();
      }
      this.#startHeartbeat();

      // Reconectando, usa a sessao que ja esta na memoria (a do banco pode
      // ainda nao ter recebido a ultima gravacao).
      const auth = this.#auth?.state ? this.#auth : await this.#authFactory();
      if (auth.status === 'unreadable') {
        this.#auth = auth;
        this.#broken = true;
        this.#stopHeartbeat();
        await this.#lease.release().catch(() => {});
        this.#setState(
          'unreadable',
          'A sessão salva não pôde ser lida (a chave de segurança mudou). Apague a sessão e leia o QR de novo.'
        );
        return this.snapshot();
      }
      // O NUMERO DA BIBLIOTECA MUDOU (WHATSAPP_NUMBER): a sessao salva e do
      // numero antigo. Nao conecta com ela (se a conta antiga estiver
      // bloqueada, o servidor ficaria tentando para sempre e o QR nunca
      // apareceria): apaga e pede o QR do numero novo.
      const savedMe = phoneFromJid(auth.state?.creds?.me?.id || '');
      if (savedMe && !samePhone(savedMe, this.#cfg.number)) {
        console.warn(
          'WhatsApp: a sessão salva é de outro número (' + lastDigits(savedMe) + '). O número da biblioteca mudou: sessão antiga apagada.'
        );
        await auth.clear();
        this.#auth = null;
        this.#broken = false;
        this.#attempts = 0;
        this.#stopHeartbeat();
        await this.#lease.release().catch(() => {});
        this.#setState(
          'idle',
          'O número da biblioteca mudou para +' +
            this.#cfg.number +
            '. A conexão do número antigo (' +
            lastDigits(savedMe) +
            ') foi apagada deste servidor. Leia o QR code com o celular do número novo.'
        );
        return this.snapshot();
      }
      this.#auth = auth;
      await this.#open();
    } catch (error) {
      console.error('WhatsApp: falha ao conectar:', error.message);
      this.#teardownSocket();
      // auto: veio da subida do servidor (com sessao salva) ou de uma nova
      // tentativa. Se o banco falhou ao ler a sessao, tenta de novo sozinho em
      // vez de ficar parado ate alguem abrir o painel.
      if (this.#auth?.state?.creds?.me || auto) {
        this.#setState('reconnecting', 'Não foi possível conectar agora. Tentando de novo.');
        this.#scheduleRetry(this.#backoff());
      } else {
        this.#stopHeartbeat();
        await this.#lease.release().catch(() => {});
        this.#setState('idle', 'Não foi possível conectar agora. Tente de novo.');
      }
    } finally {
      this.#connecting = false;
    }
    return this.snapshot();
  }

  // A versao do cliente para esta conexao (ver latestClientVersion). Sem
  // resposta desta vez: a ultima que se soube, senao a embutida (null); a
  // falha nao e guardada (a proxima conexao tenta de novo).
  async #clientVersion() {
    if (this.#versionFixed) return this.#version;
    const fresh = this.#version && this.#now() - this.#versionAt < this.#cfg.versionTtlMs;
    if (fresh) return this.#version;
    const result = await this.#versionLookup().catch(() => null);
    const found = Array.isArray(result) ? result : result?.version || null;
    const source = Array.isArray(result) ? '' : result?.source || '';
    // Um WhatsApp Web de verdade nunca volta de versao: se so respondeu a
    // fonte mais atrasada (a do Baileys), fica a que ja se sabia. (Depois de
    // um 405 a guardada e apagada, e vale a que vier.)
    if (found && !(this.#version && compareVersions(found, this.#version) < 0)) {
      if (!this.#version || compareVersions(found, this.#version) !== 0) {
        console.log('WhatsApp: versão do cliente ' + found.join('.') + (source ? ' (' + source + ')' : '') + '.');
      }
      this.#version = found;
      this.#versionAt = this.#now();
    } else if (found) {
      // (a guardada continua valendo por mais um prazo)
      this.#versionAt = this.#now();
    } else if (!this.#version) {
      console.warn('WhatsApp: não foi possível saber a versão atual do WhatsApp Web; vai a embutida no Baileys.');
    }
    return this.#version || null;
  }

  async #open() {
    const gen = ++this.#gen;
    const auth = this.#auth;
    const version = await this.#clientVersion();
    if (gen !== this.#gen) return;

    const sock = this.#socketFactory({
      auth: auth.state,
      ...(version ? { version } : {}),
      // Um navegador comum (Chrome no Windows), e nao um nome inventado: o
      // nome so vale no proximo vinculo (QR); a sessao atual nao muda.
      browser: Browsers.windows('Chrome'),
      ...(this.#cfg.countryCode ? { countryCode: this.#cfg.countryCode } : {}),
      logger: this.#logger,
      // O celular continua recebendo as notificacoes normais.
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Para o WhatsApp reenviar uma mensagem que o destinatario nao conseguiu abrir.
      getMessage: async (key) => {
        const found = await WaMessage.findOne({ waId: key.id, fromMe: true }).lean();
        return found?.text ? { conversation: found.text } : undefined;
      },
    });
    this.#sock = sock;
    this.#setState('connecting');

    sock.ev.on('creds.update', () => {
      auth.saveCreds().catch((error) => {
        console.error('WhatsApp: não foi possível salvar a sessão:', error.message);
      });
    });
    sock.ev.on('connection.update', (update) => {
      this.#onConnectionUpdate(gen, sock, update).catch((error) => {
        console.error('WhatsApp: erro na conexão:', error.message);
      });
    });
    sock.ev.on('messages.upsert', (event) =>
      this.#enqueue(gen, () => this.#onUpsert(sock, event))
    );
    sock.ev.on('messages.update', (updates) =>
      this.#enqueue(gen, () => this.#onUpdates(sock, updates))
    );
    sock.ev.on('messaging-history.set', (event) =>
      this.#enqueueHistory(gen, () => this.#onHistory(sock, event))
    );
    // Quem esta "digitando…" para a biblioteca (so chega das conversas cuja
    // presenca foi pedida: ver attend).
    sock.ev.on('presence.update', (event) => {
      if (gen === this.#gen) this.#onPresence(event);
    });
    // Aviso da Meta: o numero esta perto (ou passou) do limite de conversas
    // NOVAS do periodo.
    sock.ev.on('message-capping.update', (payload) => {
      if (gen !== this.#gen) return;
      this.#onCapping(payload).catch((error) => {
        console.error('WhatsApp: erro ao tratar o aviso de limite:', error.message);
      });
    });
  }

  // O historico que o WhatsApp manda ao vincular pode ter milhares de mensagens:
  // fica numa fila SEPARADA, para nao segurar as mensagens que chegam ao vivo.
  // (Tudo que se grava e idempotente, entao as duas filas nao se atrapalham.)
  #enqueueHistory(gen, task) {
    this.#lastEventAt = this.#now(); // (sob demanda: nao fecha com o historico chegando)
    this.#historyQueue = this.#historyQueue.then(async () => {
      if (gen !== this.#gen) return;
      try {
        await task();
      } catch (error) {
        console.error('WhatsApp: erro ao guardar o histórico:', error.message);
      }
    });
    return this.#historyQueue;
  }

  #enqueue(gen, task) {
    this.#lastEventAt = this.#now(); // (sob demanda: nao fecha com mensagens chegando)
    this.#queue = this.#queue.then(async () => {
      if (gen !== this.#gen) return;
      try {
        await task();
      } catch (error) {
        console.error('WhatsApp: erro ao guardar mensagem:', error.message);
      }
    });
    return this.#queue;
  }

  async #onConnectionUpdate(gen, sock, update) {
    if (gen !== this.#gen) return;
    const { connection, qr, lastDisconnect } = update;

    // A Meta restringiu (ou liberou) a conta para iniciar conversas.
    if (update.reachoutTimeLock) await this.#onRestriction(update.reachoutTimeLock);

    if (qr) {
      // Antes de o numero ser vinculado: o que era de OUTRO numero sai do
      // banco (ver #claimNumber).
      await this.#claimNumber();
      if (gen !== this.#gen) return;
      this.#qr = qr;
      // Pediu QR: o proximo "aberto" e um vinculo NOVO (aquecimento recomeca).
      this.#freshLink = true;
      if (this.#state !== 'open') this.#setState('qr');
    }
    if (connection === 'connecting' && this.#state !== 'qr') {
      this.#setState('connecting');
    }
    if (connection === 'open') await this.#onOpen(gen, sock);
    if (connection === 'close') await this.#onClose(gen, lastDisconnect?.error);
  }

  async #onOpen(gen, sock) {
    // Aviso atrasado de um socket que ja caiu: nao vale como conectado.
    if (sock !== this.#sock) return;
    const me = sock.user?.id || this.#auth?.state?.creds?.me?.id || '';
    const meDigits = phoneFromJid(me);
    if (!meDigits) {
      // Sem como conferir o numero: NAO desvincula (poderia ser a conta certa).
      this.#stopHeartbeat();
      this.#teardownSocket();
      await this.#lease.release().catch(() => {});
      this.#setState(
        'error',
        'Não foi possível confirmar qual número está conectado. O servidor tenta de novo sozinho.'
      );
      this.#scheduleRetry(this.#cfg.slowRetryMs);
      return;
    }
    if (!samePhone(meDigits, this.#cfg.number)) {
      await this.#rejectWrongNumber(gen, sock, meDigits);
      return;
    }
    this.#attempts = 0;
    this.#forbidden = 0;
    this.#rejectedVersion = 0;
    this.#broken = false;
    this.#online = false;
    this.#subscribed.clear();
    this.#composing.clear();
    // O que ja se sabia da restricao (para o painel) e, dali a pouco, a
    // situacao de agora perguntada ao WhatsApp (a resposta chega como
    // "reachoutTimeLock" em connection.update).
    readRestriction()
      .then((value) => {
        if (sock === this.#sock) this.#restriction = value.active ? { until: value.until, type: value.type } : null;
      })
      .catch(() => {});
    if (typeof sock.fetchAccountReachoutTimelock === 'function') {
      const timer = setTimeout(() => {
        if (sock !== this.#sock || this.#state !== 'open') return;
        sock.fetchAccountReachoutTimelock().catch(() => {});
      }, Math.round(between(this.#cfg.restrictionCheckMs[0], this.#cfg.restrictionCheckMs[1], this.#rng)));
      timer.unref?.();
    }
    if (this.#freshLink) {
      // Numero vinculado de novo (depois de um bloqueio, por exemplo): o
      // aquecimento recomeca do dia 1 a partir de AGORA, e nao do deploy.
      this.#freshLink = false;
      this.#warmupAt = new Date(this.#now());
      restartWarmup(this.#now()).catch(() => {});
    }
    // De qual numero sao as conversas e os contatos do banco (#claimNumber).
    // Com nova tentativa: sem esta anotacao, o proximo QR acharia que o
    // numero mudou e apagaria as conversas do numero ATUAL.
    await retrying(() =>
      Setting.updateOne(
        { _id: NUMBER_KEY },
        { $set: { value: { number: this.#cfg.number, at: new Date(this.#now()).toISOString() } } },
        { upsert: true }
      )
    ).catch((error) => console.error('WhatsApp: não foi possível anotar o número conectado:', error.message));
    if (sock !== this.#sock) return;
    this.#setState('open');
    if (this.#onDemand()) {
      // Fica pelo menos um minuto: o WhatsApp entrega o que estava guardado
      // logo depois de conectar.
      this.#extendAwake(this.#cfg.minOpenMs);
    }
  }

  /**
   * NUMERO NOVO: as conversas, os contatos ("quem ja escreveu"), a saude e a
   * restricao guardados no banco sao do numero que estava vinculado antes.
   * Misturar isso com o numero novo faria o fiscal achar que quem escreveu
   * para o numero ANTIGO ja conhece o novo (e liberar mensagens para uma
   * "lista fria" - o que a Meta mais pune) e juntaria mensagens de dois
   * numeros na mesma conversa. Roda quando o QR aparece (antes de vincular):
   * se o numero anotado (settings > whatsapp-number, gravado a cada conexao)
   * nao e o de agora - ou nao ha anotacao -, apaga tudo isso e anota o novo.
   * As mensagens de antes somem do painel (de todo modo sumiriam em 7 dias).
   */
  async #claimNumber() {
    try {
      const doc = await Setting.findById(NUMBER_KEY).lean();
      if (doc?.value?.number && samePhone(doc.value.number, this.#cfg.number)) return;
      const [chats, messages, contacts] = await Promise.all([
        WaChat.deleteMany({}),
        WaMessage.deleteMany({}),
        WaContact.deleteMany({}),
        // (a "vez" - floor.js - apontava para uma conversa que sai agora)
        Setting.deleteMany({ _id: { $in: [HEALTH_KEY, RESTRICTION_KEY, SENT_LOG, 'whatsapp-floor'] } }),
        // (solicitacoes que apontavam para uma conversa que saiu)
        LoanRequest.updateMany({ waChat: { $ne: null } }, { $set: { waChat: null } }),
      ]);
      this.#restriction = null;
      await Setting.updateOne(
        { _id: NUMBER_KEY },
        { $set: { value: { number: this.#cfg.number, at: new Date(this.#now()).toISOString() } } },
        { upsert: true }
      );
      if (chats.deletedCount || messages.deletedCount || contacts.deletedCount) {
        console.warn(
          'WhatsApp: número novo (+' +
            this.#cfg.number +
            '). Saíram do painel ' +
            (chats.deletedCount || 0) +
            ' conversa(s), ' +
            (messages.deletedCount || 0) +
            ' mensagem(ns) e ' +
            (contacts.deletedCount || 0) +
            ' contato(s) do número anterior.'
        );
      }
    } catch (error) {
      // Sem a anotacao gravada, tenta de novo no proximo QR.
      console.error('WhatsApp: não foi possível preparar o banco para o número novo:', error.message);
    }
  }

  /** Alguem leu o QR com outro numero: desvincula e apaga a sessao. */
  async #rejectWrongNumber(gen, sock, meDigits) {
    console.warn('WhatsApp: número diferente do da biblioteca (' + lastDigits(meDigits) + '). Desvinculando.');
    this.#gen += 1; // ignora o que ainda chegar deste socket
    this.#sock = null;
    try {
      await withTimeout(sock.logout('número incorreto'), 8000);
    } catch {
      try {
        sock.end(undefined);
      } catch {
        /* ja fechado */
      }
    }
    await this.#auth?.clear().catch(() => {});
    this.#auth = null;
    this.#stopHeartbeat();
    await this.#lease.release().catch(() => {});
    this.#setState(
      'wrong-number',
      'Esse WhatsApp (' +
        lastDigits(meDigits) +
        ') não é o da biblioteca. Foi desvinculado. Leia o QR code com o celular do número +' +
        this.#cfg.number +
        '.'
    );
  }

  async #onClose(gen, error) {
    if (gen !== this.#gen) return;
    this.#sock = null;
    clearTimeout(this.#idleTimer);
    this.#online = false;
    const code = error?.output?.statusCode;
    const registered = Boolean(this.#auth?.state?.creds?.me);

    // Terminou o pareamento: o WhatsApp pede para abrir de novo com a sessao nova.
    if (code === DisconnectReason.restartRequired) {
      try {
        await this.#open();
      } catch (openError) {
        console.error('WhatsApp: falha ao reabrir:', openError.message);
        this.#setState('reconnecting', 'Reconectando…');
        this.#scheduleRetry(this.#backoff());
      }
      return;
    }

    // 500 pode ser uma falha passageira do WhatsApp: tenta de novo algumas
    // vezes antes de desistir (e mesmo assim NAO apaga a sessao sozinho).
    if (code === DisconnectReason.badSession) {
      if (this.#attempts >= 5) {
        this.#broken = true;
        this.#stopHeartbeat();
        await this.#lease.release().catch(() => {});
        this.#setState(
          'error',
          'O WhatsApp recusou a sessão salva várias vezes. O servidor segue tentando; se não voltar, apague a sessão e leia o QR code de novo.'
        );
        this.#scheduleRetry(this.#cfg.slowRetryMs);
      } else {
        this.#setState('reconnecting', 'A conexão caiu. Reconectando…');
        this.#scheduleRetry(this.#backoff());
      }
      return;
    }

    if (
      code === DisconnectReason.loggedOut ||
      code === DisconnectReason.multideviceMismatch
    ) {
      await this.#endSession(
        'logged-out',
        'O celular desconectou este aparelho do WhatsApp. Leia o QR code de novo para voltar.'
      );
      return;
    }

    if (code === DisconnectReason.forbidden) {
      // Conta restringida pela Meta: as mensagens puxadas pelo numero param
      // por dias e o aquecimento recomeca do dia 1 (policy.js).
      const cfg = this.#cfg.policy;
      pauseProactive('o WhatsApp restringiu a conta', cfg.restrictedPauseMs).catch(() => {});
      restartWarmup(this.#now()).catch(() => {});
      this.#warmupAt = new Date(this.#now());
      this.#stopHeartbeat();
      await this.#lease.release().catch(() => {});
      this.#setState(
        'error',
        'O WhatsApp recusou a conexão. A conta pode estar restrita; confira o aplicativo no celular. O servidor tenta de novo sozinho.'
      );
      // Cada recusa seguida dobra a espera (10 min, 20, 40... ate 6 h).
      const retry = Math.min(this.#cfg.forbiddenRetryMaxMs, this.#cfg.slowRetryMs * 2 ** Math.min(this.#forbidden, 10));
      this.#forbidden += 1;
      this.#scheduleRetry(Math.round(retry * (0.85 + this.#rng() * 0.3)));
      return;
    }

    // 405: o WhatsApp recusou a VERSAO do cliente (velha demais). Antes caia
    // na reconexao comum - de minuto em minuto, sempre com a mesma versao
    // guardada. Agora esquece a versao (a proxima conexao busca de novo; sem
    // resposta, usa a embutida) e espera, dobrando a cada recusa seguida.
    if (code === 405) {
      if (!this.#versionFixed) this.#version = null;
      this.#versionAt = 0;
      this.#stopHeartbeat();
      await this.#lease.release().catch(() => {});
      if (!registered) {
        // Vinculando: nada de gerar QR sozinho sem parar.
        this.#setState(
          'idle',
          'O WhatsApp recusou a conexão deste servidor agora (código 405). Espere alguns minutos e toque em “Gerar o QR code” de novo.'
        );
        return;
      }
      const wait = Math.min(this.#cfg.versionRetryMaxMs, this.#cfg.versionRetryMs * 2 ** Math.min(this.#rejectedVersion, 10));
      this.#rejectedVersion += 1;
      console.warn('WhatsApp: versão do cliente recusada (405). Nova tentativa com a versão atualizada em ' + Math.round(wait / 1000) + ' s.');
      const ms = Math.round(wait * (0.85 + this.#rng() * 0.3));
      const minutes = Math.max(1, Math.round(ms / 60000));
      this.#setState(
        'reconnecting',
        'O WhatsApp pediu uma versão mais nova. Nova tentativa em ' + (minutes === 1 ? 'cerca de 1 minuto' : 'cerca de ' + minutes + ' minutos') + '.'
      );
      this.#scheduleRetry(ms);
      return;
    }

    if (!registered) {
      // O QR venceu sem ninguem ler: nao fica gerando QR sem parar.
      this.#stopHeartbeat();
      await this.#lease.release().catch(() => {});
      this.#setState('idle', 'O QR code expirou. Toque em “Gerar o QR code” para ver outro.');
      return;
    }

    if (code === DisconnectReason.connectionReplaced) {
      this.#setState(
        'reconnecting',
        'Outra conexão assumiu a sessão do WhatsApp. Vou tentar de novo em instantes.'
      );
      this.#scheduleRetry(Math.max(this.#backoff(), 30 * 1000));
      return;
    }

    this.#setState('reconnecting', 'A conexão caiu. Reconectando…');
    this.#scheduleRetry(this.#backoff());
  }

  async #endSession(state, notice) {
    this.#teardownSocket();
    await this.#auth?.clear().catch(() => {});
    this.#auth = null;
    this.#broken = false;
    this.#stopHeartbeat();
    await this.#lease.release().catch(() => {});
    this.#setState(state, notice);
  }

  #backoff() {
    const base = Math.min(
      this.#cfg.retryMaxMs,
      this.#cfg.retryBaseMs * 2 ** Math.min(this.#attempts, 10)
    );
    this.#attempts += 1;
    return Math.round(base * (0.75 + Math.random() * 0.5));
  }

  #scheduleRetry(ms) {
    clearTimeout(this.#retryTimer);
    if (this.#closing) return;
    this.#retryTimer = setTimeout(() => {
      this.connect({ auto: true }).catch(() => {});
    }, ms);
    this.#retryTimer.unref?.();
  }

  #teardownSocket() {
    this.#gen += 1;
    const sock = this.#sock;
    this.#sock = null;
    this.#qr = null;
    clearTimeout(this.#idleTimer);
    this.#online = false;
    this.#subscribed.clear();
    this.#composing.clear();
    if (sock) {
      try {
        sock.end(undefined);
      } catch {
        /* ja fechado */
      }
    }
  }

  #startHeartbeat() {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(async () => {
      try {
        if (!(await this.#lease.renew())) this.#loseLease();
      } catch (error) {
        console.error('WhatsApp: não foi possível renovar a trava:', error.message);
      }
    }, this.#cfg.heartbeatMs);
    this.#heartbeat.unref?.();
  }

  #stopHeartbeat() {
    clearInterval(this.#heartbeat);
    this.#heartbeat = null;
  }

  // Outra copia do servidor tomou a trava: solta a conexao SEM desvincular.
  #loseLease() {
    this.#stopHeartbeat();
    this.#teardownSocket();
    this.#auth = null; // outra copia pode ter gravado: recarrega do banco depois
    this.#setState(
      'standby',
      'Outra cópia do servidor assumiu a conexão do WhatsApp. Esta aguarda a vez.'
    );
    this.#scheduleRetry(this.#cfg.standbyRetryMs);
  }

  /**
   * Desligamento com calma (o Render manda SIGTERM a cada deploy): fecha a
   * conexao SEM desvincular e solta a trava para a copia nova assumir logo.
   */
  async shutdown() {
    this.#closing = true;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#sleepTimer);
    clearTimeout(this.#syncTimer);
    this.#stopHeartbeat();
    this.#teardownSocket();
    await this.#queue.catch(() => {});
    // Termina de gravar as chaves da sessao antes de soltar a trava: uma
    // gravacao perdida estragaria a criptografia na proxima conexao.
    await this.#auth?.flush?.().catch?.(() => {});
    if (this.#cfg.enabled) await this.#lease.release().catch(() => {});
  }

  /**
   * Apaga a sessao salva SO quando ela ja nao serve (ilegivel ou recusada
   * varias vezes pelo WhatsApp) e volta a mostrar o QR. Com a sessao boa -
   * conectada, conectando, reconectando - recusa: o painel nao desconecta o
   * numero da biblioteca.
   */
  async recoverBrokenSession() {
    if (!this.#cfg.enabled) {
      throw new WhatsAppError('DISABLED', 'O WhatsApp está desligado neste servidor.', 409);
    }
    if (
      !this.#broken ||
      !['unreadable', 'error'].includes(this.#state) ||
      this.#sock ||
      this.#connecting
    ) {
      throw new WhatsAppError(
        'NOT_BROKEN',
        'A sessão do WhatsApp não está quebrada: não há o que apagar. O servidor reconecta sozinho.',
        409
      );
    }
    if (!(await this.#lease.acquire())) {
      throw new WhatsAppError(
        'STANDBY',
        'Outra cópia do servidor está com a conexão do WhatsApp. Tente de novo em instantes.',
        409
      );
    }
    clearTimeout(this.#retryTimer);
    console.warn('WhatsApp: sessão quebrada apagada para ler o QR de novo.');
    const auth = this.#auth || (await this.#authFactory());
    await auth.clear();
    this.#auth = null;
    this.#broken = false;
    this.#attempts = 0;
    this.#stopHeartbeat();
    await this.#lease.release().catch(() => {});
    this.#setState('idle', 'A sessão foi apagada. Leia o QR code para conectar.');
    return this.connect();
  }

  /** Codigo de 8 letras para digitar no WhatsApp, no lugar de ler o QR. */
  async requestPairingCode() {
    const sock = this.#sock;
    if (!sock || this.#state !== 'qr') {
      throw new WhatsAppError(
        'NOT_READY',
        'A conexão ainda não está pronta para gerar o código. Aguarde o QR code aparecer e tente de novo.',
        409
      );
    }
    if (sock.authState?.creds?.registered) {
      throw new WhatsAppError('ALREADY', 'Este aparelho já está vinculado.', 409);
    }
    // Sempre o numero da biblioteca: o painel nao escolhe numero nenhum.
    return withTimeout(sock.requestPairingCode(this.#cfg.number), 20 * 1000);
  }

  // ---------- Sinais da propria Meta ----------

  /**
   * O WhatsApp avisou o estado da restricao para iniciar conversas. Ativa:
   * as mensagens puxadas pelo numero param (policy.js) e a equipe e avisada
   * (evento "restricted": o robo manda o aviso ao administrador).
   */
  async #onRestriction(state) {
    try {
      const result = await noteRestriction(state, this.#cfg.policy, this.#now());
      this.#restriction = result.active ? { until: result.until, type: result.type } : null;
      if (!result.isNew) return;
      this.#warmupAt = new Date(this.#now());
      console.warn('WhatsApp: a Meta RESTRINGIU este número para iniciar conversas até ' + result.until + '. Avisos automáticos em pausa.');
      this.#emit({ type: 'restricted', until: result.until, kind: 'reachout' });
    } catch (error) {
      console.error('WhatsApp: não foi possível registrar a restrição:', error.message);
    }
  }

  /** Aviso de limite de conversas NOVAS (FIRST_WARNING, SECOND_WARNING, CAPPED). */
  async #onCapping(payload) {
    const status = String(payload?.capping_status || '').toUpperCase();
    if (!status || status === 'NONE') {
      this.#capStatus = '';
      return;
    }
    const capped = status === 'CAPPED';
    const end = Number(payload?.cycle_end_timestamp) * 1000;
    const now = this.#now();
    const ms = capped && Number.isFinite(end) && end > now ? end - now + 24 * 60 * 60 * 1000 : capped ? 72 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    await pauseProactive(
      capped
        ? 'o WhatsApp bloqueou novas conversas neste período (limite atingido)'
        : 'o WhatsApp avisou que o número está perto do limite de conversas novas',
      ms,
      now
    );
    if (status !== this.#capStatus) {
      this.#capStatus = status;
      console.warn('WhatsApp: aviso de limite de conversas novas (' + status + '). Avisos automáticos em pausa.');
      this.#emit({ type: 'restricted', until: new Date(now + ms).toISOString(), kind: capped ? 'capped' : 'cap-warning' });
    }
  }

  /**
   * Mensagem recusada com o codigo 463: quase sempre e a conta restrita para
   * iniciar conversas. Pergunta ao WhatsApp (a resposta cai em #onRestriction);
   * se nao der para perguntar, pausa um dia por precaucao. Nunca reenvia.
   */
  #on463() {
    const now = this.#now();
    if (now - this.#last463 < 10 * 60 * 1000) return;
    this.#last463 = now;
    const sock = this.#sock;
    const fallback = () =>
      pauseProactive('o WhatsApp recusou uma mensagem (463: conta possivelmente restrita)', 24 * 60 * 60 * 1000, now).catch(() => {});
    if (sock && typeof sock.fetchAccountReachoutTimelock === 'function') {
      sock.fetchAccountReachoutTimelock().catch(fallback);
    } else {
      fallback();
    }
  }

  // ---------- Presenca (como uma pessoa no WhatsApp Web) ----------

  /**
   * Fica "online" (se ainda nao esta) e marca a hora de sair: um tempo
   * sorteado depois da ULTIMA acao (ler, digitar, enviar). Uma pessoa abre o
   * WhatsApp, responde e sai; um robo responde "offline" ou fica online 24 h.
   */
  async #goOnline(sock) {
    if (this.#cfg.presence !== 'session' || typeof sock.sendPresenceUpdate !== 'function') return;
    if (!this.#online) {
      try {
        await withTimeout(sock.sendPresenceUpdate('available'), 5000);
        if (sock !== this.#sock) return;
        this.#online = true;
      } catch {
        return; // so um sinal
      }
    }
    this.#stayOnline(sock);
  }

  #stayOnline(sock) {
    if (!this.#online) return;
    clearTimeout(this.#idleTimer);
    const [min, max] = this.#cfg.presenceIdleMs;
    this.#idleTimer = setTimeout(() => {
      if (sock !== this.#sock || !this.#online) return;
      // Digitando ou enviando agora: ninguem sai do WhatsApp no meio de uma
      // frase. Espera de novo (o fim do envio tambem renova).
      if (this.#busy > 0) {
        this.#stayOnline(sock);
        return;
      }
      this.#online = false;
      Promise.resolve()
        .then(() => sock.sendPresenceUpdate('unavailable'))
        .catch(() => {});
    }, Math.round(between(min, max, this.#rng)));
    this.#idleTimer.unref?.();
  }

  // Pede a presenca da conversa (o que o WhatsApp Web faz ao abri-la): sem
  // isso o "digitando…" nao aparece para a pessoa nem o dela chega aqui.
  async #subscribe(sock, jid) {
    if (!jid || typeof sock.presenceSubscribe !== 'function') return;
    const last = this.#subscribed.get(jid);
    if (last && Date.now() - last < 10 * 60 * 1000) return;
    if (this.#subscribed.size > 2000) this.#subscribed.clear();
    this.#subscribed.set(jid, Date.now());
    await withTimeout(sock.presenceSubscribe(jid), 5000).catch(() => {});
  }

  #onPresence({ id, presences } = {}) {
    const now = Date.now();
    for (const [participant, presence] of Object.entries(presences || {})) {
      const typing = presence?.lastKnownPresence === 'composing' || presence?.lastKnownPresence === 'recording';
      for (const jid of new Set([id, participant])) {
        if (!jid) continue;
        if (typing) this.#composing.set(jid, now);
        else this.#composing.delete(jid);
      }
    }
    if (this.#composing.size > 2000) this.#composing.clear();
  }

  /**
   * "Abre a conversa": fica online e pede a presenca dela. O robo chama
   * antes de ler uma mensagem. So um sinal: se falhar, nada muda.
   */
  async attend(chat) {
    const sock = this.#sock;
    if (this.#state !== 'open' || !sock) return false;
    try {
      await this.#goOnline(sock);
      await this.#subscribe(sock, chat?.jid || chat?.lid || '');
      return true;
    } catch {
      return false;
    }
  }

  /** A pessoa desta conversa esta "digitando…" (ou gravando audio) agora? */
  isComposing(chat) {
    const now = Date.now();
    return [chat?.jid, chat?.lid].some((jid) => {
      const at = jid ? this.#composing.get(jid) : null;
      return Boolean(at && now - at < this.#cfg.composingTtlMs);
    });
  }

  // ---------- Avisos para quem usa o servico (robo de atendimento) ----------

  /**
   * fn({ type, chat, message, text, kind }) para cada mensagem NOVA ao vivo:
   * - "incoming": a pessoa escreveu;
   * - "phone-out": a biblioteca escreveu pelo CELULAR (nao pelo painel/robo);
   * - "restricted" ({ until, kind }): a Meta restringiu o numero para iniciar
   *   conversas (ou avisou do limite de conversas novas).
   * Devolve a funcao que cancela.
   */
  onEvent(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(event) {
    for (const fn of this.#listeners) {
      try {
        Promise.resolve(fn(event)).catch((error) => {
          console.error('WhatsApp: erro no atendimento automático:', error.message);
        });
      } catch (error) {
        console.error('WhatsApp: erro no atendimento automático:', error.message);
      }
    }
  }

  #rememberOwn(id) {
    const now = Date.now();
    this.#ownIds.set(id, now);
    if (this.#ownIds.size > 500) {
      for (const [key, at] of this.#ownIds) {
        if (now - at > 10 * 60 * 1000) this.#ownIds.delete(key);
      }
    }
  }

  // ---------- Receber ----------

  async #identity(sock, key) {
    const remote = key.remoteJid;
    const alt = key.remoteJidAlt;
    let phone = phoneFromJid(remote) || phoneFromJid(alt);
    const lid = lidFromJid(remote) || lidFromJid(alt);
    if (!phone && lid) {
      try {
        const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(lid);
        phone = phoneFromJid(pn);
      } catch {
        /* sem o numero: a conversa fica so com o LID */
      }
    }
    if (!phone && !lid) return null;
    return { phone, lid };
  }

  async #onUpsert(sock, { messages }) {
    for (const message of messages || []) {
      try {
        // O WhatsApp ja deu o "recebido": se o banco falhar neste instante,
        // tenta de novo algumas vezes antes de desistir (senao a mensagem some).
        await retrying(() => this.#ingest(sock, message, { history: false }));
      } catch (error) {
        console.error('WhatsApp: mensagem ignorada:', error.message);
      }
    }
  }

  // Mensagem mais velha que isto ja sumiu (mensagens temporarias): nem entra.
  #disappearCutoff() {
    const days = this.#cfg.disappearDays;
    return days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
  }

  async #onHistory(sock, { messages }) {
    const oldest = Math.max(
      Date.now() - this.#cfg.historyDays * 24 * 60 * 60 * 1000,
      this.#disappearCutoff()
    );
    let count = 0;
    for (const message of messages || []) {
      if (count >= this.#cfg.historyMax) break;
      if (toMs(message.messageTimestamp) < oldest) continue;
      count += 1;
      try {
        await this.#ingest(sock, message, { history: true });
      } catch (error) {
        console.error('WhatsApp: mensagem do histórico ignorada:', error.message);
      }
    }
  }

  async #ingest(sock, message, { history }) {
    const key = message?.key;
    if (!key?.id || !key.remoteJid) return;
    // So conversas com uma pessoa: grupos, status e canais ficam de fora.
    if (!isPnUser(key.remoteJid) && !isLidUser(key.remoteJid)) return;
    // Mandou: nao esta mais "digitando…" (o WhatsApp nao avisa o fim).
    if (!key.fromMe && !history) {
      this.#composing.delete(key.remoteJid);
      if (key.remoteJidAlt) this.#composing.delete(key.remoteJidAlt);
    }

    const identity = await this.#identity(sock, key);
    if (!identity) return;
    // A conversa do numero com ele mesmo ("mensagens para mim").
    if (identity.phone && samePhone(identity.phone, this.#cfg.number)) return;

    const info = describeMessage(message);
    const at = toMs(message.messageTimestamp);
    if (info.revokeId || info.edit || info.ephemeral !== undefined) {
      const chat = await resolveChat({ ...identity, create: false });
      if (!chat) return;
      if (info.revokeId) await markDeleted(chat._id, info.revokeId);
      else if (info.edit) await markEdited(chat._id, info.edit.id, info.edit.text);
      // Alguem trocou o temporizador de mensagens temporarias da conversa.
      else await noteEphemeral(chat._id, info.ephemeral, at);
      return;
    }
    if (info.skip) return;
    // Ja teria sumido (mensagens temporarias): nao entra no painel.
    if (at < this.#disappearCutoff()) return;

    const fromMe = Boolean(key.fromMe);
    const chat = await resolveChat({
      ...identity,
      pushName: fromMe ? '' : String(message.pushName || '').slice(0, 80),
      authoritative: true,
    });
    if (!chat) return;
    const { inserted, message: saved } = await saveMessage(chat, {
      waId: key.id,
      fromMe,
      kind: info.kind,
      text: info.text,
      at,
      // (0 = erro vale; sem status, "enviada")
      status: fromMe && Number.isInteger(message.status) ? message.status : 2,
      // Mensagem recebida enquanto o servidor dormia chega como "append": conta
      // do mesmo jeito. O historico do vinculo nao conta.
      countUnread: !history && !fromMe,
    });
    // O temporizador que a mensagem trouxe vale para os proximos envios. (O eco
    // das mensagens que ESTE servidor enviou nao ensina nada: so repete o que
    // o proprio servidor escolheu.)
    if (Number.isFinite(info.expiration) && !(fromMe && this.#ownIds.has(key.id))) {
      await noteEphemeral(chat._id, info.expiration, at).catch(() => {});
    }
    // A pessoa escreveu para o numero: vira contato (opt-in, policy.js). Dura
    // mais que a conversa (que some com as mensagens temporarias).
    if (!fromMe && inserted) {
      await noteInbound({ phone: chat.phone || identity.phone, lid: chat.lid || identity.lid, at: new Date(at), live: !history }).catch(
        (error) => console.error('WhatsApp: não foi possível guardar o contato:', error.message)
      );
    }

    // So o que e novo e ao vivo vai para o atendimento automatico. O eco das
    // mensagens enviadas por este servidor nao conta como "escrita no celular".
    if (history || !inserted) return;
    if (!fromMe) {
      this.#emit({
        type: 'incoming',
        chat,
        message: saved,
        text: info.text || '',
        kind: info.kind,
      });
    } else if (!this.#ownIds.has(key.id)) {
      this.#emit({ type: 'phone-out', chat, message: saved });
    }
  }

  async #onUpdates(sock, updates) {
    for (const { key, update } of updates || []) {
      try {
        if (!key?.id || !key.remoteJid) continue;
        if (!isPnUser(key.remoteJid) && !isLidUser(key.remoteJid)) continue;

        // Entrega/leitura/erro das mensagens da biblioteca: acha pelo id da
        // mensagem (o aviso pode vir pelo LID e a conversa estar pelo numero).
        if (typeof update?.status === 'number' && key.fromMe && !update.message) {
          await this.#onStatus(key.id, update);
          continue;
        }

        const identity = await this.#identity(sock, key);
        if (!identity) continue;
        const chat = await resolveChat({ ...identity, create: false });
        if (!chat) continue;

        if (update?.messageStubType === proto.WebMessageInfo.StubType.REVOKE) {
          await markDeleted(chat._id, key.id);
        } else if (update?.message?.editedMessage?.message) {
          const edited = describeMessage({ message: update.message.editedMessage.message });
          if (!edited.skip) await markEdited(chat._id, key.id, edited.text || '');
        }
      } catch (error) {
        console.error('WhatsApp: atualização ignorada:', error.message);
      }
    }
  }

  async #onStatus(waId, update) {
    const status = update.status;
    const errorCode = status === 0 ? String(update.messageStubParameters?.[0] || '') : '';
    if (status === 0) {
      // Antes isso sumia: o painel mostrava "enviada" para mensagem recusada.
      console.warn(
        'WhatsApp: o WhatsApp recusou uma mensagem' +
          (errorCode ? ' (código ' + errorCode + ')' : '') +
          '.'
      );
      if (errorCode === '463') this.#on463();
    }
    const apply = async () => {
      const found = await WaMessage.findOne({ waId, fromMe: true }).select('chat').lean();
      if (!found) return false;
      return raiseStatus(found.chat, waId, status, errorCode);
    };
    // O aviso pode chegar antes de a mensagem enviada ser gravada: tenta de novo.
    if (!(await apply()) && status === 0) {
      const timer = setTimeout(() => apply().catch(() => {}), 4000);
      timer.unref?.();
    }
  }

  // ---------- Enviar ----------

  #requireOpen() {
    if (this.#state === 'open' && this.#sock) return this.#sock;
    throw new WhatsAppError(
      'WA_OFFLINE',
      'O WhatsApp da biblioteca não está conectado agora.',
      503
    );
  }

  async #targetJid(sock, chat) {
    const recent =
      chat.checkedAt && Date.now() - new Date(chat.checkedAt).getTime() < this.#cfg.recheckMs;
    if (chat.jid && recent) return chat.jid;

    if (chat.phone) {
      let found;
      try {
        found = await withTimeout(sock.onWhatsApp(chat.phone), 15 * 1000);
      } catch (error) {
        if (error instanceof WhatsAppError) throw error;
        throw new WhatsAppError('LOOKUP_FAILED', 'Não deu para conferir o número no WhatsApp agora.', 502);
      }
      const hit = Array.isArray(found) ? found.find((item) => item?.exists) : null;
      if (!hit?.jid) {
        // Ja falou com ele por LID? Ainda da para responder.
        if (chat.lid) return chat.lid;
        throw new WhatsAppError('NOT_ON_WHATSAPP', 'Esse número não tem WhatsApp.', 422);
      }
      await WaChat.updateOne(
        { _id: chat._id },
        { $set: { jid: hit.jid, phone: phoneFromJid(hit.jid) || chat.phone, checkedAt: new Date() } }
      );
      return hit.jid;
    }
    if (chat.lid) return chat.lid;
    throw new WhatsAppError('NO_ADDRESS', 'Essa conversa não tem número para enviar.', 422);
  }

  // Envios das ultimas 24 h de conversas APAGADAS do painel (os tetos diarios
  // contam as mensagens do banco; sem isto, apagar conversas liberaria o teto).
  async #deletedSends(kind, since) {
    const doc = await Setting.findById(SENT_LOG).lean();
    const list = Array.isArray(doc?.value) ? doc.value : [];
    return list.filter((entry) => entry?.kind === kind && new Date(entry.at) >= since).length;
  }

  /**
   * Antes de apagar uma conversa: guarda quantas mensagens o painel e o
   * sistema mandaram nela nas ultimas 24 h, para continuarem contando nos tetos.
   */
  async keepSendCounts(chatId) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await WaMessage.find({ chat: chatId, fromMe: true, at: { $gte: since } })
      .select('at sentBy auto')
      .lean();
    const entries = recent.flatMap((message) =>
      message.auto
        ? [{ at: message.at, kind: 'auto' }]
        : message.sentBy
          ? [{ at: message.at, kind: 'panel' }]
          : []
    );
    if (entries.length) {
      // (registro estragado - nao e lista - recomeca vazio, senao o $push falha)
      await Setting.updateOne(
        { _id: SENT_LOG, value: { $not: { $type: 'array' } } },
        { $set: { value: [] } }
      );
      await Setting.updateOne(
        { _id: SENT_LOG },
        { $push: { value: { $each: entries } } },
        { upsert: true }
      );
    }
    await Setting.updateOne(
      { _id: SENT_LOG, value: { $type: 'array' } },
      { $pull: { value: { at: { $lt: since } } } }
    );
  }

  /** Quantas mensagens o painel enviou nas ultimas 24 horas. */
  async sentToday() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await WaMessage.countDocuments({
      fromMe: true,
      sentBy: { $ne: null },
      at: { $gte: since },
    });
    return count + (await this.#deletedSends('panel', since));
  }

  /** Quantas mensagens automaticas (robo, avisos) sairam nas ultimas 24 horas. */
  async autoSentToday() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const count = await WaMessage.countDocuments({
      fromMe: true,
      auto: { $nin: ['', null] },
      at: { $gte: since },
    });
    return count + (await this.#deletedSends('auto', since));
  }

  isOpen() {
    return this.#state === 'open' && Boolean(this.#sock);
  }

  /** Confere (sem enviar) se da para enviar agora; lanca o erro se nao. */
  async assertCanSend({ auto = '' } = {}) {
    this.#requireOpen();
    if (auto) {
      if ((await this.autoSentToday()) >= this.#cfg.autoDailyLimit) {
        throw new WhatsAppError(
          'AUTO_DAILY_LIMIT',
          'O limite diário de mensagens automáticas foi atingido.',
          429
        );
      }
      return;
    }
    if ((await this.sentToday()) >= this.#cfg.dailyLimit) {
      throw new WhatsAppError(
        'DAILY_LIMIT',
        'O limite de mensagens enviadas pelo painel nas últimas 24 horas foi atingido. Isso protege o número da biblioteca de ser bloqueado pelo WhatsApp.',
        429
      );
    }
  }

  /**
   * O temporizador de mensagens temporarias com que se escreve nesta conversa
   * (segundos; 0 = sem): o que as mensagens dela ensinaram (a troca do
   * temporizador que o celular sincroniza, ou o que veio nas mensagens). Sem
   * isso, 0: nao mexe na conversa. (O temporizador padrao do WhatsApp
   * Business so vale para conversas NOVAS; as antigas, sem temporizador,
   * mandam texto simples, que nao diz nada - chutar 7 dias ai mandaria
   * mensagem temporaria numa conversa comum.)
   */
  ephemeralFor(chat) {
    const known = chat?.ephemeral;
    return typeof known === 'number' && Number.isFinite(known) && known > 0 ? known : 0;
  }

  /**
   * Envia o texto e devolve o id da mensagem no WhatsApp.
   * auto: "bot" | "overdue" | "handoff" para mensagens do proprio sistema
   * (contam no teto das automaticas, nao no do painel).
   */
  // ---------- O fiscal (policy.js) ----------

  async #limits() {
    if (!this.#warmupAt) this.#warmupAt = await warmupStartAt(this.#cfg.policy, this.#now());
    return limitsFor(this.#cfg.policy, warmupDay(this.#warmupAt, this.#now()));
  }

  /** Os tetos do dia (aquecimento) e a pausa, para o painel e o README. */
  async policyStatus() {
    const [limits, health] = await Promise.all([this.#limits(), readHealth()]);
    return { limits, health, warmupStartedAt: this.#warmupAt?.toISOString?.() || null };
  }

  /**
   * Junta o que o fiscal precisa e pergunta se a mensagem pode sair.
   * Lanca POLICY_BLOCKED (429) com as regras quando nao pode.
   */
  async audit(chat, text, { auto = '' } = {}) {
    const purpose = purposeOf(auto);
    const now = this.#now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000);
    const hourAgo = new Date(now - 60 * 60 * 1000);
    const [contact, recent, lastHour, autoToday, proactiveToday, limits, health, unengaged, chatToday, deletedHour, restriction] = await Promise.all([
      contactOf(chat),
      WaMessage.find({ fromMe: true, at: { $gte: dayAgo } })
        .sort({ at: -1 })
        .limit(400)
        .select('chat text auto')
        .lean(),
      WaMessage.countDocuments({
        fromMe: true,
        at: { $gte: hourAgo },
        $or: [{ sentBy: { $ne: null } }, { auto: { $nin: ['', null] } }],
      }),
      this.autoSentToday(),
      WaContact.countDocuments({ lastProactiveAt: { $gte: dayAgo } }),
      this.#limits(),
      readHealth(),
      purpose === 'proactive' ? unengagedRecent(now) : 0,
      // (para contato frio pelo painel: quantas ja foram para esta pessoa)
      purpose === 'panel'
        ? WaMessage.countDocuments({ chat: chat._id, fromMe: true, at: { $gte: dayAgo } })
        : 0,
      // Envios da ultima hora de conversas APAGADAS (senao apagar liberaria o teto).
      Promise.all([this.#deletedSends('panel', hourAgo), this.#deletedSends('auto', hourAgo)]).then(
        ([a, b]) => a + b
      ),
      // A restricao da Meta para iniciar conversas (so pesa no que o numero puxa).
      purpose === 'proactive' || purpose === 'panel' ? readRestriction() : {},
    ]);
    const verdict = auditOutgoing(
      {
        text,
        chatId: String(chat._id),
        purpose,
        contact,
        recent: recent.map((m) => ({ chatId: String(m.chat), text: m.text, purpose: purposeOf(m.auto) })),
        counts: {
          lastHour: lastHour + deletedHour,
          autoToday,
          proactiveToday,
          unengaged,
          // (o maior: as gravadas na conversa ou as anotadas no contato, que
          // valem mesmo com a conversa apagada)
          chatToday: Math.max(chatToday, contact.proactiveDay || 0),
        },
        limits,
        health,
        restriction,
        hour: brazilHour(new Date(now)),
        now,
      },
      this.#cfg.policy
    );
    verdict.purpose = purpose;
    verdict.contact = contact;
    // (o menu repetido nas respostas do robo e esperado: nao vai para o log)
    const warns = verdict.warns.filter((w) => !(purpose === 'reply' && w.rule === 'NEAR_DUPLICATE'));
    if (warns.length) {
      console.warn('WhatsApp: alerta do fiscal (' + purpose + '): ' + warns.map((w) => w.rule).join(', '));
    }
    if (!verdict.ok) {
      const error = new WhatsAppError('POLICY_BLOCKED', verdict.blocks[0].msg, 429);
      error.rules = verdict.blocks.map((b) => b.rule);
      throw error;
    }
    return verdict;
  }

  /**
   * Uma mensagem de cada vez (como UMA pessoa no aparelho): trocar de
   * conversa leva alguns segundos sorteados. bypass: a mensagem do painel
   * (alguem ja esperou digitando) nao entra na fila, mas conta como a ultima.
   */
  #paced(chatId, task, { bypass = false } = {}) {
    const key = String(chatId);
    const go = async () => {
      if (!bypass && this.#lastOut && this.#lastOut.chat !== key) {
        const gap = between(this.#cfg.switchGapMs[0], this.#cfg.switchGapMs[1], this.#rng);
        const wait = this.#lastOut.at + gap - this.#now();
        if (wait > 0) await this.#wait(wait);
      }
      try {
        return await task();
      } finally {
        this.#lastOut = { chat: key, at: this.#now() };
      }
    };
    if (bypass) return go();
    const run = this.#outbox.then(go, go);
    this.#outbox = run.catch(() => {});
    return run;
  }

  /**
   * "digitando…" antes de enviar, em trechos (texto longo para no meio). So
   * um sinal: falhou, segue. mode: "reply" | "proactive" | "panel".
   */
  async #typeOut(sock, jid, text, mode, online) {
    if (!mode || typeof sock.sendPresenceUpdate !== 'function') return;
    const plan =
      mode === 'panel'
        ? [{ typeMs: Math.round(between(this.#cfg.panelTypingMs[0], this.#cfg.panelTypingMs[1], this.#rng)), pauseMs: 0 }]
        : typingPlan(text, { proactive: mode === 'proactive', rng: this.#rng });
    try {
      // Quem digita esta online (presenca "session"); no modo antigo, so
      // se pedido (WHATSAPP_BOT_TYPING=online).
      if (this.#cfg.presence === 'session') await this.#goOnline(sock);
      else if (online) await withTimeout(sock.sendPresenceUpdate('available'), 5000);
      await this.#subscribe(sock, jid);
      for (const step of plan) {
        // (o relogio de "sair do online" recomeca a cada trecho: um aviso
        // longo digita por mais tempo que o ocioso minimo)
        if (this.#cfg.presence === 'session') this.#stayOnline(sock);
        await withTimeout(sock.sendPresenceUpdate('composing', jid), 5000);
        await this.#wait(step.typeMs);
        if (step.pauseMs) {
          await withTimeout(sock.sendPresenceUpdate('paused', jid), 5000);
          await this.#wait(step.pauseMs);
        }
      }
    } catch {
      /* so um sinal */
    }
  }

  /**
   * Envia o texto e devolve o id da mensagem no WhatsApp.
   * auto: "bot" | "overdue" | "handoff" | "request" para mensagens do proprio
   * sistema (contam no teto das automaticas, nao no do painel).
   * typing: "reply" | "proactive" | "panel" mostra o "digitando…" antes
   * (tempo proporcional ao texto, com variacao); online: fica "online"
   * durante (WHATSAPP_BOT_TYPING=online).
   * guard: async () => boolean, conferido quando chega a vez na fila e de
   * novo depois do "digitando…" (o robo desiste se um administrador assumiu
   * a conversa nesse meio tempo): false = SUPERSEDED, nada sai.
   * Toda mensagem passa pelo fiscal (audit) antes.
   */
  async sendText(chat, text, options = {}) {
    // NENHUMA MENSAGEM AUTOMATICA (desde 13/11/2026): so sai o que um
    // administrador digitou no painel. Robo, aviso de atraso ou qualquer
    // outro envio "do sistema" e recusado aqui, mesmo que alguem religue.
    if (options.auto) {
      throw new WhatsAppError(
        'AUTO_OFF',
        'O WhatsApp da biblioteca não envia mensagens automáticas: só o que um administrador escreve nas Conversas.',
        403
      );
    }
    this.#inflight += 1;
    try {
      return await this.#sendText(chat, text, options);
    } finally {
      this.#inflight -= 1;
    }
  }

  async #sendText(chat, text, { auto = '', typing = null, online = false, guard = null } = {}) {
    await this.assertCanSend({ auto });
    const verdict = await this.audit(chat, text, { auto });
    const jid = await this.#targetJid(this.#requireOpen(), chat);
    const superseded = () =>
      new WhatsAppError('SUPERSEDED', 'A conversa mudou antes do envio (um administrador assumiu).', 409);
    const result = await this.#paced(
      chat._id,
      async () => {
        if (guard && !(await guard())) throw superseded();
        // O socket da VEZ (a conexao pode ter voltado enquanto esperava a fila).
        let sock = this.#requireOpen();
        this.#busy += 1;
        try {
          await this.#typeOut(sock, jid, text, typing, online);
        } finally {
          this.#busy -= 1;
        }
        // (o relogio recomeca agora: cobre a conferencia e o envio, que levam
        // so um instante; depois do envio ele recomeca de novo)
        if (this.#cfg.presence === 'session') this.#stayOnline(sock);
        if (guard && !(await guard())) throw superseded();
        // A conexao pode ter caido (e voltado) durante o "digitando…": envia
        // pelo socket aberto AGORA (o endereco continua valendo).
        sock = this.#requireOpen();
        // O id e escolhido aqui (e lembrado ANTES de enviar): o eco da
        // mensagem chega antes de o envio terminar.
        const messageId = generateMessageIDV2(sock.user?.id);
        this.#rememberOwn(messageId);
        let sent;
        try {
          sent = await withTimeout(
            sock.sendMessage(jid, { text }, { messageId, ephemeralExpiration: this.ephemeralFor(chat) }),
            this.#cfg.sendTimeoutMs,
            'SEND_TIMEOUT',
            'O WhatsApp não confirmou o envio a tempo. Confira na conversa se a mensagem saiu.'
          );
        } catch (error) {
          if (error instanceof WhatsAppError) throw error;
          throw new WhatsAppError(
            'SEND_FAILED',
            'Não foi possível enviar a mensagem pelo WhatsApp agora.',
            502
          );
        } finally {
          // Presenca "session": continua online mais um pouco e sai sozinha.
          if (this.#cfg.presence === 'session') this.#stayOnline(sock);
          else if (online) sock.sendPresenceUpdate?.('unavailable')?.catch?.(() => {});
        }
        if (!sent?.key?.id) {
          throw new WhatsAppError('SEND_FAILED', 'O WhatsApp não confirmou o envio.', 502);
        }
        return { waId: sent.key.id, at: toMs(sent.messageTimestamp), jid };
      },
      { bypass: verdict.purpose === 'panel' }
    );
    // Mensagem puxada pelo numero (aviso, ou o painel escrevendo a quem nunca
    // escreveu): conta no teto de "primeiras mensagens" e na saude.
    if (verdict.purpose === 'proactive' || (verdict.purpose === 'panel' && !verdict.contact?.inbound)) {
      await noteProactive({ phone: chat.phone, lid: chat.lid, at: new Date(result.at) }).catch(() => {});
    }
    return result;
  }

  /**
   * Mostra (ou tira) o "digitando…" na conversa. E so um sinal: se falhar,
   * nada muda (devolve false). Normalmente NAO deixa o numero "online" (o
   * celular continua recebendo as notificacoes normais, como em
   * markOnlineOnConnect: false). online: true (WHATSAPP_BOT_TYPING=online,
   * reserva caso o WhatsApp so mostre o "digitando…" de quem esta online):
   * fica "online" so durante a resposta e volta a "offline" ao tirar o sinal.
   */
  async setTyping(chat, typing, { online = false } = {}) {
    const sock = this.#sock;
    if (this.#state !== 'open' || !sock || typeof sock.sendPresenceUpdate !== 'function') {
      return false;
    }
    const jid = chat?.jid || chat?.lid || '';
    if (!jid) return false;
    try {
      if (typing && online) await withTimeout(sock.sendPresenceUpdate('available'), 5000);
      await withTimeout(sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid), 5000);
      return true;
    } catch {
      // Ficou "online" e o "digitando…" falhou: o robo nao vai tirar o sinal
      // (setTyping devolveu false), entao volta a "offline" aqui mesmo.
      if (typing && online) {
        await withTimeout(sock.sendPresenceUpdate('unavailable'), 5000).catch(() => {});
      }
      return false;
    } finally {
      if (!typing && online) {
        await withTimeout(sock.sendPresenceUpdate('unavailable'), 5000).catch(() => {});
      }
    }
  }

  /** Avisa o WhatsApp que as mensagens foram lidas (como o WhatsApp Web faz). */
  async sendReadReceipts(chat, waIds) {
    const jid = chat?.jid || chat?.lid || '';
    if (this.#state !== 'open' || !this.#sock || !jid || !waIds.length) return;
    try {
      await this.#sock.readMessages(
        waIds.map((id) => ({ remoteJid: jid, id, fromMe: false }))
      );
    } catch {
      /* so um aviso a pessoa: a leitura no painel ja valeu */
    }
  }
}

/** A copia que o servidor usa. */
export const whatsapp = new WhatsAppService();
