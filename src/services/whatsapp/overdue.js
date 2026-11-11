import Loan from '../../models/Loan.js';
import WaChat from '../../models/WaChat.js';
import { addDays, brDate, dayOf, todayInBrazil } from '../brDates.js';
import { resolveChat } from './store.js';
import { digitsOf } from './phone.js';

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
 */

const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);

export function readOverdueConfig(env = process.env) {
  return {
    enabled: !FALSY.has(String(env.WHATSAPP_OVERDUE_ENABLED ?? '').trim().toLowerCase()),
    everyMs: 15 * 60 * 1000,
    firstRunMs: 2 * 60 * 1000,
    maxLateDays: 7,
    perRun: 10,
    gapMs: 8 * 1000,
    // Horario de Brasilia em que pode sair (das 9h as 19h59).
    fromHour: 9,
    toHour: 20,
  };
}

function brazilHour(date) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date)
  );
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

export function overdueText(loan) {
  const name = firstName(loan.personName);
  const title = String(loan.bookTitle || '').replace(/[*_~`]/g, '').trim();
  return (
    'Olá' +
    (name ? ', ' + name : '') +
    '. Aqui é da Biblioteca ADMP Brasil.\n\n' +
    'O prazo de devolução do livro *' +
    title +
    '* venceu em ' +
    brDate(dayOf(loan.dueDate)) +
    '. Pedimos que faça a devolução o quanto antes.\n\n' +
    '1️⃣ Falar com um administrador\n0️⃣ Ver o menu de atendimento'
  );
}

// Envio que nao chegou a sair (pode tentar de novo depois).
const RETRY_LATER = new Set(['WA_OFFLINE', 'LOOKUP_FAILED', 'AUTO_DAILY_LIMIT', 'SEND_FAILED', 'TIMEOUT']);

export function createOverdueReminders({
  whatsapp,
  bot,
  config: overrides = {},
  now = () => Date.now(),
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const cfg = { ...readOverdueConfig(), ...overrides };
  let timer = null;
  let first = null;
  let running = false;

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
    try {
      const list = await candidates();
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
          if (sent > 0) await wait(cfg.gapMs);
          await bot.sendAutomatic(chat, overdueText(loan), 'overdue');
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
            console.warn('WhatsApp: aviso de atraso adiado (' + error.code + ').');
            break;
          }
          // Sem WhatsApp, sem endereco, ou envio sem resposta a tempo (pode ter
          // saido): fica marcado, sem nova tentativa para este prazo.
          console.warn('WhatsApp: aviso de atraso não enviado (' + (error?.code || error?.message) + ').');
        }
      }
      if (sent) console.log('WhatsApp: ' + sent + ' aviso(s) de atraso enviado(s).');
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
      first = setTimeout(() => run().catch(() => {}), cfg.firstRunMs);
      first.unref?.();
      timer = setInterval(() => run().catch(() => {}), cfg.everyMs);
      timer.unref?.();
    },
    stop() {
      clearTimeout(first);
      clearInterval(timer);
      timer = null;
    },
  };
}
