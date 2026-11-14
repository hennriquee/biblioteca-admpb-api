import Setting from '../../models/Setting.js';
import WaChat from '../../models/WaChat.js';
import WaContact from '../../models/WaContact.js';
import WaMessage from '../../models/WaMessage.js';
import { canonicalPhone } from './phone.js';
import { similarity } from './humanize.js';

/**
 * O "FISCAL" dos envios: as regras que imitam o que a Meta observa num numero
 * para decidir se e spam/automacao, conferidas ANTES de cada mensagem sair.
 *
 * Nao existe garantia (o Baileys nao e a API oficial), mas o que derruba
 * numero e conhecido, e cada item abaixo responde a um deles:
 *
 * 1. Lista fria: mensagem que o NUMERO puxa (aviso de atraso, cobranca) para
 *    quem nunca escreveu para ele. Regra: so para contato que ja escreveu
 *    (WaContact); a cobranca pelo painel para contato frio conta no teto de
 *    "primeiras mensagens" do dia.
 * 2. Volume e ritmo: tetos por hora e por dia, com AQUECIMENTO (comeca baixo e
 *    sobe ao longo de WARMUP dias - recomeca sozinho se o WhatsApp restringir
 *    a conta).
 * 3. Copia e cola: o mesmo texto (ou quase) para muitas pessoas. Regra:
 *    mensagem puxada pelo numero nao pode ser quase igual (>= 85%) as de
 *    outras 2 pessoas nas ultimas 24 h.
 * 4. Denuncias: a Meta conta quem bloqueia/denuncia. Nao da para ver isso,
 *    mas da para ver os SINAIS: mensagem recusada pelo WhatsApp (status 0) e
 *    aviso que ninguem le nem responde. Muito disso = PAUSA nas mensagens
 *    puxadas pelo numero (as respostas continuam).
 * 5. Gatilhos de conteudo: link encurtado (bloqueia), muitos links, CAIXA
 *    ALTA, excesso de emoji, palavras de cobranca de dinheiro na primeira
 *    mensagem (avisos).
 * 6. Horario: mensagem puxada pelo numero so das 9h as 20h de Brasilia.
 * 7. Saida: quem pede para parar ("parar", "nao quero receber") nao recebe
 *    mais mensagem puxada pelo numero. Quem tem como sair nao precisa
 *    bloquear nem denunciar - e bloqueio/denuncia e o que mais pesa.
 * 8. O AVISO DA PROPRIA META: quando ela restringe a conta para iniciar
 *    conversas ("reachout timelock", erro 463), o WhatsApp avisa o aparelho.
 *    Nessa hora NADA puxado pelo numero sai (insistir piora a restricao), a
 *    pausa continua por dias depois que ela acaba e o aquecimento recomeca.
 *
 * auditOutgoing e PURA (sem banco): o servico junta os numeros e ela decide.
 * O mesmo juiz roda nos testes ("simulador da Meta").
 */

const TRUE = new Set(['true', '1', 'yes', 'on', 'sim']);
const WARMUP_KEY = 'whatsapp-warmup';
const HEALTH_KEY = 'whatsapp-health';
const RESTRICTION_KEY = 'whatsapp-restriction';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function num(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function readPolicyConfig(env = process.env) {
  return {
    // Dias de aquecimento (0 = sem aquecimento: tetos cheios desde ja).
    warmupDays: num(env.WHATSAPP_WARMUP_DAYS, 14, { min: 0, max: 60 }),
    // Inicio do aquecimento a forca (data ISO); sem isso, o servidor guarda
    // no banco a data em que esta versao subiu.
    warmupStart: String(env.WHATSAPP_WARMUP_START || '').trim(),
    // Mensagens puxadas pelo numero (aviso de atraso + cobranca a contato
    // frio) por 24 h: do 1o ao ultimo dia do aquecimento.
    proactiveStart: 4,
    proactiveMax: num(env.WHATSAPP_PROACTIVE_DAILY_LIMIT, 30, { min: 1 }),
    // Todas as mensagens automaticas por 24 h (respostas do robo inclusive).
    autoStart: 80,
    autoMax: num(env.WHATSAPP_AUTO_DAILY_LIMIT, 500, { min: 1 }),
    // Todas as mensagens (painel + automaticas) por hora.
    hourStart: 25,
    hourMax: num(env.WHATSAPP_HOURLY_LIMIT, 80, { min: 1 }),
    // Aviso de atraso a quem nunca escreveu (NAO recomendado).
    allowCold: TRUE.has(String(env.WHATSAPP_OVERDUE_COLD ?? '').trim().toLowerCase()),
    fromHour: 9,
    toHour: 20,
    similarityMax: 0.85,
    maxSimilarRecipients: 2,
    maxLinks: 2,
    maxEmojis: 6,
    maxProactiveLength: 900,
    // Avisos das ultimas 24 h que ninguem leu nem respondeu: passou disto,
    // espera (nao adianta mandar mais para quem nao esta lendo).
    maxUnengaged: 6,
    // Mensagens do painel em 24 h para a MESMA pessoa que nunca escreveu.
    maxColdPerChat: 2,
    // Sinais de denuncia (ver computeHealth).
    healthWindowMs: 7 * DAY,
    healthMinSample: 8,
    healthMinEngaged: 0.3,
    healthPauseMs: 72 * HOUR,
    errorsToPause: 3,
    errorsPauseMs: 48 * HOUR,
    restrictedPauseMs: 7 * DAY,
    // Restricao da Meta para iniciar conversas: a pausa dura a restricao
    // inteira e mais este tanto depois que ela acaba (no minimo 72 h).
    afterRestrictionMs: 48 * HOUR,
    minRestrictionPauseMs: 72 * HOUR,
    // Sem data de fim informada pelo WhatsApp: trata como um dia.
    unknownRestrictionMs: DAY,
  };
}

// ---------- Aquecimento ----------

/** Dia do aquecimento (0 = primeiro dia). */
export function warmupDay(startAt, now = Date.now()) {
  const start = startAt ? new Date(startAt).getTime() : NaN;
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((now - start) / DAY));
}

/** Os tetos do dia do aquecimento. */
export function limitsFor(cfg, day) {
  const frac = cfg.warmupDays > 0 ? Math.min(1, (day + 1) / cfg.warmupDays) : 1;
  const ramp = (start, max) => Math.round(Math.min(start, max) + (max - Math.min(start, max)) * frac);
  return {
    day,
    warming: frac < 1,
    proactivePerDay: ramp(cfg.proactiveStart, cfg.proactiveMax),
    autoPerDay: ramp(cfg.autoStart, cfg.autoMax),
    perHour: ramp(cfg.hourStart, cfg.hourMax),
  };
}

// ---------- Conteudo ----------

const SHORTENERS =
  /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|cutt\.ly|rebrand\.ly|shorturl\.at|encurtador\.com\.br|tiny\.cc|rb\.gy|s\.id|v\.gd|t\.ly|lnkd\.in)\/\S*/i;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;
// Qualquer coisa que o WhatsApp mostra como link (tambem sem "https://", como
// "site.com.br/x" ou "wa.me/..."). Sem "g": .test() com "g" guarda a posicao.
// Terminacao: as de pais que existem (IANA: .br, .la, .be, .ee, .us, .to,
// .me...; "Chegou.Um" ou "ontem.Ok" nao viram link, porque .um/.ok nao
// existem) ou um dos nomes genericos comuns. (Antes do "dominio": nem letra,
// numero, "@" - e-mail - nem um "x." de outro dominio; "..." pode.)
const COUNTRY_TLDS =
  'ac ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo bq br bs bt bw by bz ' +
  'ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ' +
  'ga gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ' +
  'ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mg mh mk ml mm mn mo mp mq mr ms mt ' +
  'mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru ' +
  'rw sa sb sc sd se sg sh si sk sl sm sn so sr ss st su sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ' +
  'ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw';
const TLD =
  '(?:com|net|org|info|biz|app|dev|page|site|online|xyz|top|shop|store|click|link|live|life|church|blog|news|club|website|space|tech|digital|email|art|fun|vip|pro|gov|edu|mobi|name|social|chat|one|world|today|bio|gle|gospel|faith|bible|' +
  COUNTRY_TLDS.split(' ').join('|') +
  ')';
const LINK_ONE = new RegExp(
  '\\bhttps?:\\/\\/\\S+|\\bwww\\.\\S+|(?<![\\p{L}\\d@-]|[\\p{L}\\d-]\\.)[\\p{L}\\d-]+(?:\\.[\\p{L}\\d-]+)*\\.' + TLD + '(?![\\p{L}\\d-])(?:\\/\\S*)?',
  'iu'
);

/** O primeiro pedaco do texto que o WhatsApp mostraria como link ('' = nenhum). */
export function firstLink(text) {
  const match = String(text || '').match(LINK_ONE);
  return match ? match[0].slice(0, 60) : '';
}
const MONEY = /\b(pix|boleto|pagamento|pagar|multa|cobranca|cobrança|r\$|deposito|depósito|fatura|divida|dívida)\b/i;
const EMOJI = /\p{Extended_Pictographic}/gu;

function shouting(text) {
  const letters = String(text).replace(/https?:\/\/\S+/g, '').match(/\p{L}/gu) || [];
  if (letters.length < 20) return false;
  const upper = letters.filter((c) => c === c.toUpperCase() && c !== c.toLowerCase()).length;
  return upper / letters.length > 0.5;
}

export function contentFindings(text, { proactive = false, cfg = readPolicyConfig() } = {}) {
  const value = String(text || '');
  const blocks = [];
  const warns = [];
  if (SHORTENERS.test(value)) blocks.push({ rule: 'SHORTENER', msg: 'Link encurtado (bit.ly e parecidos) é gatilho de spam.' });
  const links = value.match(LINK) || [];
  if (links.length > cfg.maxLinks) warns.push({ rule: 'MANY_LINKS', msg: links.length + ' links na mesma mensagem.' });
  if (shouting(value)) warns.push({ rule: 'SHOUTING', msg: 'Mais da metade das letras em CAIXA ALTA.' });
  const emojis = value.match(EMOJI) || [];
  if (emojis.length > cfg.maxEmojis) warns.push({ rule: 'EMOJIS', msg: emojis.length + ' emojis.' });
  if (proactive && MONEY.test(value)) {
    warns.push({ rule: 'MONEY_WORDS', msg: 'Palavras de cobrança de dinheiro numa mensagem puxada pelo número.' });
  }
  if (proactive && value.length > cfg.maxProactiveLength) {
    warns.push({ rule: 'LONG_PROACTIVE', msg: 'Mensagem puxada pelo número longa demais.' });
  }
  if (proactive && links.length) {
    warns.push({ rule: 'PROACTIVE_LINK', msg: 'Link numa mensagem puxada pelo número.' });
  }
  return { blocks, warns };
}

/**
 * O molde de um texto: o que estiver em *negrito* ou entre aspas (titulos), as
 * palavras com inicial maiuscula fora do comeco de frase (nomes) e os numeros
 * (datas) viram marcadores. Dois avisos do mesmo modelo para pessoas e livros
 * diferentes dao o MESMO molde.
 */
export function templateOf(text) {
  return String(text || '')
    .replace(/\*[^*\n]{1,200}\*/g, ' TITULO ')
    .replace(/["“”][^"“”\n]{1,200}["“”]/g, ' TITULO ')
    .replace(/https?:\/\/\S+/g, ' LINK ')
    .replace(/(^|[^.!?\n]\s)(\p{Lu}[\p{Ll}\p{M}]+)/gu, (_, before) => before + 'NOME')
    .replace(/\d+/g, '0');
}

// ---------- O juiz ----------

/**
 * Pode sair? { ok, blocks: [{rule,msg}], warns: [{rule,msg}] }.
 * ctx:
 * - text, chatId
 * - purpose: "reply" (robo respondendo), "proactive" (o numero puxa a
 *   conversa: aviso de atraso), "staff" (aviso a administrador), "panel"
 *   (um administrador digitou)
 * - contact: { inbound: bool } (a pessoa ja escreveu para o numero?)
 * - recent: [{ chatId, text, purpose }] enviados nas ultimas 24 h
 * - counts: { lastHour, autoToday, proactiveToday, unengaged }
 * - limits: limitsFor(...)
 * - health: { pausedUntil, reason }
 * - restriction: { active, until } (a restricao da Meta para iniciar conversas)
 * - hour: hora de Brasilia; now
 */
export function auditOutgoing(ctx, cfg = readPolicyConfig()) {
  const { text, purpose, contact = {}, recent = [], counts = {}, limits, health = {}, restriction = {}, hour, now = Date.now() } = ctx;
  const proactive = purpose === 'proactive';
  const coldPanel = purpose === 'panel' && !contact.inbound;
  const { blocks, warns } = contentFindings(text, { proactive, cfg });
  const lim = limits || limitsFor(cfg, 0);

  // A Meta restringiu a conta para INICIAR conversas: nada puxado pelo numero
  // sai (nem o painel escrevendo a quem nunca escreveu). Insistir conta como
  // mais uma tentativa e piora a restricao. Responder a quem escreveu pode.
  const restricted = restriction.active && restriction.until && new Date(restriction.until).getTime() > now;
  // (o aviso a um administrador que nunca escreveu para o numero tambem e
  // "iniciar conversa")
  const coldStaff = purpose === 'staff' && !contact.inbound;
  if ((proactive || coldPanel || coldStaff) && restricted) {
    blocks.push({
      rule: 'RESTRICTED',
      msg: 'O WhatsApp restringiu este número para iniciar conversas. Espere a restrição acabar; responder a quem escreveu continua funcionando.',
    });
  }
  if (proactive && contact.optOut) {
    blocks.push({ rule: 'OPTED_OUT', msg: 'Essa pessoa pediu para não receber mais avisos por aqui.' });
  }
  if (proactive && !contact.inbound && !cfg.allowCold) {
    blocks.push({ rule: 'COLD_CONTACT', msg: 'Essa pessoa nunca escreveu para o número da biblioteca (lista fria).' });
  }
  if (proactive && (hour < cfg.fromHour || hour >= cfg.toHour)) {
    blocks.push({ rule: 'QUIET_HOURS', msg: 'Fora do horário (9h às 20h de Brasília).' });
  }
  // PRIMEIRA MENSAGEM PELO PAINEL a quem nunca escreveu para o numero: de um
  // numero estrangeiro e fora dos contatos da pessoa, e o que mais vira
  // "bloquear e denunciar" - e denuncia e o que mais pesa para a Meta. De
  // noite ou com link (cara de golpe), espera.
  if (coldPanel && (hour < cfg.fromHour || hour >= cfg.toHour)) {
    blocks.push({
      rule: 'COLD_QUIET_HOURS',
      msg:
        'Essa pessoa nunca escreveu para o número da biblioteca: a primeira mensagem só sai das ' +
        cfg.fromHour +
        'h às ' +
        cfg.toHour +
        'h (Brasília). Mensagem de número desconhecido fora desse horário costuma ser denunciada.',
    });
  }
  const link = coldPanel ? firstLink(text) : '';
  if (link) {
    blocks.push({
      rule: 'COLD_LINK',
      msg:
        'Essa pessoa nunca escreveu para o número da biblioteca: mande sem link (“' +
        link +
        '” vira link no WhatsApp; se não era para ser, ponha um espaço depois do ponto). Link de número desconhecido parece golpe; ele pode ir depois que a pessoa responder.',
    });
  }
  const paused = health.pausedUntil && new Date(health.pausedUntil).getTime() > now;
  if (proactive && paused) {
    blocks.push({ rule: 'HEALTH_PAUSE', msg: 'Mensagens puxadas pelo número estão em pausa: ' + (health.reason || 'sinais de denúncia') + '.' });
  }
  if ((proactive || coldPanel) && (counts.proactiveToday || 0) >= lim.proactivePerDay) {
    blocks.push({
      rule: 'PROACTIVE_DAILY',
      msg:
        'Limite de ' +
        lim.proactivePerDay +
        ' primeiras mensagens por dia' +
        (lim.warming ? ' (número em aquecimento, dia ' + (lim.day + 1) + ')' : '') +
        '.',
    });
  }
  if (proactive && (counts.unengaged || 0) >= cfg.maxUnengaged) {
    blocks.push({
      rule: 'UNENGAGED',
      msg: counts.unengaged + ' avisos das últimas 24 h ainda sem leitura nem resposta: espera antes de mandar mais.',
    });
  }
  // Contato frio pelo painel: no maximo 2 mensagens em 24 h sem resposta
  // (senao 8 cobrancas seguidas para a mesma pessoa passariam).
  if (coldPanel && (counts.chatToday || 0) >= cfg.maxColdPerChat) {
    blocks.push({
      rule: 'COLD_REPEAT',
      msg:
        'Essa pessoa nunca escreveu para o número e já recebeu ' +
        counts.chatToday +
        ' mensagens nas últimas 24 h. Espere ela responder.',
    });
  }
  // O AQUECIMENTO (rampa) vale so para o que o NUMERO puxa (aviso de atraso,
  // painel para contato frio). Resposta a quem escreveu, aviso ao
  // administrador e painel para quem ja escreveu ficam nos tetos cheios:
  // ninguem fica sem resposta nem o administrador sem aviso por causa dele.
  if ((purpose === 'reply' || proactive) && (counts.autoToday || 0) >= cfg.autoMax) {
    blocks.push({ rule: 'AUTO_DAILY', msg: 'Limite diário de mensagens automáticas (' + cfg.autoMax + ').' });
  }
  const hourCap =
    proactive || coldPanel
      ? lim.perHour
      : purpose === 'reply'
        ? cfg.hourMax * 2
        : purpose === 'panel'
          ? cfg.hourMax
          : Infinity; // aviso ao administrador: sem teto por hora
  if ((counts.lastHour || 0) >= hourCap) {
    blocks.push({ rule: 'HOURLY', msg: 'Limite de ' + hourCap + ' mensagens por hora.' });
  }

  // Copia e cola: quantas OUTRAS conversas receberam texto quase igual. Compara
  // o MOLDE (nome, titulo, data e numeros trocados por marcadores): senao o
  // mesmo texto fixo com outra pessoa e outro livro passaria por "diferente".
  const similarChats = new Set();
  const mold = templateOf(text);
  for (const item of recent) {
    if (!item?.text || String(item.chatId) === String(ctx.chatId)) continue;
    if (similarity(mold, templateOf(item.text)) >= cfg.similarityMax) {
      similarChats.add(String(item.chatId));
    }
  }
  if (similarChats.size >= cfg.maxSimilarRecipients) {
    const finding = {
      rule: 'NEAR_DUPLICATE',
      msg: 'Texto quase igual ao enviado a outras ' + similarChats.size + ' conversas nas últimas 24 h.',
    };
    // A resposta do robo repete o menu por natureza (e a pessoa pediu):
    // so aviso. A mensagem puxada pelo numero, nao.
    if (proactive) blocks.push(finding);
    else warns.push(finding);
  }
  return { ok: blocks.length === 0, blocks, warns, similarChats: similarChats.size };
}

// ---------- Banco: contatos, aquecimento, saude ----------

function contactQuery({ phone, lid }) {
  const or = [];
  const canon = canonicalPhone(phone);
  if (canon) or.push({ phone: canon });
  if (lid) or.push({ lid: String(lid) });
  return or.length ? { $or: or } : null;
}

// Garante UM contato por pessoa (indice unico em phone/lid: duas mensagens
// ao mesmo tempo nao criam dois) e devolve o filtro dele.
async function ensureContact({ phone, lid }) {
  const canon = canonicalPhone(phone);
  const filter = canon ? { phone: canon } : lid ? { lid: String(lid) } : null;
  if (!filter) return null;
  // Gravado antes so pelo LID e agora com o numero: completa o mesmo registro.
  if (canon && lid) {
    await WaContact.updateOne({ lid: String(lid), phone: '' }, { $set: { phone: canon } }).catch(() => {});
  }
  try {
    await WaContact.updateOne(filter, { $setOnInsert: { ...filter } }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error; // outro chegou primeiro: tudo bem
  }
  if (canon && lid) await WaContact.updateOne({ ...filter, lid: '' }, { $set: { lid: String(lid) } }).catch(() => {});
  return filter;
}

/** A pessoa escreveu para o numero (vale tambem o historico do vinculo). */
export async function noteInbound({ phone, lid, at = new Date(), live = true }) {
  const filter = await ensureContact({ phone, lid });
  if (!filter) return;
  const when = at instanceof Date ? at : new Date(at);
  const existing = await WaContact.findOne(filter).select('_id lastProactiveAt').lean();
  if (!existing) return;
  const update = { $inc: { inboundCount: 1 }, $max: { lastInboundAt: when } };
  // Respondeu a uma mensagem puxada pelo numero: sinal bom para a saude.
  if (live && existing.lastProactiveAt && when >= existing.lastProactiveAt) {
    update.$set = { answeredProactiveAt: when };
  }
  await WaContact.updateOne({ _id: existing._id }, update);
  // (o $min nao troca null: a primeira vez grava direto)
  await WaContact.updateOne({ _id: existing._id, firstInboundAt: null }, { $set: { firstInboundAt: when } });
  await WaContact.updateOne({ _id: existing._id, firstInboundAt: { $gt: when } }, { $set: { firstInboundAt: when } });
}

export async function noteProactive({ phone, lid, at = new Date() }) {
  const filter = await ensureContact({ phone, lid });
  if (!filter) return;
  await WaContact.updateOne(filter, {
    $set: { lastProactiveAt: at },
    $inc: { proactiveCount: 1 },
    // as ultimas (para o teto por pessoa de quem nunca escreveu)
    $push: { recentProactive: { $each: [at], $slice: -10 } },
  });
}

/** { inbound, lastInboundAt } de quem esta na conversa. */
export async function contactOf(chat) {
  const query = contactQuery({ phone: chat?.phone, lid: chat?.lid });
  if (!query) return { inbound: false };
  // (pode haver dois registros da mesma pessoa - um pelo LID, outro pelo
  // numero - de antes de o WhatsApp revelar o numero: junta os dois)
  const found = await WaContact.find(query).select('lastInboundAt recentProactive optOutAt proactiveCount').limit(5).lean();
  const dayAgo = Date.now() - DAY;
  const last = found.map((c) => c.lastInboundAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
  // (soma simples: cada envio e anotado num registro so; e o horario vem em
  // segundos, entao dois envios no mesmo segundo sao DOIS, nao um)
  const proactiveDay = found
    .flatMap((c) => c.recentProactive || [])
    .filter((d) => new Date(d).getTime() > dayAgo).length;
  return {
    inbound: Boolean(last),
    lastInboundAt: last,
    // mensagens puxadas pelo numero para esta pessoa nas ultimas 24 h
    proactiveDay,
    // e desde sempre (0 = o proximo aviso e o PRIMEIRO que ela recebe)
    proactiveTotal: found.reduce((sum, c) => sum + (c.proactiveCount || 0), 0),
    // pediu para nao receber mais avisos (vale se QUALQUER registro dela diz)
    optOut: found.some((c) => Boolean(c.optOutAt)),
  };
}

/**
 * A pessoa pediu para parar (out = true) ou para voltar a receber os avisos.
 * Vale para todos os registros dela (numero e LID).
 */
export async function setOptOut({ phone, lid }, out, at = new Date()) {
  await ensureContact({ phone, lid });
  const query = contactQuery({ phone, lid });
  if (!query) return false;
  await WaContact.updateMany(query, { $set: { optOutAt: out ? at : null } });
  return true;
}

/**
 * Quem escreveu nas conversas que ja estao no painel vira contato. Roda a
 * cada subida do servidor (barato: com as mensagens temporarias o painel so
 * tem 7 dias), para cobrir as conversas de antes desta versao e qualquer
 * mensagem que tenha escapado do registro. Devolve quantos contatos NOVOS.
 */
export async function backfillContacts() {
  const rows = await WaMessage.aggregate([
    { $match: { fromMe: false } },
    { $group: { _id: '$chat', first: { $min: '$at' }, last: { $max: '$at' } } },
    { $lookup: { from: WaChat.collection.collectionName, localField: '_id', foreignField: '_id', as: 'chat' } },
    { $unwind: '$chat' },
  ]);
  let added = 0;
  for (const row of rows) {
    const filter = await ensureContact({ phone: row.chat.phone, lid: row.chat.lid });
    if (!filter) continue;
    const result = await WaContact.updateOne(
      { ...filter, lastInboundAt: null },
      { $set: { lastInboundAt: row.last, firstInboundAt: row.first, inboundCount: 1 } }
    );
    if (result.modifiedCount) added += 1;
    else await WaContact.updateOne(filter, { $max: { lastInboundAt: row.last } });
  }
  return added;
}

/**
 * Inicio do aquecimento: o reinicio automatico (conta restringida, numero
 * vinculado de novo) vale mesmo com WHATSAPP_WARMUP_START, se for mais novo.
 */
export async function warmupStartAt(cfg = readPolicyConfig(), now = Date.now()) {
  const doc = await Setting.findOneAndUpdate(
    { _id: WARMUP_KEY },
    { $setOnInsert: { value: { startedAt: new Date(now).toISOString() } } },
    { upsert: true, new: true }
  ).lean();
  const stored = Date.parse(doc?.value?.startedAt);
  const forced = cfg.warmupStart ? Date.parse(cfg.warmupStart) : NaN;
  if (Number.isFinite(forced)) {
    const restarted = doc?.value?.restarted && Number.isFinite(stored) && stored > forced;
    return new Date(restarted ? stored : forced);
  }
  return Number.isFinite(stored) ? new Date(stored) : new Date(now);
}

/** A conta foi restringida (ou o numero foi vinculado de novo): o aquecimento recomeca do dia 1. */
export async function restartWarmup(now = Date.now()) {
  await Setting.updateOne(
    { _id: WARMUP_KEY },
    { $set: { value: { startedAt: new Date(now).toISOString(), restarted: true } } },
    { upsert: true }
  );
}

export async function readHealth() {
  const doc = await Setting.findById(HEALTH_KEY).lean();
  return doc?.value && typeof doc.value === 'object' ? doc.value : {};
}

/** Pausa as mensagens puxadas pelo numero (nunca encurta uma pausa maior). */
export async function pauseProactive(reason, ms, now = Date.now()) {
  const current = await readHealth();
  const until = now + ms;
  if (current.pausedUntil && new Date(current.pausedUntil).getTime() >= until) return current;
  const value = { pausedUntil: new Date(until).toISOString(), reason, at: new Date(now).toISOString() };
  await Setting.updateOne({ _id: HEALTH_KEY }, { $set: { value } }, { upsert: true });
  console.warn('WhatsApp: mensagens puxadas pelo número em pausa até ' + value.pausedUntil + ' (' + reason + ').');
  return value;
}

// ---------- A restricao avisada pela propria Meta ----------

/** { active, until, type, at } ou {} (nunca houve). */
export async function readRestriction() {
  const doc = await Setting.findById(RESTRICTION_KEY).lean();
  return doc?.value && typeof doc.value === 'object' ? doc.value : {};
}

/**
 * O WhatsApp avisou o estado da restricao para iniciar conversas
 * (state = { isActive, timeEnforcementEnds, enforcementType } do Baileys).
 * Ativa: guarda, pausa as mensagens puxadas pelo numero ate o fim dela e
 * mais uns dias, e recomeca o aquecimento. Devolve { active, until, isNew }
 * (isNew: e uma restricao que ainda nao estava anotada - avisar a equipe).
 */
export async function noteRestriction(state, cfg = readPolicyConfig(), now = Date.now()) {
  const current = await readRestriction();
  const wasActive = Boolean(current.active && current.until && new Date(current.until).getTime() > now);
  if (!state?.isActive) {
    if (current.active) {
      await Setting.updateOne(
        { _id: RESTRICTION_KEY },
        { $set: { value: { ...current, active: false, liftedAt: new Date(now).toISOString() } } }
      );
      console.warn('WhatsApp: a restrição para iniciar conversas acabou. Os avisos seguem em pausa por precaução.');
    }
    return { active: false, until: null, isNew: false };
  }
  const ends = state.timeEnforcementEnds ? new Date(state.timeEnforcementEnds).getTime() : NaN;
  // (sem data, ou data ja passada / a um minuto: um dia, por precaucao)
  // (data absurda - anos a frente - fica em 60 dias: Date invalida quebraria
  // a gravacao e a pausa nao aconteceria)
  const sane = Number.isFinite(ends) && ends > now + 5 * 60 * 1000 ? Math.min(ends, now + 60 * DAY) : NaN;
  const until = Number.isFinite(sane) ? sane : now + cfg.unknownRestrictionMs;
  const known = wasActive ? new Date(current.until).getTime() : 0;
  const value = {
    active: true,
    until: new Date(Math.max(until, known)).toISOString(),
    type: String(state.enforcementType || '').slice(0, 60),
    at: wasActive ? current.at : new Date(now).toISOString(),
  };
  await Setting.updateOne({ _id: RESTRICTION_KEY }, { $set: { value } }, { upsert: true });
  await pauseProactive(
    'o WhatsApp restringiu o início de conversas neste número',
    Math.max(new Date(value.until).getTime() - now + cfg.afterRestrictionMs, cfg.minRestrictionPauseMs),
    now
  );
  if (!wasActive) await restartWarmup(now);
  return { active: true, until: value.until, type: value.type, isNew: !wasActive };
}

/**
 * Confere os SINAIS de denuncia e pausa se preciso:
 * - mensagens recusadas pelo WhatsApp (status 0) nas ultimas 24 h;
 * - avisos de atraso que quase ninguem leu nem respondeu (pessoa que nao le
 *   nem responde e quem costuma bloquear).
 * Devolve { pausedUntil, reason, stats }.
 */
export async function computeHealth(cfg = readPolicyConfig(), now = Date.now()) {
  const current = await readHealth();
  const pausedUntil = current.pausedUntil ? new Date(current.pausedUntil).getTime() : 0;
  // Em pausa: nada a recalcular (e nao estica a pausa a cada rodada).
  if (pausedUntil > now) return current;
  // Depois de uma pausa, a conta recomeca do fim dela: os avisos de antes
  // ja "pagaram" a pausa; o numero precisa de uma amostra nova.
  const sinceDay = new Date(Math.max(now - DAY, pausedUntil));
  const since = new Date(Math.max(now - cfg.healthWindowMs, pausedUntil));
  const [errors, proactive] = await Promise.all([
    WaMessage.countDocuments({ fromMe: true, status: 0, at: { $gte: sinceDay } }),
    WaMessage.find({ fromMe: true, auto: 'overdue', at: { $gte: since, $lte: new Date(now - 6 * HOUR) } })
      .select('status chat')
      .lean(),
  ]);
  const read = proactive.filter((m) => m.status >= 4).length;
  const answered = await WaContact.countDocuments({
    lastProactiveAt: { $gte: since, $lte: new Date(now - 6 * HOUR) },
    answeredProactiveAt: { $ne: null },
    $expr: { $gte: ['$answeredProactiveAt', '$lastProactiveAt'] },
  });
  const engaged = Math.max(read, answered);
  const stats = { errors, proactive: proactive.length, read, answered, engaged };
  if (errors >= cfg.errorsToPause) {
    return { ...(await pauseProactive(errors + ' mensagens recusadas pelo WhatsApp em 24 h', cfg.errorsPauseMs, now)), stats };
  }
  if (proactive.length >= cfg.healthMinSample && engaged / proactive.length < cfg.healthMinEngaged) {
    return {
      ...(await pauseProactive(
        'poucos avisos lidos ou respondidos (' + engaged + ' de ' + proactive.length + ')',
        cfg.healthPauseMs,
        now
      )),
      stats,
    };
  }
  return { ...current, stats };
}

/**
 * Avisos das ultimas 24 h ainda sem leitura (status < 4) e sem resposta da
 * pessoa: o "credito" de avisos no ar (ver maxUnengaged).
 */
export async function unengagedRecent(now = Date.now()) {
  const rows = await WaMessage.find({
    fromMe: true,
    auto: 'overdue',
    status: { $lt: 4, $gt: 0 },
    at: { $gte: new Date(now - DAY) },
  })
    .select('chat at')
    .lean();
  if (!rows.length) return 0;
  const chats = await WaChat.find({ _id: { $in: rows.map((r) => r.chat) } })
    .select('phone lid')
    .lean();
  const byId = new Map(chats.map((c) => [String(c._id), c]));
  let count = 0;
  for (const row of rows) {
    const chat = byId.get(String(row.chat));
    const query = chat ? contactQuery(chat) : null;
    const contact = query ? await WaContact.findOne(query).select('lastInboundAt').lean() : null;
    if (!(contact?.lastInboundAt && contact.lastInboundAt >= row.at)) count += 1;
  }
  return count;
}

/** Hora (0-23) em Brasilia. */
export function brazilHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date)
  );
}

/** Para onde a mensagem vai, pelo tipo de envio (ver auditOutgoing). */
export function purposeOf(auto) {
  if (auto === 'overdue') return 'proactive';
  if (auto === 'handoff' || auto === 'request') return 'staff';
  if (auto) return 'reply';
  return 'panel';
}
