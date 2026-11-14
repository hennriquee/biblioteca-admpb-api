import Setting from '../../models/Setting.js';
import Person from '../../models/Person.js';
import WaChat from '../../models/WaChat.js';
import { phoneVariants } from './phone.js';

/**
 * UMA CONVERSA POR VEZ (desde 13/11/2026).
 *
 * O WhatsApp da biblioteca e UM celular: uma pessoa de verdade nao escreve em
 * duas conversas ao mesmo tempo, e um numero que responde varias pessoas em
 * paralelo e o retrato de automacao que a Meta pune. Por isso o painel inteiro
 * (todos os administradores juntos) so conversa com UMA pessoa por vez:
 *
 * - a conversa "com a vez" e a da ultima mensagem enviada (pelo painel ou pelo
 *   proprio celular da biblioteca);
 * - ela TERMINA quando alguem toca em "Encerrar conversa" ou depois de
 *   endIdleMs sem mensagem nela (nem da equipe, nem da pessoa);
 * - depois que termina, outra conversa so pode receber mensagem depois de um
 *   intervalo sorteado (gapMs), como alguem que fecha uma conversa, respira e
 *   abre a proxima. Voltar a falar com a MESMA pessoa nao espera.
 *
 * Fica no banco (settings > whatsapp-floor), com um contador de versao (rev)
 * para gravacoes simultaneas. Os envios do painel passam por uma FILA
 * (lockSendTurn): confere a vez, envia e so entao anota - dois
 * administradores em conversas diferentes nunca passam juntos, e envio que
 * falha nao prende a vez.
 */

const KEY = 'whatsapp-floor';

function num(value, fallback, min, max) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw.replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function readFloorConfig(env = process.env) {
  // Minutos sem mensagem para a conversa terminar sozinha (padrao 5).
  const endMin = num(env.WHATSAPP_TALK_END_MIN, 5, 1, 120);
  // Intervalo ate a proxima conversa, em segundos (padrao 120, sorteado entre
  // 75% e 125% disso a cada vez; 0 = sem intervalo).
  const gapSec = num(env.WHATSAPP_NEXT_CHAT_GAP_SEC, 120, 0, 3600);
  return {
    endIdleMs: endMin * 60 * 1000,
    gapMs: [gapSec * 750, gapSec * 1250],
  };
}

const toMs = (value) => (value ? new Date(value).getTime() : NaN);

/** Como esta a vez agora (sem banco). doc = o value guardado. */
export function floorView(value, now = Date.now(), cfg = readFloorConfig()) {
  if (!value?.chatId) return null;
  const lastAt = toMs(value.lastAt);
  const endedAt = toMs(value.endedAt);
  const endsAt = Number.isFinite(endedAt) ? endedAt : lastAt + cfg.endIdleMs;
  const active = !Number.isFinite(endedAt) && now < lastAt + cfg.endIdleMs;
  const gap = Number.isFinite(value.gapMs) ? value.gapMs : cfg.gapMs[1];
  const freeAt = endsAt + gap;
  return {
    chatId: String(value.chatId),
    byName: value.byName || '',
    active,
    // (relativos: o relogio do aparelho de quem olha pode estar errado)
    endsInMs: active ? Math.max(0, endsAt - now) : 0,
    freeInMs: Math.max(0, freeAt - now),
    endsAt: new Date(endsAt).toISOString(),
    freeAt: new Date(freeAt).toISOString(),
  };
}

async function readDoc() {
  return Setting.findById(KEY).lean();
}

/** A vez para a tela: a vista + o nome da conversa. null = livre. */
export async function floorStatus(now = Date.now(), cfg = readFloorConfig()) {
  const doc = await readDoc();
  const view = floorView(doc?.value, now, cfg);
  if (!view || (!view.active && view.freeInMs <= 0)) return null;
  // O nome como a lista mostra: o do cadastro (pelo telefone), senao o do
  // perfil do WhatsApp, senao o numero.
  const chat = await WaChat.findById(view.chatId).select('pushName phone').lean().catch(() => null);
  const variants = phoneVariants(chat?.phone);
  const person = variants.length
    ? await Person.findOne({ phone: { $in: variants } }).sort({ code: 1 }).select('fullName').lean().catch(() => null)
    : null;
  return {
    ...view,
    chatName: person?.fullName || chat?.pushName || (chat?.phone ? '+' + chat.phone : ''),
  };
}

// Grava se ninguem mexeu desde a leitura (rev). false = outro chegou antes.
async function writeIfSame(doc, value) {
  const rev = doc?.value?.rev || 0;
  const next = { ...value, rev: rev + 1 };
  if (!doc) {
    try {
      await Setting.create({ _id: KEY, value: next });
      return next;
    } catch (error) {
      if (error?.code === 11000) return null;
      throw error;
    }
  }
  const filter = rev ? { 'value.rev': rev } : { 'value.rev': { $exists: false } };
  const result = await Setting.updateOne({ _id: KEY, ...filter }, { $set: { value: next } });
  return result.modifiedCount ? next : null;
}

export class FloorError extends Error {
  constructor(code, message, floor) {
    super(message);
    this.code = code;
    this.status = 409;
    this.floor = floor;
  }
}

function minutesText(ms) {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ' min' + (r ? ' ' + r + ' s' : '');
}

// A FILA DE ENVIOS: um envio do painel de cada vez (conferir a vez -> enviar
// -> anotar a vez). Assim dois administradores em conversas diferentes nunca
// passam juntos pela conferencia, e a vez so e GRAVADA depois que a mensagem
// sai - envio que falha nao prende ninguem. Basta em memoria: so a copia do
// servidor que esta CONECTADA ao WhatsApp consegue enviar (trava em lease.js).
let tail = Promise.resolve();
const TURN_MAX_MS = 90 * 1000;

/** Espera a vez na fila; devolve a funcao que solta (chamar UMA vez, sempre). */
export function lockSendTurn() {
  let release;
  const mine = new Promise((resolve) => {
    release = resolve;
  });
  const before = tail;
  tail = before.then(() => mine);
  return before.then(() => {
    // (rede de seguranca: um envio que nunca termina nao trava a fila)
    const timer = setTimeout(release, TURN_MAX_MS);
    timer.unref?.();
    return () => {
      clearTimeout(timer);
      release();
    };
  });
}

/**
 * Pode mandar mensagem nesta conversa agora? Lanca FloorError se OUTRA
 * conversa esta em andamento (FLOOR_BUSY) ou acabou ha pouco (FLOOR_WAIT).
 * Nao grava nada (quem grava e noteActivity, depois do envio).
 */
export async function assertFloorFree({ chatId, now = Date.now(), cfg = readFloorConfig() }) {
  const id = String(chatId);
  const doc = await readDoc();
  const view = floorView(doc?.value, now, cfg);
  if (!view || view.chatId === id) return;
  if (view.active) {
    throw new FloorError(
      'FLOOR_BUSY',
      'Uma conversa por vez: ' +
        (view.byName ? view.byName + ' está' : 'a biblioteca está') +
        ' conversando com outra pessoa agora. Encerre aquela conversa (ou espere ela terminar) para escrever aqui.',
      view
    );
  }
  if (view.freeInMs > 0) {
    throw new FloorError(
      'FLOOR_WAIT',
      'Uma conversa por vez: a anterior acabou há pouco. Dá para escrever aqui em ' + minutesText(view.freeInMs) + '.',
      view
    );
  }
}

/**
 * Houve mensagem nesta conversa (enviada agora, chegou da pessoa, ou saiu
 * pelo celular): ela continua em andamento. force: a mensagem JA saiu por
 * fora do painel (celular) - a vez passa para ela mesmo sem pedir.
 */
export async function noteActivity({ chatId, at = Date.now(), byName = null, force = false, now = Date.now(), cfg = readFloorConfig(), rng = Math.random }) {
  const id = String(chatId);
  const when = Math.min(toMs(at) || now, now);
  // Mensagem antiga (entregue so agora, ao reconectar): ja nao e conversa em
  // andamento.
  if (now - when >= cfg.endIdleMs) return false;
  at = when;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const doc = await readDoc();
    const view = floorView(doc?.value, now, cfg);
    const same = view && view.chatId === id;
    if (!same && !force) return false;
    // (mensagem da pessoa numa conversa que ja terminou nao reabre a vez)
    if (same && !view.active && !force) return false;
    const [min, max] = cfg.gapMs;
    const keep = same && view.active;
    const value = {
      ...(doc?.value || {}),
      chatId: id,
      ...(byName !== null ? { byName } : {}),
      startedAt: keep ? doc.value.startedAt : new Date(at).toISOString(),
      lastAt: new Date(Math.max(at, keep ? toMs(doc.value.lastAt) || 0 : 0)).toISOString(),
      endedAt: null,
      gapMs: keep ? doc.value.gapMs : Math.round(min + (max - min) * rng()),
    };
    delete value.rev;
    if (await writeIfSame(doc, value)) return true;
  }
  return false;
}

/** "Encerrar conversa": a vez termina agora (o intervalo comeca a contar). */
export async function endFloor({ chatId = null, now = Date.now(), cfg = readFloorConfig() } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const doc = await readDoc();
    const view = floorView(doc?.value, now, cfg);
    if (!view || !view.active) return view;
    if (chatId && view.chatId !== String(chatId)) return view;
    const value = { ...doc.value, endedAt: new Date(now).toISOString() };
    delete value.rev;
    if (await writeIfSame(doc, value)) return floorView({ ...value }, now, cfg);
  }
  return null;
}
