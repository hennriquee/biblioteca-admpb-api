import Loan from '../../models/Loan.js';
// import WaChat from '../../models/WaChat.js'; // (so o passo do robo usava: ver o fim de run)
import { addDays, brDate, dayOf, todayInBrazil } from '../brDates.js';
import { resolveChat, saveMessage } from './store.js';
import { digitsOf } from './phone.js';
import WaMessage from '../../models/WaMessage.js';
import { between, defaultRng, leastSimilar, pick } from './humanize.js';
import { brazilHour, computeHealth, contactOf, readPolicyConfig, templateOf } from './policy.js';

/**
 * DESLIGADO EM 13/11/2026 - este arquivo nao e mais usado (server.js nao o
 * importa) e, mesmo que fosse, o servico do WhatsApp recusa todo envio que
 * nao venha do painel. O WhatsApp da biblioteca nao manda NENHUMA mensagem
 * sozinho; a cobranca de atraso e um administrador escrevendo em Conversas.
 * Fica aqui so como historico.
 *
 * (Como era:) A UNICA MENSAGEM AUTOMATICA do WhatsApp da biblioteca (desde 12/11/2026).
 *
 * Passou 1 dia da data de devolucao (o livro esta atrasado): a pessoa recebe
 * UMA mensagem dizendo para procurar um dos membros da biblioteca para
 * devolver - e, daquele emprestimo, nunca mais nada sai sozinho (nem se o
 * prazo for estendido e vencer de novo). O registro fica no emprestimo
 * (overdueAutoAt = quando o aviso saiu). Todo o resto do WhatsApp e pelo
 * painel (Conversas), por um administrador.
 *
 * A mensagem NAO oferece opcoes ("1 - falar com administrador", "0 - menu",
 * "responda parar"): nao existe mais robo para responder a elas. Se a pessoa
 * responder, a resposta aparece em Conversas.
 *
 * Cuidados com o numero da biblioteca (envio automatico e o que faz o
 * WhatsApp bloquear), mantidos:
 * - so atrasos RECENTES (ate maxLateDays): ao publicar, os atrasos antigos
 *   nao recebem uma rajada de mensagens;
 * - so em horario comercial de Brasilia, poucos por rodada e com intervalo;
 * - nao avisa se um administrador ja cobrou depois do vencimento;
 * - so para quem JA ESCREVEU para o numero (contato com opt-in, policy.js);
 *   quem nunca escreveu fica para a cobranca manual do painel.
 *   WHATSAPP_OVERDUE_COLD=true desfaz isso (nao recomendado);
 * - quem pediu "parar" ao antigo robo continua sem receber;
 * - texto com variacao, escolhido para NAO parecer com os avisos do dia;
 * - pausa sozinho com sinais de denuncia e quando a conta e restringida.
 * Nao mexe na "cobranca" manual (uma a cada 30 dias, services/charges.js).
 */

const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);

// Quem aparece como remetente no painel.
const SENDER_NAME = 'Aviso automático';

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

// As partes do aviso, cada uma com formas equivalentes (o sentido nunca muda).
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
// O pedido: procurar um dos membros da biblioteca para devolver.
const ASKS = [
  'Por favor, procure um dos membros da biblioteca para fazer a devolução.',
  'Pedimos que procure um dos membros da equipe da biblioteca para devolvê-lo.',
  'Quando puder, procure um dos membros da biblioteca para fazer a devolução.',
  'Para devolver, é só procurar um dos membros da biblioteca.',
  'Assim que possível, procure um dos membros da biblioteca para devolver o livro.',
];
const EXTRAS = ['', '', 'Muito obrigado! 🙏', 'Obrigado pela compreensão.', 'Outras pessoas também querem ler. 📚'];

// ---- Do aviso antigo (com o robo), desligado em 12/11/2026 ----
// O aviso oferecia opcoes que o robo respondia e a saida "responda parar".
// Sem robo, ninguem responderia a elas.
// const ASKS_OLD = [
//   'Pedimos que faça a devolução o quanto antes.',
//   'Você consegue devolvê-lo assim que possível?',
//   'Quando puder, por favor, faça a devolução.',
//   'Se puder devolver nos próximos dias, agradecemos muito.',
//   'Assim que possível, traga o livro de volta, por favor.',
// ];
// const OPTION_INTROS = ['', '', 'Se quiser, responda:', 'Pode responder por aqui:'];
// const OPTION_ADMIN = ['1️⃣ Falar com um administrador', '1️⃣ Falar com um administrador da biblioteca'];
// const OPTION_MENU = ['0️⃣ Ver o menu de atendimento', '0️⃣ Ver as outras opções do atendimento'];
// const OPT_OUT_HINTS = [
//   'Se preferir não receber avisos por aqui, é só responder *parar*.',
//   'Não quer receber estes avisos pelo WhatsApp? Responda *parar*.',
//   'Para não receber mais avisos por este número, responda *parar*.',
// ];

/** O aviso de atraso, com variacao (rng escolhe as formas). */
export function overdueText(loan, rng = defaultRng) {
  const name = firstName(loan.personName);
  const title = '*' + String(loan.bookTitle || '').replace(/[*_~`]/g, '').trim() + '*';
  const fill = (text) =>
    text
      .replace('{name}', name ? ', ' + name : '')
      .replace('{title}', title)
      .replace('{date}', brDate(dayOf(loan.dueDate)));
  const extra = pick(EXTRAS, rng);
  return (
    fill(pick(OPENINGS, rng)) +
    '\n\n' +
    fill(pick(BODIES, rng)) +
    ' ' +
    pick(ASKS, rng) +
    (extra ? ' ' + extra : '')
  );
  // (antes: + as opcoes 1/0 do robo e, as vezes, a linha do "responda parar")
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
  let running = false;
  // Atrasos de quem nunca escreveu ja contados no log (um aviso no log por
  // emprestimo, e nao a cada rodada).
  const coldSeen = new Set();

  async function candidates() {
    const today = todayInBrazil();
    const oldest = addDays(today, -(cfg.maxLateDays + 1));
    const loans = await Loan.find({
      status: 'ativo',
      personPhone: { $nin: ['', null] },
      // UM aviso por emprestimo: quem ja recebeu (por qualquer prazo) nao
      // recebe mais nada.
      overdueAutoAt: null,
      dueDate: { $gte: new Date(oldest + 'T00:00:00Z'), $lt: new Date(today + 'T23:59:59Z') },
    })
      .sort({ dueDate: 1 })
      .limit(200)
      .lean();
    return loans.filter((loan) => {
      const due = dayOf(loan.dueDate);
      // Venceu ONTEM ou antes: 1 dia de atraso.
      if (!due || !(today > due)) return false;
      if (due < addDays(today, -cfg.maxLateDays)) return false;
      // (antes: um aviso por PRAZO - estendido e vencido de novo, saia outro)
      // const done = loan.overdueAutoFor && new Date(loan.overdueAutoFor).getTime() === new Date(loan.dueDate).getTime();
      // return !done;
      return true;
    });
  }

  async function release(loan) {
    await Loan.updateOne(
      { _id: loan._id, overdueAutoFor: loan.dueDate },
      { $set: { overdueAutoFor: loan.overdueAutoFor ?? null, overdueAutoAt: loan.overdueAutoAt ?? null } }
    );
  }

  // Envia e grava no painel (Conversas mostra "Aviso automático").
  async function send(chat, text) {
    const sent = await whatsapp.sendText(chat, text, { auto: 'overdue', typing: 'proactive' });
    try {
      await saveMessage(chat, {
        waId: sent.waId,
        fromMe: true,
        kind: 'text',
        text,
        at: sent.at,
        status: 2,
        auto: 'overdue',
        sentByName: SENDER_NAME,
      });
    } catch (error) {
      // Ja saiu: o eco do WhatsApp grava a mensagem de qualquer jeito.
      console.error('WhatsApp: aviso de atraso enviado, mas não gravado agora:', error.message);
    }
    return sent;
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

        // Um administrador ja cobrou depois do vencimento: nao repete (e
        // marca o emprestimo como avisado: nada mais sai dele).
        const alreadyCharged =
          loan.overdueSentAt && new Date(loan.overdueSentAt) >= new Date(loan.dueDate);

        const chat = alreadyCharged ? null : await resolveChat({ phone: loan.personPhone });
        if (!alreadyCharged && !chat) continue;
        // ---- Do robo, desligado em 12/11/2026 (os campos sairam do banco) ----
        // if (chat?.mode === 'human' && chat.humanUntil && new Date(chat.humanUntil).getTime() > now()) continue;
        // if (chat?.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now()) continue;

        // Lista fria: quem nunca escreveu para o numero nao recebe aviso
        // automatico (e o que mais leva a Meta a bloquear). Fica sem marcar:
        // se a pessoa escrever, o aviso sai numa rodada seguinte.
        const contact = chat ? await contactOf(chat) : { inbound: false };
        // Pediu para parar de receber avisos (ao antigo robo): nunca mais.
        if (chat && contact.optOut) continue;
        if (chat && !policy.allowCold && !contact.inbound) {
          const key = String(loan._id);
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
            overdueAutoAt: null,
          },
          { $set: { overdueAutoFor: loan.dueDate, overdueAutoAt: new Date(now()) } },
          { new: true }
        );
        if (!claimed || alreadyCharged) continue;

        try {
          if (sent > 0) await wait(span(cfg.gapMs));
          // Entre varias formas, a menos parecida com os avisos do dia.
          // (compara o MOLDE, como o fiscal: nome, livro e data nao contam)
          const { text } = leastSimilar((r) => overdueText(loan, r), recent, { rng, key: templateOf });
          await send(chat, text);
          recent.push(text);
          // ---- Do robo, desligado em 12/11/2026 ----
          // Antes, a conversa ia para o passo "blocked" do robo, para a resposta
          // "1"/"0" da pessoa cair no atendimento automatico. Agora nada mais
          // sai: a resposta, se vier, fica em Conversas para um administrador.
          // await WaChat.updateOne({ _id: chat._id, ... }, { $set: { mode: 'bot', botStep: 'blocked', ... } });
          sent += 1;
        } catch (error) {
          if (RETRY_LATER.has(error?.code)) {
            await release(loan).catch(() => {});
            console.warn('WhatsApp: aviso de atraso adiado (' + error.code + (error.rules ? ': ' + error.rules.join(', ') : '') + ').');
            break;
          }
          // Sem WhatsApp, sem endereco, ou envio sem resposta a tempo (pode ter
          // saido): fica marcado, sem nova tentativa.
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
      clearTimeout(timer);
      timer = null;
    },
  };
}
