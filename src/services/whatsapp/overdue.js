import Loan from '../../models/Loan.js';
import WaChat from '../../models/WaChat.js';
import { addDays, brDate, dayOf, todayInBrazil } from '../brDates.js';
import { resolveChat } from './store.js';
import { digitsOf } from './phone.js';
import WaMessage from '../../models/WaMessage.js';
import { between, defaultRng, leastSimilar, pick } from './humanize.js';
import { brazilHour, computeHealth, contactOf, readPolicyConfig, templateOf } from './policy.js';

/**
 * AVISO AUTOMATICO DE ATRASO pelo WhatsApp da biblioteca.
 *
 * Passou 1 dia da data de devolucao (o livro esta atrasado), a pessoa recebe
 * UMA mensagem por prazo vencido: se o prazo for estendido e vencer de novo,
 * sai outro aviso (para o prazo novo); nunca dois para o mesmo prazo. O
 * registro fica no emprestimo (overdueAutoFor = o prazo avisado).
 *
 * Cuidados com o numero da biblioteca (envio em massa e o que faz o WhatsApp
 * bloquear):
 * - so atrasos RECENTES (ate MAX_LATE_DAYS): ao publicar, os atrasos antigos
 *   nao recebem uma rajada de mensagens;
 * - so em horario comercial de Brasilia, poucos por rodada e com intervalo;
 * - nao avisa se um administrador ja cobrou depois do vencimento, nem no meio
 *   de um atendimento humano.
 * Nao mexe na "cobranca" manual (uma a cada 30 dias, services/charges.js).
 *
 * Contra o bloqueio do numero pela Meta (ver policy.js e humanize.js):
 * - so para quem JA ESCREVEU para o numero (contato com opt-in); quem nunca
 *   escreveu fica para a cobranca manual do painel. WHATSAPP_OVERDUE_COLD=true
 *   desfaz isso (nao recomendado);
 * - texto com variacao, escolhido para NAO parecer com os avisos do dia;
 * - "digitando…" proporcional, poucos por rodada, intervalos sorteados de 1 a
 *   4 minutos e rodadas a cada 10 a 25 minutos (nada de relogio exato);
 * - pausa sozinho com sinais de denuncia (mensagens recusadas, avisos que
 *   ninguem le) e quando a conta e restringida.
 */

const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);

export function readOverdueConfig(env = process.env) {
  return {
    enabled: !FALSY.has(String(env.WHATSAPP_OVERDUE_ENABLED ?? '').trim().toLowerCase()),
    // Rodadas em intervalos sorteados (minutos), nunca no mesmo compasso.
    everyMs: [10 * 60 * 1000, 25 * 60 * 1000],
    firstRunMs: [3 * 60 * 1000, 9 * 60 * 1000],
    maxLateDays: 7,
    perRun: 3,
    // Entre um aviso e o proximo (sorteado).
    gapMs: [60 * 1000, 4 * 60 * 1000],
    // Horario de Brasilia em que pode sair (das 9h as 19h59).
    fromHour: 9,
    toHour: 20,
  };
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// As partes do aviso, cada uma com formas equivalentes (o sentido e as
// opcoes 1 e 0 nunca mudam; ver o passo "blocked" em bot.js).
const OPENINGS = [
  'Olá{name}. Aqui é da Biblioteca ADMP Brasil.',
  'Oi{name}, tudo bem? Aqui é da Biblioteca ADMP Brasil.',
  'Olá{name}, a paz! Quem fala é a Biblioteca ADMP Brasil.',
  'Oi{name}! Tudo bem? Biblioteca ADMP Brasil por aqui.',
  'Olá{name}! Aqui é da Biblioteca ADMP Brasil.',
];
const BODIES = [
  'O prazo de devolução do livro {title} venceu em {date}.',
  'O livro {title} estava com devolução marcada para {date}.',
  'Passando para lembrar que a devolução do livro {title} era até {date}.',
  'Vimos aqui que o prazo do livro {title} terminou em {date}.',
  'A data de devolução do livro {title} ({date}) já passou.',
];
const ASKS = [
  'Pedimos que faça a devolução o quanto antes.',
  'Você consegue devolvê-lo assim que possível?',
  'Quando puder, por favor, faça a devolução.',
  'Se puder devolver nos próximos dias, agradecemos muito.',
  'Assim que possível, traga o livro de volta, por favor.',
];
const EXTRAS = [
  '',
  '',
  'Outras pessoas também querem ler. 📚',
  'Se precisar de mais tempo, é só falar com a gente.',
  'Muito obrigado! 🙏',
];
const OPTION_INTROS = ['', '', 'Se quiser, responda:', 'Pode responder por aqui:'];
const OPTION_ADMIN = ['1️⃣ Falar com um administrador', '1️⃣ Falar com um administrador da biblioteca'];
const OPTION_MENU = ['0️⃣ Ver o menu de atendimento', '0️⃣ Ver as outras opções do atendimento'];
// A SAIDA: quem nao quer receber avisos tem como dizer (e o robo obedece:
// bot.js, "stop"). Sem isso, a unica saida da pessoa e bloquear ou denunciar
// o numero - e e isso que a Meta conta. Vai sempre no PRIMEIRO aviso que a
// pessoa recebe e, depois, de vez em quando.
const OPT_OUT_HINTS = [
  'Se preferir não receber avisos por aqui, é só responder *parar*.',
  'Não quer receber estes avisos pelo WhatsApp? Responda *parar*.',
  'Para não receber mais avisos por este número, responda *parar*.',
];

/**
 * O aviso de atraso, com variacao (rng escolhe as formas).
 * optOutHint: true = leva a linha de como parar de receber; false = nao
 * leva; sem dizer = uma vez a cada tres.
 */
export function overdueText(loan, rng = defaultRng, { optOutHint } = {}) {
  const name = firstName(loan.personName);
  const title = '*' + String(loan.bookTitle || '').replace(/[*_~`]/g, '').trim() + '*';
  const fill = (text) =>
    text
      .replace('{name}', name ? ', ' + name : '')
      .replace('{title}', title)
      .replace('{date}', brDate(dayOf(loan.dueDate)));
  const extra = pick(EXTRAS, rng);
  const intro = pick(OPTION_INTROS, rng);
  const body =
    fill(pick(OPENINGS, rng)) +
    '\n\n' +
    fill(pick(BODIES, rng)) +
    ' ' +
    pick(ASKS, rng) +
    (extra ? ' ' + extra : '') +
    '\n\n' +
    (intro ? intro + '\n' : '') +
    pick(OPTION_ADMIN, rng) +
    '\n' +
    pick(OPTION_MENU, rng);
  // (sorteado DEPOIS do resto: o texto de antes desta linha nao muda)
  const hint = optOutHint === undefined ? rng() > 2 / 3 : optOutHint;
  return hint ? body + '\n\n' + pick(OPT_OUT_HINTS, rng) : body;
}

// Envio que nao chegou a sair (pode tentar de novo depois).
// (POLICY_BLOCKED: o fiscal segurou - teto do dia, horario, pausa, texto
// parecido demais: tenta numa rodada seguinte.)
const RETRY_LATER = new Set([
  'WA_OFFLINE',
  'LOOKUP_FAILED',
  'AUTO_DAILY_LIMIT',
  'SEND_FAILED',
  'TIMEOUT',
  'POLICY_BLOCKED',
  'SUPERSEDED',
]);

export function createOverdueReminders({
  whatsapp,
  bot,
  config: overrides = {},
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rng = defaultRng,
  policy = whatsapp?.config?.policy || readPolicyConfig(),
} = {}) {
  const cfg = { ...readOverdueConfig(), ...overrides };
  const span = (value) => (Array.isArray(value) ? Math.round(between(value[0], value[1], rng)) : value);

  // Os avisos das ultimas 24 h (para o novo nao sair parecido com eles).
  async function recentNotices() {
    const rows = await WaMessage.find({
      fromMe: true,
      auto: 'overdue',
      at: { $gte: new Date(now() - 24 * 60 * 60 * 1000) },
    })
      .select('text')
      .lean();
    return rows.map((row) => row.text).filter(Boolean);
  }
  let timer = null;
  let first = null;
  let running = false;
  // Atrasos de quem nunca escreveu ja contados no log (um aviso no log por
  // prazo, e nao a cada rodada).
  const coldSeen = new Set();

  async function candidates() {
    const today = todayInBrazil();
    const oldest = addDays(today, -(cfg.maxLateDays + 1));
    const loans = await Loan.find({
      status: 'ativo',
      personPhone: { $nin: ['', null] },
      dueDate: { $gte: new Date(oldest + 'T00:00:00Z'), $lt: new Date(today + 'T23:59:59Z') },
    })
      .sort({ dueDate: 1 })
      .limit(200)
      .lean();
    return loans.filter((loan) => {
      const due = dayOf(loan.dueDate);
      if (!due || !(today > due)) return false;
      if (due < addDays(today, -cfg.maxLateDays)) return false;
      const done = loan.overdueAutoFor && new Date(loan.overdueAutoFor).getTime() === new Date(loan.dueDate).getTime();
      return !done;
    });
  }

  async function release(loan) {
    await Loan.updateOne(
      { _id: loan._id, overdueAutoFor: loan.dueDate },
      { $set: { overdueAutoFor: loan.overdueAutoFor ?? null, overdueAutoAt: loan.overdueAutoAt ?? null } }
    );
  }

  /** Uma rodada. Devolve quantos avisos sairam. */
  async function run() {
    if (running || !cfg.enabled || !whatsapp.isOpen()) return 0;
    const hour = brazilHour(new Date(now()));
    if (hour < cfg.fromHour || hour >= cfg.toHour) return 0;
    running = true;
    let sent = 0;
    let cold = 0;
    try {
      // Sinais de denuncia: pausa (e nao manda nada nesta rodada).
      const health = await computeHealth(policy, now());
      if (health.pausedUntil && new Date(health.pausedUntil).getTime() > now()) return 0;
      const list = await candidates();
      const recent = await recentNotices();
      for (const loan of list) {
        if (sent >= cfg.perRun || !whatsapp.isOpen()) break;
        if (!digitsOf(loan.personPhone)) continue;

        // Um administrador ja cobrou depois do vencimento: nao repete.
        const alreadyCharged =
          loan.overdueSentAt && new Date(loan.overdueSentAt) >= new Date(loan.dueDate);

        const chat = alreadyCharged ? null : await resolveChat({ phone: loan.personPhone });
        if (!alreadyCharged && !chat) continue;
        if (
          chat?.mode === 'human' &&
          chat.humanUntil &&
          new Date(chat.humanUntil).getTime() > now()
        ) {
          continue; // em atendimento: tenta na proxima rodada
        }
        // Robo silenciado pelo freio: o aviso ofereceria "1 – administrador"
        // numa conversa em que o robo nao responde. Tenta depois.
        if (chat?.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now()) continue;

        // Lista fria: quem nunca escreveu para o numero nao recebe aviso
        // automatico (e o que mais leva a Meta a bloquear). Fica sem marcar:
        // se a pessoa escrever, o aviso sai numa rodada seguinte.
        const contact = chat ? await contactOf(chat) : { inbound: false };
        // Pediu para parar de receber avisos: nunca mais (ate pedir de volta).
        if (chat && contact.optOut) continue;
        if (chat && !policy.allowCold && !contact.inbound) {
          const key = String(loan._id) + '|' + new Date(loan.dueDate).getTime();
          if (!coldSeen.has(key)) {
            coldSeen.add(key);
            cold += 1;
          }
          continue;
        }

        // Marca ANTES de enviar (duas copias do servidor nao avisam duas vezes).
        const claimed = await Loan.findOneAndUpdate(
          {
            _id: loan._id,
            status: 'ativo',
            dueDate: loan.dueDate,
            overdueAutoFor: loan.overdueAutoFor ?? null,
          },
          { $set: { overdueAutoFor: loan.dueDate, overdueAutoAt: new Date(now()) } },
          { new: true }
        );
        if (!claimed || alreadyCharged) continue;

        try {
          if (sent > 0) await wait(span(cfg.gapMs));
          // Entre varias formas, a menos parecida com os avisos do dia.
          // (compara o MOLDE, como o fiscal: nome, livro e data nao contam)
          // (o PRIMEIRO aviso que a pessoa recebe sempre diz como parar)
          const optOutHint = contact.proactiveTotal ? undefined : true;
          const { text } = leastSimilar((r) => overdueText(loan, r, { optOutHint }), recent, { rng, key: templateOf });
          // (entre o sorteio e o envio passam minutos: se um administrador
          // assumiu a conversa ou o robo foi silenciado, nao sai - tenta depois)
          const guard = typeof bot.stillMine === 'function' ? () => bot.stillMine(chat._id, { strict: true }) : null;
          await bot.sendAutomatic(chat, text, 'overdue', { typing: 'proactive', guard });
          recent.push(text);
          // A resposta da pessoa ("1" ou "0") ja cai no atendimento automatico.
          // Vale por 3 dias (a pessoa costuma responder um aviso bem depois). Um
          // atendimento humano JA VENCIDO volta ao robo aqui; senao o "1" da
          // pessoa cairia na saudacao e se perderia.
          await WaChat.updateOne(
            {
              _id: chat._id,
              $or: [
                { mode: 'bot' },
                { humanUntil: null },
                { humanUntil: { $lte: new Date(now()) } },
              ],
            },
            {
              $set: {
                mode: 'bot',
                humanUntil: null,
                handoffAt: null,
                botStep: 'blocked',
                botData: { ttlMs: 3 * 24 * 60 * 60 * 1000 },
                botAt: new Date(now()),
              },
            }
          );
          sent += 1;
        } catch (error) {
          if (RETRY_LATER.has(error?.code)) {
            await release(loan).catch(() => {});
            console.warn('WhatsApp: aviso de atraso adiado (' + error.code + (error.rules ? ': ' + error.rules.join(', ') : '') + ').');
            break;
          }
          // Sem WhatsApp, sem endereco, ou envio sem resposta a tempo (pode ter
          // saido): fica marcado, sem nova tentativa para este prazo.
          console.warn('WhatsApp: aviso de atraso não enviado (' + (error?.code || error?.message) + ').');
        }
      }
      if (sent) console.log('WhatsApp: ' + sent + ' aviso(s) de atraso enviado(s).');
      if (cold) {
        console.log('WhatsApp: ' + cold + ' atraso(s) de quem nunca escreveu para o número: sem aviso automático (cobrança manual no painel).');
      }
    } catch (error) {
      console.error('WhatsApp: falha na rodada de avisos de atraso:', error.message);
    } finally {
      running = false;
    }
    return sent;
  }

  return {
    config: cfg,
    run,
    start() {
      if (timer || !cfg.enabled) return;
      // Cada rodada marca a proxima com um intervalo sorteado.
      const next = (ms) => {
        timer = setTimeout(() => {
          run()
            .catch(() => {})
            .finally(() => {
              if (timer) next(span(cfg.everyMs));
            });
        }, ms);
        timer.unref?.();
      };
      next(span(cfg.firstRunMs));
    },
    stop() {
      clearTimeout(first);
      clearTimeout(timer);
      timer = null;
    },
  };
}
