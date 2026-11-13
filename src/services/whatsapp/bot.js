// ==========================================================================
// ATENDIMENTO AUTOMATICO (ROBO) DO WHATSAPP - DESLIGADO EM 12/11/2026.
//
// O numero da biblioteca nao responde mais nada sozinho: as conversas sao so
// de dentro do painel (Conversas), por um administrador. A unica mensagem
// automatica que sobrou e o aviso de 1 dia de atraso (overdue.js).
// O arquivo inteiro esta COMENTADO e nada o importa. O que ainda servia sem
// robo foi para requestLink.js (o link da solicitacao e o canal do
// "Combinar"). Os dados dele sairam do banco (ver prepareDatabase em
// server.js): respostas cadastradas, perguntas sem resposta e o estado do
// menu em cada conversa.
// ==========================================================================
//
// import { parsePhoneNumberFromString } from 'libphonenumber-js';
// import Book from '../../models/Book.js';
// import Loan from '../../models/Loan.js';
// import LoanRequest from '../../models/LoanRequest.js';
// import Person from '../../models/Person.js';
// import ReturnAlert from '../../models/ReturnAlert.js';
// import WaAnswer from '../../models/WaAnswer.js';
// import WaChat from '../../models/WaChat.js';
// import WaUnknown from '../../models/WaUnknown.js';
// import { normalizeText } from '../../models/Book.js';
// import { occupiedCount } from '../occupancy.js';
// import { allWordsRegex, matchRank, searchWords } from '../search.js';
// import { addDays, brDate, dayOf, todayInBrazil } from '../brDates.js';
// import { phoneVariants, samePhone, digitsOf } from './phone.js';
// import { resolveChat, saveMessage } from './store.js';
// import { whatsapp as defaultWhatsapp } from './service.js';
// import { between, defaultRng, pick, phrase, PHRASES, readingMs, thinkingMs } from './humanize.js';
// import { classify, detectStop, fold, sameWord, tokensOf, wordScore } from './intents.js';
// import { brazilHour, setOptOut } from './policy.js';
//
// /**
//  * ATENDIMENTO AUTOMATICO do WhatsApp da biblioteca.
//  *
//  * Quem escreve para o numero da biblioteca recebe um menu numerado (o WhatsApp
//  * nao mostra botoes nem listas para contas comuns conectadas como aparelho:
//  * so contas da API oficial do WhatsApp Business. O menu numerado funciona em
//  * qualquer celular):
//  *
//  *   1 - Conhecer o catalogo          -> o link do acervo publico
//  *   2 - Emprestimos                  -> ver os ativos / estender a devolucao
//  *   3 - Falar com um administrador   -> avisa o administrador pelo WhatsApp
//  *
//  * Regras:
//  * - So conversa com UMA pessoa (grupos, status e canais ja ficam de fora em
//  *   service.js) e so mensagem NOVA e recente (nada do historico).
//  * - Conversa em ATENDIMENTO HUMANO (mode "human"): o robo fica quieto. Entra
//  *   nesse modo quando a pessoa pede um administrador, quando alguem responde
//  *   pelo painel ou pelo celular, ou pelo botao do painel. Volta ao robo pelo
//  *   botao do painel ou sozinho, depois de HUMAN_HOURS sem mensagem da equipe.
//  * - Resposta fora do esperado: "Nao entendi" + as opcoes de novo.
//  * - Freio: no maximo MAX_REPLIES respostas por conversa a cada 10 minutos
//  *   (evita conversa sem fim com outro robo, que poderia bloquear o numero).
//  * - Uma pessoa por vez em cada conversa (fila por conversa).
//  *
//  * COMO GENTE (o que faz o atendimento nao parecer maquina):
//  * - RAJADA: quem manda "Oi" / "boa tarde" / "queria renovar meu livro" em
//  *   tres mensagens recebe UMA resposta, para o conjunto. O robo demora um
//  *   instante para "ver" a mensagem, espera a pessoa parar de digitar (o
//  *   "digitando…" dela) e so entao le tudo e responde.
//  * - TEXTO LIVRE (intents.js): alem do numero da opcao, entende o pedido
//  *   escrito ("quero renovar", "tem o livro X?", "que horas abre?" com as
//  *   respostas cadastradas no painel), agradecimento e "ok" (que NAO puxam o
//  *   menu de novo) e erro de digitacao.
//  * - Dois "nao entendi" seguidos: oferece um administrador em vez de repetir.
//  * - Audio, foto, documento: avisa que so le texto e oferece um administrador.
//  * - "Parar": a pessoa deixa de receber os avisos puxados pelo numero.
//  * - Perguntaram se e um robo: diz a verdade (e oferece uma pessoa).
//  */
//
// export const BOT_NAME = 'Atendimento automático';
// const EXTENSION_BY_NAME = 'WhatsApp (pedido do leitor)';
//
// const FALSY = new Set(['false', '0', 'no', 'off', 'nao', 'não']);
//
// // O WhatsApp BRASILEIRO da biblioteca: para onde ia o "Combinar" do acervo
// // publico antes do robo (modelo antigo, guardado como reserva: ver
// // requestChannel abaixo) e quem recebe hoje o aviso de pedido de emprestimo.
// export const LEGACY_REQUESTS_WHATSAPP = '5534984241556';
//
// export function readBotConfig(env = process.env) {
//   const site =
//     String(env.PUBLIC_SITE_URL || '').trim() ||
//     String(env.CORS_ORIGIN || '')
//       .split(',')
//       .map((origin) => origin.trim())
//       .find((origin) => origin.startsWith('https://')) ||
//     '';
//   const days = Number(env.WHATSAPP_BOT_EXTENSION_DAYS);
//   const max = Number(env.WHATSAPP_BOT_MAX_EXTENSIONS);
//   return {
//     enabled: !FALSY.has(String(env.WHATSAPP_BOT_ENABLED ?? '').trim().toLowerCase()),
//     // Bruno Henrique: recebe o aviso de "quer falar com um administrador".
//     adminPhone: digitsOf(env.WHATSAPP_ADMIN_NUMBER || '5534996560351'),
//     // Recebe o aviso de PEDIDO DE EMPRESTIMO (o "Combinar" do acervo publico):
//     // o WhatsApp brasileiro que recebia essas mensagens antes do robo.
//     requestsAdminPhone: digitsOf(env.WHATSAPP_REQUESTS_ADMIN_NUMBER || LEGACY_REQUESTS_WHATSAPP),
//     // Antes de cada resposta: "le" a mensagem (confirmacao de leitura), pensa
//     // um instante e mostra o "digitando…" proporcional ao texto (~30 a 55 ms
//     // por letra, com variacao: humanize.js). WHATSAPP_BOT_TYPING=false tira.
//     typing: !FALSY.has(String(env.WHATSAPP_BOT_TYPING ?? '').trim().toLowerCase()),
//     // "online": fica online so durante a resposta (ver #typeOut em service.js).
//     typingOnline: String(env.WHATSAPP_BOT_TYPING ?? '').trim().toLowerCase() === 'online',
//     // Marca como lida a mensagem respondida (uma pessoa le antes de
//     // responder). WHATSAPP_BOT_READ=false tira.
//     readReceipts: !FALSY.has(String(env.WHATSAPP_BOT_READ ?? '').trim().toLowerCase()),
//     // Freio dos avisos de pedido de emprestimo: por conversa, em 24 h.
//     maxRequestNoticesPerDay: 8,
//     siteUrl: site.replace(/\/+$/, ''),
//     // Quantos dias cada extensao pelo WhatsApp acrescenta a devolucao.
//     extensionDays: Number.isInteger(days) && days > 0 && days <= 60 ? days : 7,
//     // Quantas vezes a propria pessoa pode estender o mesmo emprestimo.
//     maxExtensions: Number.isInteger(max) && max >= 0 && max <= 10 ? max : 2,
//     // Sem resposta por este tempo, a proxima mensagem recomeca do "Ola".
//     sessionMs: 30 * 60 * 1000,
//     // Mensagem mais velha que isto (chegou com o servidor fora do ar) nao
//     // recebe resposta automatica: ficaria fora de contexto.
//     maxAgeMs: 6 * 60 * 60 * 1000,
//     // Pedido de emprestimo atrasado ainda avisa o administrador ate isto.
//     maxRequestAgeMs: 7 * 24 * 60 * 60 * 1000,
//     humanMs: 12 * 60 * 60 * 1000,
//     // Pedido de administrador sem resposta: o robo volta depois disto.
//     handoffMs: 24 * 60 * 60 * 1000,
//     windowMs: 10 * 60 * 1000,
//     maxReplies: 15,
//     // E no maximo isto em 24 h por conversa (gente de verdade nem chega perto).
//     maxRepliesPerDay: 40,
//     // Resposta fora das opcoes ate este tempo depois do robo: e rajada (a
//     // pessoa ainda nao leu), fica sem "Nao entendi".
//     burstMs: 10 * 1000,
//     // Passou do freio: o robo fica mudo nessa conversa por este tempo.
//     muteMs: 12 * 60 * 60 * 1000,
//     // Quanto demora para "ver" que chegou mensagem (ninguem abre a conversa
//     // no mesmo instante).
//     noticeMs: [800, 3000],
//     // RAJADA: so responde depois deste silencio da pessoa (sorteado) e de ela
//     // parar de digitar; no maximo settleMaxMs de espera.
//     settleMs: [1200, 2800],
//     settleStepMs: 400,
//     settleMaxMs: 12 * 1000,
//     // Depois de responder a um "obrigado", outro "obrigado"/"ok" dentro deste
//     // tempo fica sem resposta.
//     closedMs: 30 * 60 * 1000,
//     // As respostas cadastradas ficam na memoria por este tempo.
//     answersTtlMs: 60 * 1000,
//     // O acervo em memoria para a busca aproximada de livros (com erro de
//     // digitacao): por quanto tempo e ate quantos livros.
//     catalogTtlMs: 5 * 60 * 1000,
//     catalogMax: 5000,
//     // A mesma mensagem recebida de novo dentro deste tempo fica sem resposta.
//     repeatMs: 6 * 60 * 60 * 1000,
//     // ...a partir da vez numero tal (1 = a primeira): a terceira igual seguida.
//     repeatSilentFrom: 3,
//     // Entendimento de texto livre (intents.js). WHATSAPP_BOT_SMART=false
//     // volta ao menu so por numero.
//     smart: !FALSY.has(String(env.WHATSAPP_BOT_SMART ?? '').trim().toLowerCase()),
//   };
// }
//
// // ---------- Textos ----------
//
// // O numero da opcao como emoji (1️⃣, 2️⃣, 0️⃣...): digito + "️" + "⃣".
// // Quem responde tocando no emoji tambem e entendido (ver KEYCAP).
// export function key(n) {
//   return String(n) + '️⃣';
// }
//
// const MAIN_OPTIONS = [
//   key(1) + ' Conhecer o catálogo',
//   key(2) + ' Empréstimos',
//   key(3) + ' Falar com um administrador',
// ].join('\n');
//
// const BACK = key(0) + ' Voltar ao menu';
// const CONFIRM_OPTIONS = key(1) + ' Confirmar\n' + key(0) + ' Cancelar';
// // O passo 'blocked' que PERGUNTOU "quer falar com um administrador?" (o aviso
// // de atraso tambem deixa a conversa em 'blocked', mas la "sim" e "vou
// // devolver", nao pedido de administrador).
// const ASK_ADMIN = { ask: 'admin' };
// const STOP_OPTIONS = key(1) + ' Sim, não quero mais receber avisos\n' + key(0) + ' Não, pode continuar';
//
// // As frases variam a cada mensagem (humanize.js › PHRASES): o mesmo sentido,
// // nunca o mesmo texto para todo mundo. As opcoes numeradas nao mudam.
// // hi: o cumprimento ("Olá", "Bom dia"...); name: ", Maria" ou "".
// // mirrored: a pessoa cumprimentou com "bom dia"/"boa tarde": a saudacao que
// // sai e uma das que devolvem o cumprimento.
// function mainMenu({ greet = false, hi = 'Olá', name = '', mirrored = false } = {}, rng = defaultRng) {
//   const greeting = () => {
//     const forms = mirrored ? PHRASES.greeting.filter((form) => form.includes('{hi}')) : PHRASES.greeting;
//     return pick(forms, rng).replace('{hi}', hi).replace('{name}', name);
//   };
//   return (
//     (greet ? greeting() : phrase('howCanIHelp', {}, rng)) +
//     '\n\n' +
//     MAIN_OPTIONS +
//     '\n\n' +
//     phrase('replyHint', {}, rng)
//   );
// }
//
// function timeHello(hour) {
//   if (hour >= 5 && hour < 12) return 'Bom dia';
//   if (hour >= 12 && hour < 18) return 'Boa tarde';
//   return 'Boa noite';
// }
//
// // "o primeiro", "a segunda"... na escolha de um item de lista.
// const ORDINALS = ['primeir', 'segund', 'terceir', 'quart', 'quint', 'sext', 'setim', 'oitav', 'non'];
//
// // Palavras que nao ajudam a achar um livro.
// const BOOK_STOP = new Set('o a os as um uma de do da dos das e em no na livro livros obra obras exemplar autor autora'.split(' '));
//
// // (o titulo varia: PHRASES.loansTitle)
// const LOANS_OPTIONS =
//   key(1) +
//   ' Ver meus empréstimos ativos\n' +
//   key(2) +
//   ' Estender a data de devolução\n' +
//   BACK;
//
// const HANDOFF_OPTIONS = key(1) + ' Falar com um administrador\n' + BACK;
//
// function bold(text) {
//   // O titulo vai entre asteriscos (negrito no WhatsApp): tira os asteriscos
//   // dele para nao quebrar a formatacao.
//   return '*' + String(text || '').replace(/[*_~`]/g, '').trim() + '*';
// }
//
// function firstName(name) {
//   return String(name || '').trim().split(/\s+/)[0] || '';
// }
//
// function prettyPhone(value) {
//   // O WhatsApp guarda alguns celulares brasileiros sem o 9 (553496560351):
//   // para mostrar, usa a forma com o 9, que e a que as pessoas reconhecem.
//   const digits =
//     phoneVariants(value).find((v) => /^55\d{2}9\d{8}$/.test(v)) || digitsOf(value);
//   const parsed = digits ? parsePhoneNumberFromString('+' + digits) : null;
//   return parsed ? parsed.formatInternational() : digits ? '+' + digits : '';
// }
//
// // ---------- Entrada ----------
//
// const KEYCAP = /([0-9])️?⃣/g;
//
// function normalizeInput(text) {
//   return String(text || '')
//     .replace(KEYCAP, '$1')
//     .normalize('NFD')
//     .replace(/[̀-ͯ]/g, '')
//     .toLowerCase()
//     .replace(/\s+/g, ' ')
//     .trim();
// }
//
// /**
//  * O que a pessoa escolheu: { digit } para um numero ("2", "2.", "opção 2",
//  * "2️⃣"), { word } para "menu"/"voltar", ou {} (nao e uma opcao).
//  */
// export function parseChoice(text) {
//   const value = normalizeInput(text);
//   if (!value || value.length > 30) return {};
//   const digit = value.match(/^(?:opcao|opc|op|numero|n)?\s*[#(]?\s*(\d{1,2})\s*[).:-]?\s*[.!]?$/);
//   if (digit) return { digit: Number(digit[1]) };
//   // A linha da opcao copiada inteira ("0️⃣ Voltar ao menu", "2️⃣ Estender a
//   // data de devolução"): vale o numero do comeco.
//   const line = value.match(
//     /^(\d)\s*[-–.)]?\s*(conhecer|emprestimos|falar|ver|estender|voltar|confirmar|cancelar)\b/
//   );
//   if (line) return { digit: Number(line[1]) };
//   const word = value.replace(/[^a-z ]/g, '').trim();
//   if (['menu', 'inicio', 'menu principal', 'voltar', 'comecar', 'recomecar'].includes(word)) {
//     return { word: 'menu' };
//   }
//   return {};
// }
//
// function words(text) {
//   return normalizeInput(text).replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// }
//
// // Na confirmacao, "sim"/"nao" (e frases que comecam assim: "Sim, por favor",
// // "pode sim", "não, obrigado") valem como 1/0.
// function confirmWord(step, text, kind, data = null) {
//   if (kind !== 'text') return undefined;
//   // "Quer parar de receber os avisos?": o texto da opcao 0 ("Nao, pode
//   // continuar") e "quero continuar recebendo" NAO podem confirmar o parar.
//   if (step === 'confirm-stop') {
//     const value = words(text);
//     // ("pode mandar", "quero receber", "pode continuar": e o contrario)
//     const stopWord = /\b(parar|pare|parem|para de)\b/.test(value);
//     if (/\b(continu\w*|receb\w*|mand\w*|envi\w*)\b/.test(value) && !stopWord) return 0;
//     if (/^(nao|n)\b/.test(value)) return 0;
//     if (/^(sim|s|isso|confirmo|pode parar|quero parar|parar|pare|parem|sim parar|ok parar)$/.test(value)) return 1;
//     if (/^(sim|s|isso)\b/.test(value) && value.split(' ').length <= 3) return 1;
//     return undefined;
//   }
//   // "Quer falar com um administrador?" (1 sim / 0 menu): "sim", "pode
//   // chamar", "por favor" chamam. "ok" e "pode deixar" nao (resposta comum ao
//   // aviso de atraso, que tambem para neste passo).
//   if (step === 'blocked') {
//     if (data?.ask !== 'admin') return undefined;
//     const value = words(text);
//     if (!value || value.split(' ').length > 5 || /\b(pode deixar|nao precisa)\b/.test(value)) return undefined;
//     if (/^(sim|s|claro|isso|quero sim|quero falar|pode chamar|chama|chame|por favor)\b/.test(value)) return 1;
//     return undefined;
//   }
//   if (step !== 'confirm') return undefined;
//   const value = words(text);
//   if (/^(nao|n|cancelar|cancela|cancele)\b/.test(value)) return 0;
//   if (/^(sim|s|confirmo|confirmar|confirma|pode|ok|isso|quero)\b/.test(value)) return 1;
//   return undefined;
// }
//
// // Pedido escrito por extenso no menu principal ("quero renovar meu livro",
// // "falar com um atendente"): vale a opcao se so UMA delas aparece.
// function mainWord(text) {
//   const value = words(text);
//   if (!value || value.length > 120) return 0;
//   const hits = [];
//   if (/\b(catalogo|acervo)\b/.test(value)) hits.push(1);
//   if (/\b(emprestimos?|renovar|renovacao|estender|prorrogar|prazo|devolucao)\b/.test(value)) {
//     hits.push(2);
//   }
//   if (/\b(administrador|atendente|humano|secretaria|responsavel)\b/.test(value)) hits.push(3);
//   return hits.length === 1 ? hits[0] : 0;
// }
//
// // No menu de emprestimos, o pedido por extenso tambem vale.
// function loansWord(text) {
//   const value = words(text);
//   if (!value || value.length > 120) return undefined;
//   const extend = /\b(estender|renovar|renovacao|prorrogar|prazo|mais tempo|mais dias)\b/.test(value);
//   const list = /\b(ver|listar|lista|quais|meus emprestimos)\b/.test(value);
//   if (extend && !list) return 2;
//   if (list && !extend) return 1;
//   return undefined;
// }
//
// // ---------- Pedido de emprestimo do acervo publico ----------
//
// // O link do fim da mensagem: /solicitacao/<id> (o id e o mesmo formato de
// // TOKEN_PATTERN em routes/requests.js).
// export const REQUEST_LINK = /\/solicitacao\/([A-Za-z0-9_-]{16,64})(?![A-Za-z0-9_-])/;
// // O texto pronto (utils/whatsapp.js no front, buildRequestMessage): vale
// // mesmo sem o link (servidor fora do ar na hora do pedido).
// const REQUEST_BOOK = /gostaria de pegar emprestado o livro\s*["“”]([^"“”\n]{1,200})["“”]/i;
// const REQUEST_NAME = /meu nome [eé]\s+(.{2,80}?)\s+(\*?\(novo cadastro\)\*?\s+)?e gostaria de pegar emprestado/i;
//
// // Texto que a PESSOA digitou (nome, titulo, nome do perfil) indo para um
// // aviso mandado pelo numero da biblioteca: o aviso nao pode carregar um link
// // "oficial" de golpe. Em vez de apagar (o que apagaria tambem "Vol.II" ou
// // "Sr.Marcos"), DESARMA: tira "http://", "https://" e "www." e troca o ponto
// // entre letras por "․" (U+2024, parecido, que o WhatsApp nao transforma em
// // link). Antes, a formatacao do WhatsApp e as quebras viram espaco (senao
// // "go_lpe.com" escaparia). Numa linha so.
// export function typedText(value, max = 120) {
//   return String(value || '')
//     .replace(/[*_~`\n\r\t]/g, ' ')
//     .replace(/(?:https?:\/\/|www\.)/gi, ' ')
//     // (os pontos "orientais" tambem: alguns aparelhos os leem como ".")
//     .replace(/([\p{L}\p{N}-])[.。．｡](?=[\p{L}\p{N}-])/gu, '$1․')
//     .replace(/\s+/g, ' ')
//     .trim()
//     .slice(0, max)
//     .trim();
// }
//
// /**
//  * { token, title, name, isNew } se a mensagem e um pedido de emprestimo do
//  * acervo publico (pelo link ou pelo texto pronto), ou null.
//  */
// export function parseRequestMessage(text) {
//   const value = String(text || '');
//   if (!value || value.length > 3000) return null;
//   const link = value.match(REQUEST_LINK);
//   const book = value.match(REQUEST_BOOK);
//   if (!link && !book) return null;
//   const name = value.match(REQUEST_NAME);
//   return {
//     token: link ? link[1] : '',
//     title: book ? book[1].trim() : '',
//     name: name ? name[1].replace(/[*_~`]/g, '').trim() : '',
//     isNew: Boolean(name?.[2]),
//   };
// }
//
// // ---------- O robo ----------
//
// export function createBot({
//   whatsapp,
//   config: overrides = {},
//   now = () => Date.now(),
//   rng = defaultRng,
//   wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
// } = {}) {
//   const cfg = { ...readBotConfig(), ...overrides };
//   // As mensagens que chegaram e ainda nao foram tratadas, por conversa.
//   const inbox = new Map();
//   // O que a pessoa mandou e ainda nao foi "lido" (por conversa): a primeira
//   // resposta le antes (ver reply). lead: o cumprimento que abre essa resposta.
//   const unread = new Map();
//   // Conversas em que ESTA rodada caiu no "nao entendi" (ver miss).
//   const missed = new Set();
//   let stop = null;
//   let answersCache = { at: 0, list: [] };
//
//   const say = (name, values) => phrase(name, values, rng);
//   const backHint = () => say('backHint');
//   const notUnderstood = () => say('notUnderstood');
//
//   // ---------- Fila por conversa, com espera pela rajada ----------
//
//   // Uma fila por conversa. Quem chega enquanto a anterior espera ou e
//   // respondida entra no MESMO lote (ou no seguinte): nunca duas respostas
//   // ao mesmo tempo na mesma conversa.
//   function enqueue(event) {
//     const id = String(event.chat._id);
//     let box = inbox.get(id);
//     if (!box) {
//       box = { items: [], running: false, lastAt: now() };
//       inbox.set(id, box);
//     }
//     return new Promise((resolve, reject) => {
//       box.items.push({ event, resolve, reject });
//       box.lastAt = now();
//       if (!box.running) {
//         box.running = true;
//         drain(id, box);
//       }
//     });
//   }
//
//   async function drain(id, box) {
//     try {
//       while (box.items.length) {
//         const first = box.items[0].event;
//         try {
//           // So espera (e fica "online") se o robo for mesmo responder aqui.
//           if (cfg.typing && (await engaged(first.chat._id))) {
//             await wait(Math.round(between(cfg.noticeMs[0], cfg.noticeMs[1], rng)));
//             // "Abre a conversa": online + o "digitando…" da pessoa passa a chegar.
//             if (typeof whatsapp.attend === 'function') await whatsapp.attend(first.chat).catch(() => {});
//             await settle(box, first.chat);
//           }
//         } catch {
//           /* a espera e so um cuidado: sem ela, responde direto */
//         }
//         const batch = box.items.splice(0);
//         try {
//           const result = await handleBatch(batch.map((item) => item.event));
//           batch.forEach((item) => item.resolve(result));
//         } catch (error) {
//           batch.forEach((item) => item.reject(error));
//         }
//       }
//     } finally {
//       box.running = false;
//       if (!box.items.length && inbox.get(id) === box) inbox.delete(id);
//     }
//   }
//
//   // O robo responde nesta conversa agora? (em atendimento humano ou
//   // silenciado, nao adianta esperar nem ficar online)
//   async function engaged(chatId) {
//     const fresh = await WaChat.findById(chatId).select('mode humanUntil botMutedUntil').lean();
//     if (!fresh) return false;
//     const t = now();
//     if (fresh.mode === 'human' && fresh.humanUntil && new Date(fresh.humanUntil).getTime() > t) return false;
//     if (fresh.botMutedUntil && new Date(fresh.botMutedUntil).getTime() > t) return false;
//     return true;
//   }
//
//   // Espera a pessoa terminar: um silencio sorteado desde a ultima mensagem
//   // dela e nenhum "digitando…" no ar. Tem teto (ninguem espera para sempre).
//   async function settle(box, chat) {
//     const quiet = between(cfg.settleMs[0], cfg.settleMs[1], rng);
//     let waited = 0;
//     for (;;) {
//       const since = now() - box.lastAt;
//       const typing = typeof whatsapp.isComposing === 'function' && whatsapp.isComposing(chat);
//       if (!typing && since >= quiet) return;
//       if (waited >= cfg.settleMaxMs) return;
//       const step = typing ? cfg.settleStepMs : Math.min(cfg.settleStepMs, Math.max(50, quiet - since));
//       await wait(step);
//       waited += step;
//     }
//   }
//
//   // O lote vira UMA entrada: os textos juntos (para entender o pedido) e a
//   // ultima escolha de numero/menu que apareceu ("oi" + "2" = 2).
//   function merge(events) {
//     const last = events[events.length - 1];
//     const texts = events.filter((e) => e.kind === 'text' && e.text).map((e) => e.text);
//     let choiceText = '';
//     for (let i = events.length - 1; i >= 0; i -= 1) {
//       const e = events[i];
//       if (e.kind !== 'text') continue;
//       const choice = parseChoice(e.text);
//       if (choice.digit !== undefined || choice.word) {
//         choiceText = e.text;
//         break;
//       }
//     }
//     return {
//       chat: last.chat,
//       message: last.message,
//       kind: texts.length ? 'text' : last.kind,
//       text: texts.join('\n'),
//       choiceText,
//       parts: texts,
//     };
//   }
//
//   async function handleBatch(events) {
//     if (!cfg.enabled || !whatsapp.isOpen()) return undefined;
//     // O pedido pronto do acervo publico e tratado mensagem a mensagem (cada
//     // um tem o seu link e o seu aviso ao administrador).
//     const isRequest = (e) => e.kind === 'text' && Boolean(parseRequestMessage(e.text));
//     if (events.length === 1 || !events.some(isRequest)) {
//       return events.length === 1 ? handleOne(events[0], events) : handleOne(merge(events), events);
//     }
//     // ("Oi" / "ok" soltos junto do pedido nao geram uma resposta a mais: a
//     // confirmacao do pedido ja cumprimenta)
//     const kept = events.filter((e) => isRequest(e) || !(e.kind === 'text' && classify(e.text).kind === 'social'));
//     let result;
//     for (const event of kept) result = await handleOne(event, kept.length === 1 ? events : [event]);
//     return result;
//   }
//
//   async function handleOne(event, events) {
//     const id = String(event.chat._id);
//     // A primeira resposta "le" antes (readFirst) TUDO o que chegou no lote.
//     // Mensagem que o robo nao responde fica sem a confirmacao de leitura
//     // (quem le e a equipe, pelo painel).
//     unread.set(id, {
//       waIds: events.map((e) => e.message?.waId).filter(Boolean),
//       text: event.text || '',
//       lead: '',
//     });
//     try {
//       return await handleCore(event);
//     } finally {
//       unread.delete(id);
//       // Entendeu alguma coisa nesta rodada: a contagem de "nao entendi" zera.
//       if (!missed.delete(id)) {
//         await WaChat.updateOne({ _id: event.chat._id, botMisses: { $gt: 0 } }, { $set: { botMisses: 0 } }).catch(() => {});
//       }
//     }
//   }
//
//   /** Envia e grava uma mensagem do proprio sistema. */
//   // typing: "reply" (resposta) ou "proactive" (aviso puxado pelo numero).
//   // guard: conferido na vez do envio e depois do "digitando…" (service.js).
//   async function sendAutomatic(chat, text, auto = 'bot', { typing = 'reply', guard = null } = {}) {
//     const sent = await whatsapp.sendText(chat, text, {
//       auto,
//       typing: cfg.typing ? typing : null,
//       online: cfg.typingOnline,
//       ...(guard ? { guard } : {}),
//     });
//     try {
//       await saveMessage(chat, {
//         waId: sent.waId,
//         fromMe: true,
//         kind: 'text',
//         text,
//         at: sent.at,
//         status: 2,
//         auto,
//         sentByName: BOT_NAME,
//       });
//     } catch (error) {
//       // Ja saiu: o eco do WhatsApp grava a mensagem de qualquer jeito.
//       console.error('WhatsApp: resposta automática enviada, mas não gravada agora:', error.message);
//     }
//     return sent;
//   }
//
//   async function setStep(chat, step, data = null) {
//     await WaChat.updateOne(
//       { _id: chat._id },
//       { $set: { botStep: step, botData: data, botAt: new Date(now()) } }
//     );
//   }
//
//   // Freio: no maximo maxReplies respostas em 10 minutos e maxRepliesPerDay em
//   // 24 h por conversa (um robo do outro lado que insiste devagar, uma vez por
//   // minuto, nunca estoura a janela de 10 minutos, mas estoura a do dia).
//   // So conta o que SAIU (envio que falhou nao gasta a cota). As respostas de
//   // uma conversa sao uma de cada vez (fila), entao conferir e depois contar
//   // nao corre.
//   async function canReply(chat) {
//     const fresh = await WaChat.findById(chat._id)
//       .select('botWindowAt botWindowCount botDayAt botDayCount')
//       .lean();
//     if (!fresh) return false;
//     const t = now();
//     const inWindow = fresh.botWindowAt && t - new Date(fresh.botWindowAt).getTime() < cfg.windowMs;
//     const inDay = fresh.botDayAt && t - new Date(fresh.botDayAt).getTime() < 24 * 60 * 60 * 1000;
//     const full =
//       (inWindow && fresh.botWindowCount >= cfg.maxReplies) ||
//       (inDay && fresh.botDayCount >= cfg.maxRepliesPerDay);
//     if (!full) return true;
//     // Passou do freio: provavelmente outro robo do outro lado. O robo fica
//     // MUDO nesta conversa por horas (senao voltaria a cada 10 minutos e uma
//     // conversa so gastaria o teto diario de todo mundo). O painel mostra
//     // "silenciado", e "Devolver ao atendimento automatico" religa.
//     await WaChat.updateOne(
//       { _id: chat._id },
//       { $set: { botMutedUntil: new Date(t + cfg.muteMs) } }
//     );
//     return false;
//   }
//
//   async function countReply(chat) {
//     const t = new Date(now());
//     const windowStart = new Date(now() - cfg.windowMs);
//     const dayStart = new Date(now() - 24 * 60 * 60 * 1000);
//     await WaChat.updateOne({ _id: chat._id }, [
//       {
//         $set: {
//           botWindowCount: {
//             $cond: [{ $gt: [{ $ifNull: ['$botWindowAt', new Date(0)] }, windowStart] }, { $add: [{ $ifNull: ['$botWindowCount', 0] }, 1] }, 1],
//           },
//           botWindowAt: {
//             $cond: [{ $gt: [{ $ifNull: ['$botWindowAt', new Date(0)] }, windowStart] }, '$botWindowAt', t],
//           },
//           botDayCount: {
//             $cond: [{ $gt: [{ $ifNull: ['$botDayAt', new Date(0)] }, dayStart] }, { $add: [{ $ifNull: ['$botDayCount', 0] }, 1] }, 1],
//           },
//           botDayAt: {
//             $cond: [{ $gt: [{ $ifNull: ['$botDayAt', new Date(0)] }, dayStart] }, '$botDayAt', t],
//           },
//         },
//       },
//     ]);
//   }
//
//   // Como uma pessoa: le a mensagem (tempo proporcional ao que ela escreveu),
//   // marca como lida e pensa um instante. So na primeira resposta a cada
//   // mensagem recebida.
//   async function readFirst(chat) {
//     const pending = unread.get(String(chat._id));
//     if (!pending || pending.read) return;
//     pending.read = true;
//     if (!cfg.typing && !cfg.readReceipts) return;
//     await wait(readingMs(pending.text, rng));
//     // (quem abre a conversa le TUDO o que chegou, nao so a ultima)
//     if (cfg.readReceipts && pending.waIds.length && typeof whatsapp.sendReadReceipts === 'function') {
//       await whatsapp.sendReadReceipts(chat, pending.waIds).catch(() => {});
//     }
//     await wait(thinkingMs(rng));
//   }
//
//   // A conversa ainda e do robo? Nao, se um administrador assumiu (atendimento
//   // humano em vigor SEM pedido esperando: o proprio robo, ao passar para um
//   // administrador, marca handoffAt e ainda confirma para a pessoa) ou se o
//   // robo foi silenciado.
//   async function stillMine(chatId, { strict = false } = {}) {
//     const fresh = await WaChat.findById(chatId).select('mode humanUntil handoffAt botMutedUntil').lean();
//     if (!fresh) return false;
//     const t = now();
//     // A pessoa acabou de pedir um administrador (ou mandou um pedido): a
//     // confirmacao sai mesmo com o robo silenciado (e UMA mensagem, e quem
//     // pediu precisa saber que foi ouvido). Um administrador que assume zera
//     // o handoffAt, e ai nada sai.
//     const recentHandoff = fresh.handoffAt && t - new Date(fresh.handoffAt).getTime() < 10 * 60 * 1000;
//     if (!strict && recentHandoff) return true;
//     if (fresh.botMutedUntil && new Date(fresh.botMutedUntil).getTime() > t) return false;
//     const human = fresh.mode === 'human' && fresh.humanUntil && new Date(fresh.humanUntil).getTime() > t;
//     if (human && (strict || !fresh.handoffAt)) return false;
//     return true;
//   }
//
//   async function reply(chat, text) {
//     if (!(await canReply(chat))) {
//       console.warn('WhatsApp: atendimento automático silenciado numa conversa (muitas mensagens seguidas).');
//       return false;
//     }
//     // O cumprimento da rodada abre a PRIMEIRA resposta dela (so uma vez).
//     const pending = unread.get(String(chat._id));
//     if (pending?.lead) {
//       text = pending.lead + '\n\n' + text;
//       pending.lead = '';
//     }
//     await readFirst(chat);
//     // (leu por alguns segundos: se um administrador assumiu nesse meio tempo,
//     // a resposta nao sai)
//     if (!(await stillMine(chat._id))) return false;
//     // O "digitando…" (proporcional ao texto) e o envio ficam no servico. A
//     // resposta agora leva segundos: se nesse meio tempo um administrador
//     // assumiu a conversa (respondeu pelo painel/celular) ou o robo foi
//     // silenciado, ela NAO sai.
//     try {
//       await sendAutomatic(chat, text, 'bot', { guard: () => stillMine(chat._id) });
//     } catch (error) {
//       if (error?.code === 'SUPERSEDED') return false;
//       throw error;
//     }
//     // O passo conta a partir de quando a resposta CHEGOU (nao de quando foi
//     // decidida): a rajada de 10 s mede o que a pessoa mandou antes de ler.
//     await WaChat.updateOne(
//       { _id: chat._id, mode: 'bot', botStep: { $nin: ['', null] } },
//       { $set: { botAt: new Date(now()) } }
//     ).catch(() => {});
//     await countReply(chat);
//     return true;
//   }
//
//   // ---------- Emprestimos da pessoa ----------
//
//   async function peopleOf(chat) {
//     const variants = phoneVariants(chat.phone);
//     if (!variants.length) return [];
//     return Person.find({ phone: { $in: variants } }).select('_id fullName').lean();
//   }
//
//   async function activeLoansOf(chat, people) {
//     const variants = phoneVariants(chat.phone);
//     const or = [];
//     if (people.length) or.push({ person: { $in: people.map((p) => p._id) } });
//     if (variants.length) or.push({ personPhone: { $in: variants } });
//     if (!or.length) return [];
//     return Loan.find({ status: 'ativo', $or: or })
//       .sort({ dueDate: 1, startDate: 1 })
//       .limit(20)
//       .lean();
//   }
//
//   function belongsTo(loan, chat, people) {
//     if (!loan || loan.status !== 'ativo') return false;
//     if (samePhone(loan.personPhone, chat.phone)) return true;
//     return people.some((p) => String(p._id) === String(loan.person));
//   }
//
//   async function someoneWaiting(loan) {
//     const [alerts, pending] = await Promise.all([
//       ReturnAlert.countDocuments({ book: loan.book }),
//       LoanRequest.countDocuments({ book: loan.book, status: 'pendente' }),
//     ]);
//     if (!alerts && !pending) return false;
//     const book = await Book.findById(loan.book).select('copies').lean();
//     if (!book) return false;
//     const out = await occupiedCount(loan.book);
//     return (book.copies || 1) - out <= 0;
//   }
//
//   /** Pode estender? { ok, from, to } ou { ok: false, reason }. */
//   async function extensionCheck(loan) {
//     const title = bold(loan.bookTitle);
//     if (!loan.dueDate) {
//       return { ok: false, reason: title + ' não tem data de devolução definida.' };
//     }
//     const today = todayInBrazil();
//     const due = dayOf(loan.dueDate);
//     if (today > due) {
//       return {
//         ok: false,
//         reason:
//           'Não é possível estender ' +
//           title +
//           ' por aqui: o prazo de devolução venceu em ' +
//           brDate(due) +
//           '.',
//       };
//     }
//     const used = (loan.dueExtensions || []).filter((e) => e.via === 'whatsapp').length;
//     if (used >= cfg.maxExtensions) {
//       return {
//         ok: false,
//         reason:
//           'O prazo de ' +
//           title +
//           ' já foi estendido pelo WhatsApp ' +
//           (cfg.maxExtensions === 1 ? 'uma vez, o máximo permitido.' : cfg.maxExtensions + ' vezes, o máximo permitido.'),
//       };
//     }
//     if (await someoneWaiting(loan)) {
//       return {
//         ok: false,
//         reason: 'Não é possível estender ' + title + ': há leitores aguardando este livro.',
//       };
//     }
//     return { ok: true, from: due, to: addDays(due, cfg.extensionDays) };
//   }
//
//   // whose: com o numero em mais de uma ficha (familia), diz de quem e.
//   function loanLine(loan, whose = false) {
//     const due = dayOf(loan.dueDate);
//     const who = whose && loan.personName ? ' (' + firstName(loan.personName) + ')' : '';
//     const head = '• ' + bold(loan.bookTitle) + who;
//     if (!due) return head + ' – sem data de devolução definida';
//     if (todayInBrazil() > due) return head + ' – devolução em atraso desde ' + brDate(due);
//     return head + ' – devolução até ' + brDate(due);
//   }
//
//   function manyOwners(loans) {
//     return new Set(loans.map((l) => String(l.person))).size > 1;
//   }
//
//   // ---------- Passos ----------
//
//   // Como cumprimentar esta pessoa: { hi, name, mirrored }. hello: o "Bom
//   // dia"/"Boa tarde" que ELA usou (devolvido igual). O nome so entra quando o
//   // numero e de UMA ficha do cadastro (numero de familia: nao da para saber).
//   async function helloFor(chat, hello = '') {
//     let name = '';
//     try {
//       const people = await peopleOf(chat);
//       if (people.length === 1) name = firstName(people[0].fullName);
//     } catch {
//       /* sem o nome, cumprimenta do mesmo jeito */
//     }
//     const hi = hello || pick(['Olá', 'Oi', timeHello(brazilHour(new Date(now())))], rng);
//     return { hi, name: name ? ', ' + name : '', mirrored: Boolean(hello) };
//   }
//
//   async function showMain(chat, { greet = false, prefix = '', hello = '' } = {}) {
//     // (o cumprimento curto da rodada nao se soma ao do menu)
//     const pending = unread.get(String(chat._id));
//     if (pending && greet) pending.lead = '';
//     const who = greet ? await helloFor(chat, hello) : {};
//     await setStep(chat, 'menu');
//     await reply(chat, (prefix ? prefix + '\n\n' : '') + mainMenu({ greet, ...who }, rng));
//   }
//
//   // ---------- Texto livre (intents.js) ----------
//
//   // As respostas cadastradas no painel (models/WaAnswer.js), em memoria por
//   // um minuto. Sem banco, segue com as que ja tinha.
//   async function loadAnswers() {
//     if (now() - answersCache.at < cfg.answersTtlMs && answersCache.at) return answersCache.list;
//     try {
//       const list = await WaAnswer.find({ enabled: true }).select('title keywords answers').limit(200).lean();
//       answersCache = { at: now(), list: list.filter((a) => a.keywords?.length && a.answers?.length) };
//     } catch (error) {
//       console.error('WhatsApp: não foi possível ler as respostas cadastradas:', error.message);
//       answersCache = { at: now(), list: answersCache.list };
//     }
//     return answersCache.list;
//   }
//
//   /** O que o robo entenderia desta mensagem (tambem usado pelo teste do painel). */
//   async function understand(text) {
//     if (!cfg.smart) return { id: '', kind: '', score: 0, entry: null, book: '', bookSure: false, hello: '' };
//     return classify(text, { answers: await loadAnswers() });
//   }
//
//   // Guarda a pergunta que caiu no "nao entendi" (o painel mostra as mais
//   // repetidas para alguem cadastrar a resposta). So texto com cara de
//   // pergunta: nada de numero de telefone, link ou e-mail.
//   function noteUnknown(text) {
//     const value = String(text || '').replace(/\s+/g, ' ').trim();
//     if (value.length < 8 || value.length > 160) return;
//     if (/https?:|www\.|@/.test(value)) return;
//     // (numero de telefone, CPF, cartao: com ou sem ponto, traco ou espaco)
//     if (value.replace(/\D/g, '').length >= 8) return;
//     if (/\b(cpf|rg|cnpj|senha|cartao|cartão|pix)\b/i.test(value)) return;
//     const norm = fold(value).slice(0, 120);
//     if (tokensOf(norm).length < 2) return;
//     WaUnknown.estimatedDocumentCount()
//       .then((total) => {
//         const update = { $set: { text: typedText(value, 160), lastAt: new Date(now()) }, $inc: { count: 1 } };
//         // (cheio: so conta as que ja existem, nao cria novas)
//         return WaUnknown.updateOne({ norm }, update, { upsert: total < 300 });
//       })
//       .catch(() => {});
//   }
//
//   // Caiu no "nao entendi". Na primeira vez, repete as opcoes (again); na
//   // segunda SEGUIDA, oferece um administrador em vez de insistir no menu.
//   async function miss(chat, { text = '', kind = 'text' } = {}, again) {
//     missed.add(String(chat._id));
//     if (kind === 'text') noteUnknown(text);
//     const fresh = await WaChat.findOneAndUpdate({ _id: chat._id }, { $inc: { botMisses: 1 } }, { new: true })
//       .select('botMisses')
//       .lean();
//     const misses = fresh?.botMisses || 1;
//     // Do quarto em diante: o robo ja ofereceu um administrador duas vezes;
//     // repetir so geraria conversa de robo com robo. Fica quieto ate entender
//     // alguma coisa (ou a conversa esfriar).
//     if (misses >= 4) return undefined;
//     // Terceiro: so uma linha curta lembrando o "1" (sem o menu inteiro).
//     if (misses === 3) {
//       await setStep(chat, 'blocked', ASK_ADMIN);
//       await reply(chat, say('missHint'));
//       return undefined;
//     }
//     if (misses === 2) {
//       await setStep(chat, 'blocked', ASK_ADMIN);
//       await reply(chat, say('offerAdmin') + '\n\n' + HANDOFF_OPTIONS);
//       return undefined;
//     }
//     return again();
//   }
//
//   // Audio, foto, documento...: o robo so le texto. Avisa e oferece um
//   // administrador; se a pessoa insistir (segunda seguida), passa para ele.
//   async function mediaReply(chat, kind) {
//     missed.add(String(chat._id));
//     const fresh = await WaChat.findOneAndUpdate({ _id: chat._id }, { $inc: { botMisses: 1 } }, { new: true })
//       .select('botMisses')
//       .lean();
//     if ((fresh?.botMisses || 1) >= 2) return handoff(chat);
//     await setStep(chat, 'blocked', ASK_ADMIN);
//     await reply(chat, say(kind === 'audio' ? 'audio' : 'media') + '\n\n' + HANDOFF_OPTIONS);
//     return undefined;
//   }
//
//   async function optOut(chat, { silent = false } = {}) {
//     await setOptOut({ phone: chat.phone, lid: chat.lid }, true, new Date(now()));
//     console.log('WhatsApp: uma pessoa pediu para não receber mais avisos.');
//     if (silent) return;
//     await setStep(chat, 'done');
//     await reply(chat, say('optedOut'));
//   }
//
//   // "Tem o livro X?": procura no acervo (titulo ou autor, todas as palavras).
//   // Devolve true se respondeu. sure: a pessoa perguntou mesmo por um livro -
//   // sem achar, o robo diz; senao, fica para o "nao entendi".
//   // O acervo em memoria (titulo + autores ja em palavras), para a busca
//   // aproximada. Igreja: centenas a poucos milhares de livros - cabe folgado.
//   // VOCABULARIO do acervo: cada palavra (de titulo ou autor) UMA vez, com os
//   // livros que a tem. A busca compara a palavra procurada com o vocabulario
//   // (alguns milhares de palavras), e nao com cada livro: e o que deixa a busca
//   // aproximada barata (ela e CPU sincrona: segura o processo enquanto roda).
//   let catalogCache = { at: 0, books: [], vocab: new Map() };
//   async function catalogIndex() {
//     if (catalogCache.at && now() - catalogCache.at < cfg.catalogTtlMs) return catalogCache;
//     const books = await Book.find().select('title titleSort authors copies').limit(cfg.catalogMax).lean();
//     const vocab = new Map();
//     books.forEach((book, index) => {
//       for (const word of new Set(tokensOf(book.title + ' ' + (book.authors || []).join(' ')))) {
//         if (word.length < 2 || BOOK_STOP.has(word)) continue;
//         if (!vocab.has(word)) vocab.set(word, []);
//         vocab.get(word).push(index);
//       }
//     });
//     catalogCache = { at: now(), books, vocab };
//     return catalogCache;
//   }
//
//   // Primeiras letras que podem comecar a mesma palavra (h mudo, troca pelo
//   // som): so essas entram na comparacao.
//   const START_ALIKE = { c: 'cksq', k: 'kcq', q: 'qkc', s: 'scz', z: 'zs', e: 'ei', i: 'ie', o: 'ou', u: 'uo', g: 'gj', j: 'jg', x: 'xsz', m: 'mn', n: 'nm' };
//   function startsCompatible(a, b) {
//     const x = a.replace(/^h/, '') || a;
//     const y = b.replace(/^h/, '') || b;
//     return x[0] === y[0] || (START_ALIKE[x[0]] || '').includes(y[0]);
//   }
//
//   // Livros em que CADA palavra procurada bate (com tolerancia) com uma
//   // palavra do titulo ou do autor; do mais parecido para o menos.
//   async function approximateBooks(query) {
//     const words = [...new Set(tokensOf(query).filter((word) => word.length > 1 && !BOOK_STOP.has(word)))];
//     if (!words.length || words.length > 8) return [];
//     // (palavra curta demais nao segura uma busca aproximada sozinha)
//     if (words.every((word) => word.length < 4)) return [];
//     const { books, vocab } = await catalogIndex();
//     // total[i] = soma das melhores distancias do livro i; count[i] = quantas
//     // palavras procuradas ele ja tem.
//     const total = new Map();
//     const count = new Map();
//     for (const word of words) {
//       const best = new Map();
//       for (const [known, indexes] of vocab) {
//         if (Math.abs(known.length - word.length) > 3 || !startsCompatible(word, known)) continue;
//         const score = wordScore(word, known);
//         if (score === Infinity) continue;
//         for (const index of indexes) {
//           if (!best.has(index) || score < best.get(index)) best.set(index, score);
//         }
//       }
//       for (const [index, score] of best) {
//         total.set(index, (total.get(index) || 0) + score);
//         count.set(index, (count.get(index) || 0) + 1);
//       }
//     }
//     const scored = [];
//     for (const [index, sum] of total) {
//       if (count.get(index) === words.length) scored.push({ book: books.at(index), total: sum });
//     }
//     scored.sort((a, b) => a.total - b.total || String(a.book.titleSort || '').localeCompare(String(b.book.titleSort || '')));
//     return scored.slice(0, 30).map((item) => item.book);
//   }
//
//   async function bookSearch(chat, query, { sure = false } = {}) {
//     const words = searchWords(normalizeText(query)).filter((word) => !BOOK_STOP.has(word));
//     if (!words.length) return false;
//     const term = words.join(' ');
//     const link = cfg.siteUrl ? cfg.siteUrl + '/catalogo' : '';
//     let found = await Book.find({
//       $or: [{ titleSort: allWordsRegex(term) }, { authors: allWordsRegex(term, { accents: true }) }],
//     })
//       .select('title titleSort authors copies')
//       .limit(30)
//       .lean();
//     // Nada com as palavras exatas: tenta com tolerancia a erro de digitacao
//     // ("peregrno", "cristianismo puro e simple", "luccado").
//     let approximate = false;
//     if (!found.length) {
//       found = await approximateBooks(query);
//       approximate = found.length > 0;
//     }
//     if (!found.length) {
//       if (!sure) return false;
//       await setStep(chat, 'done');
//       await reply(
//         chat,
//         say('bookNone', { query: typedText(query, 60) }) + (link ? '\n' + link : '') + '\n\n' + backHint()
//       );
//       return true;
//     }
//     // (a busca aproximada ja vem do mais parecido para o menos)
//     if (!approximate) found.sort(
//       (a, b) =>
//         matchRank(a.titleSort || '', term) - matchRank(b.titleSort || '', term) ||
//         String(a.titleSort || '').localeCompare(String(b.titleSort || ''))
//     );
//     const shown = found.slice(0, 4);
//     const lines = await Promise.all(
//       shown.map(async (book) => {
//         const out = await occupiedCount(book._id);
//         const free = (book.copies || 1) - out > 0;
//         const author = typedText(book.authors?.[0] || '', 50);
//         return (
//           '• ' + bold(book.title) + (author ? ' – ' + author : '') + (free ? ' – disponível' : ' – emprestado no momento')
//         );
//       })
//     );
//     await setStep(chat, 'done');
//     await reply(
//       chat,
//       (approximate
//         ? say('bookApprox', { query: typedText(query, 60) })
//         : say(shown.length === 1 ? 'bookOne' : 'bookMany')) +
//         '\n\n' +
//         lines.join('\n') +
//         (found.length > shown.length ? '\n' + say('bookMore') : '') +
//         (link ? '\n\n' + say('bookHow') + '\n' + link : '') +
//         '\n\n' +
//         backHint()
//     );
//     return true;
//   }
//
//   /**
//    * Faz o que a mensagem pediu (o resultado de understand). Devolve true se
//    * tratou (respondendo ou decidindo ficar calado) e false se nao e com ele
//    * (segue o caminho normal do passo: menu, "nao entendi").
//    * fresh: e o comeco de uma conversa (ainda nao houve saudacao);
//    * sentBefore: a mensagem foi escrita antes de a pessoa ler a ultima
//    * resposta do robo (rajada).
//    */
//   async function actOn(chat, u, { fresh = false, sentBefore = false } = {}) {
//     if (!u) return false;
//     switch (u.id) {
//       case 'stop':
//         await optOut(chat);
//         return true;
//       case 'resume':
//         await setOptOut({ phone: chat.phone, lid: chat.lid }, false);
//         await setStep(chat, 'done');
//         await reply(chat, say('optedIn'));
//         return true;
//       case 'admin':
//         await handoff(chat);
//         return true;
//       case 'bot':
//         // ("o livro O Robo Selvagem esta disponivel?" e busca)
//         if (u.book && (await bookSearch(chat, u.book, { sure: u.bookSure }))) return true;
//         await setStep(chat, 'blocked', ASK_ADMIN);
//         await reply(chat, say('botHonest') + '\n\n' + HANDOFF_OPTIONS);
//         return true;
//       case 'extend':
//         await startExtension(chat);
//         return true;
//       case 'loans':
//         await listLoans(chat);
//         return true;
//       case 'borrow': {
//         const link = cfg.siteUrl ? cfg.siteUrl + '/catalogo' : '';
//         await setStep(chat, 'done');
//         await reply(chat, say('borrowHow') + (link ? '\n' + link : '') + '\n\n' + backHint());
//         return true;
//       }
//       case 'catalog':
//         if (u.book && (await bookSearch(chat, u.book, { sure: false }))) return true;
//         await chooseMain(chat, 1);
//         return true;
//       case 'custom': {
//         const text = pick(u.entry?.answers || [], rng);
//         if (!text) return false;
//         await setStep(chat, 'done');
//         const sent = await reply(chat, text + '\n\n' + backHint());
//         if (sent && u.entry?._id) {
//           WaAnswer.updateOne({ _id: u.entry._id }, { $inc: { hits: 1 }, $set: { lastHitAt: new Date(now()) } }).catch(
//             () => {}
//           );
//         }
//         return true;
//       }
//       case 'greeting':
//         // Comeco de conversa: a saudacao com o menu (caminho normal).
//         if (fresh) return false;
//         // "Tudo bem?" logo depois do "Oi": a pessoa ainda nem leu o menu.
//         if (sentBefore) return true;
//         await showMain(chat, { greet: true, hello: u.hello });
//         return true;
//       case 'thanks': {
//         // Ja respondeu a um agradecimento ha pouco: nao entra em laco.
//         const closed = chat.botClosedAt && now() - new Date(chat.botClosedAt).getTime() < cfg.closedMs;
//         if (closed) return true;
//         await setStep(chat, 'done');
//         const sent = await reply(chat, say('thanksReply'));
//         if (sent) await WaChat.updateOne({ _id: chat._id }, { $set: { botClosedAt: new Date(now()) } }).catch(() => {});
//         return true;
//       }
//       case 'ack': {
//         // "ok", "👍": ninguem responde a isso. So no comeco de uma conversa
//         // SEM nada recente do robo e que vale como um "oi".
//         if (!fresh) return true;
//         const recent = chat.botAt && now() - new Date(chat.botAt).getTime() < 3 * 24 * 60 * 60 * 1000;
//         return Boolean(recent);
//       }
//       default:
//         if (u.book) return bookSearch(chat, u.book, { sure: u.bookSure });
//         return false;
//     }
//   }
//
//   // Na lista "qual emprestimo?", a pessoa escreveu em vez de mandar o
//   // numero ("o primeiro", "o peregrino"): acha o item, se for UM so.
//   function pickByText(text, loans) {
//     const tokens = tokensOf(text).filter((token) => !BOOK_STOP.has(token));
//     if (!tokens.length || tokens.length > 8) return null;
//     const ordinal = ORDINALS.findIndex((stem) => tokens.some((token) => token.startsWith(stem)));
//     if (ordinal >= 0 && tokens.length <= 2) return loans[ordinal] || null;
//     // (cada palavra escrita bate com uma do titulo, com tolerancia a erro:
//     // "o peregrno")
//     const hits = loans.filter((loan) => {
//       const title = tokensOf(loan.bookTitle);
//       return tokens.every((token) =>
//         title.some((word) => (token.length >= 3 && word.startsWith(token)) || sameWord(token, word))
//       );
//     });
//     return hits.length === 1 ? hits[0] : null;
//   }
//
//   async function chooseMain(chat, option) {
//     if (option === 1) {
//       const link = cfg.siteUrl ? cfg.siteUrl + '/catalogo' : '';
//       await setStep(chat, 'done');
//       await reply(
//         chat,
//         (link
//           ? say('catalogLink') + '\n' + link
//           : say('catalogNoLink')) +
//           '\n\n' +
//           backHint()
//       );
//       return;
//     }
//     if (option === 2) return openLoans(chat);
//     if (option === 3) return handoff(chat);
//     return showMain(chat, { prefix: notUnderstood() });
//   }
//
//   async function openLoans(chat, { prefix = '' } = {}) {
//     const people = await peopleOf(chat);
//     const loans = await activeLoansOf(chat, people);
//     if (!people.length && !loans.length) {
//       await setStep(chat, 'blocked', ASK_ADMIN);
//       await reply(
//         chat,
//         say('noRecord') + '\n\n' + HANDOFF_OPTIONS
//       );
//       return;
//     }
//     if (!loans.length) {
//       await setStep(chat, 'done');
//       await reply(chat, say('noLoans') + '\n\n' + backHint());
//       return;
//     }
//     await setStep(chat, 'loans');
//     await reply(chat, (prefix ? prefix + '\n\n' : '') + say('loansTitle') + '\n\n' + LOANS_OPTIONS);
//   }
//
//   async function listLoans(chat) {
//     const people = await peopleOf(chat);
//     const loans = await activeLoansOf(chat, people);
//     if (!loans.length) return openLoans(chat);
//     await setStep(chat, 'loans');
//     await reply(
//       chat,
//       say(loans.length === 1 ? 'oneLoan' : 'manyLoans') +
//         '\n\n' +
//         loans.map((loan) => loanLine(loan, manyOwners(loans))).join('\n') +
//         '\n\n' +
//         key(2) +
//         ' Estender a data de devolução\n' +
//         BACK
//     );
//   }
//
//   async function startExtension(chat, { prefix = '' } = {}) {
//     const people = await peopleOf(chat);
//     const loans = await activeLoansOf(chat, people);
//     if (!loans.length) return openLoans(chat);
//     if (loans.length === 1) return offerExtension(chat, loans[0]);
//     const shown = loans.slice(0, 9);
//     await setStep(chat, 'pick-loan', { ids: shown.map((l) => String(l._id)) });
//     await reply(
//       chat,
//       (prefix ? prefix + '\n\n' : '') +
//         say('whichLoan') + '\n\n' +
//         shown
//           .map(
//             (loan, index) =>
//               key(index + 1) + ' ' + loanLine(loan, manyOwners(shown)).slice(2)
//           )
//           .join('\n') +
//         '\n' +
//         BACK
//     );
//   }
//
//   async function offerExtension(chat, loan) {
//     const check = await extensionCheck(loan);
//     if (!check.ok) {
//       await setStep(chat, 'blocked', ASK_ADMIN);
//       await reply(chat, check.reason + '\n\n' + HANDOFF_OPTIONS);
//       return;
//     }
//     await setStep(chat, 'confirm', { id: String(loan._id), from: check.from, to: check.to });
//     await reply(
//       chat,
//       say('confirmExtension') + '\n\n' +
//         bold(loan.bookTitle) +
//         '\nDevolução atual: ' +
//         brDate(check.from) +
//         '\nNova devolução: ' +
//         brDate(check.to) +
//         '\n\n' +
//         CONFIRM_OPTIONS
//     );
//   }
//
//   async function confirmExtension(chat, data) {
//     const people = await peopleOf(chat);
//     const loan = data?.id ? await Loan.findById(data.id).lean() : null;
//     if (!belongsTo(loan, chat, people)) {
//       return openLoans(chat, { prefix: say('loanGone') });
//     }
//     const check = await extensionCheck(loan);
//     if (!check.ok) {
//       await setStep(chat, 'blocked', ASK_ADMIN);
//       await reply(chat, check.reason + '\n\n' + HANDOFF_OPTIONS);
//       return;
//     }
//     if (check.from !== data.from || check.to !== data.to) {
//       // O prazo mudou entre a pergunta e a resposta: pergunta de novo.
//       return offerExtension(chat, loan);
//     }
//     const to = new Date(check.to + 'T00:00:00Z');
//     const updated = await Loan.findOneAndUpdate(
//       { _id: loan._id, status: 'ativo', dueDate: loan.dueDate },
//       {
//         $set: { dueDate: to, reminderSentAt: null },
//         $push: {
//           dueExtensions: {
//             from: loan.dueDate,
//             to,
//             at: new Date(now()),
//             by: null,
//             byName: EXTENSION_BY_NAME,
//             via: 'whatsapp',
//           },
//         },
//       },
//       { new: true }
//     );
//     if (!updated) {
//       return openLoans(chat, {
//         prefix: say('loanChanged'),
//       });
//     }
//     console.log('WhatsApp: prazo estendido pelo atendimento automático.');
//     await setStep(chat, 'done');
//     await reply(
//       chat,
//       say('extended', { title: bold(loan.bookTitle), date: brDate(check.to) }) +
//         '\n\n' +
//         backHint()
//     );
//   }
//
//   async function handoff(chat) {
//     const at = new Date(now());
//     const alreadyAsked =
//       chat.handoffAt && now() - new Date(chat.handoffAt).getTime() < 30 * 60 * 1000;
//     await WaChat.updateOne(
//       { _id: chat._id },
//       {
//         $set: {
//           mode: 'human',
//           humanUntil: new Date(now() + cfg.handoffMs),
//           handoffAt: alreadyAsked ? chat.handoffAt : at,
//           handoffReason: alreadyAsked && chat.handoffReason ? chat.handoffReason : 'admin',
//           botStep: '',
//           botData: null,
//           botAt: at,
//         },
//       }
//     );
//     // O administrador e avisado MESMO se a confirmacao para a pessoa falhar
//     // (WhatsApp lento, teto do dia): senao a conversa ficaria pausada sem
//     // ninguem saber.
//     try {
//       await reply(
//         chat,
//         say('handoff')
//       );
//     } finally {
//       if (!alreadyAsked) await notifyAdmin(chat);
//     }
//   }
//
//   async function notifyAdmin(chat) {
//     if (!cfg.adminPhone) return;
//     try {
//       const people = await peopleOf(chat);
//       // Numero de mais de uma ficha (familia): nao da para saber quem e.
//       const name =
//         people.length === 1
//           ? people[0].fullName
//           : people.length > 1
//             ? (chat.pushName ? chat.pushName + ', ' : '') +
//               'número de ' +
//               people.map((p) => p.fullName).join(' / ')
//             : chat.pushName || 'Contato sem nome';
//       const phone = prettyPhone(chat.phone);
//       const link = cfg.siteUrl ? cfg.siteUrl + '/conversas/' + chat._id : '';
//       const admin = await resolveChat({ phone: cfg.adminPhone });
//       if (!admin) return;
//       await sendAutomatic(
//         admin,
//         '*Biblioteca ADMP Brasil – atendimento*\n\n' +
//           name +
//           (phone ? ' (' + phone + ')' : '') +
//           ' quer falar com um administrador pelo WhatsApp.' +
//           (link ? '\n\nAbrir a conversa no painel:\n' + link : ''),
//         'handoff'
//       );
//     } catch (error) {
//       // O pedido continua marcado no painel ("Aguardando administrador").
//       console.error('WhatsApp: não foi possível avisar o administrador:', error.message);
//     }
//   }
//
//   // ---------- Pedido de emprestimo (o "Combinar" do acervo publico) ----------
//
//   // Mais um aviso de pedido por esta conversa cabe no freio do dia? (Conta
//   // so se couber: a mesma conta e feita de uma vez no banco.)
//   async function takeRequestNotice(chat) {
//     const dayStart = new Date(now() - 24 * 60 * 60 * 1000);
//     const t = new Date(now());
//     const fresh = await WaChat.findOneAndUpdate(
//       {
//         _id: chat._id,
//         $or: [
//           { requestDayAt: null },
//           { requestDayAt: { $lte: dayStart } },
//           { requestDayCount: { $lt: cfg.maxRequestNoticesPerDay } },
//         ],
//       },
//       [
//         {
//           $set: {
//             requestDayCount: {
//               $cond: [
//                 { $gt: [{ $ifNull: ['$requestDayAt', new Date(0)] }, dayStart] },
//                 { $add: [{ $ifNull: ['$requestDayCount', 0] }, 1] },
//                 1,
//               ],
//             },
//             requestDayAt: {
//               $cond: [
//                 { $gt: [{ $ifNull: ['$requestDayAt', new Date(0)] }, dayStart] },
//                 '$requestDayAt',
//                 t,
//               ],
//             },
//           },
//         },
//       ],
//       { new: true }
//     ).lean();
//     return Boolean(fresh);
//   }
//
//   async function notifyRequest(chat, { request, parsed, title }) {
//     if (!cfg.requestsAdminPhone) return;
//     try {
//       if (!(await takeRequestNotice(chat))) {
//         console.warn('WhatsApp: muitos pedidos de empréstimo da mesma conversa hoje; aviso ao administrador não enviado.');
//         return;
//       }
//       // O nome e o titulo sem a solicitacao no banco sao o que a pessoa DIGITOU
//       // na mensagem (marcados como tal). O nome do formulario tambem foi
//       // digitado por ela: todos passam por typedText (sem link clicavel).
//       const name =
//         (typedText(request?.requesterName) ||
//           typedText(parsed.name) ||
//           typedText(chat.pushName) ||
//           'Contato sem nome') +
//         (request ? (request.requesterIsNew ? ' (novo cadastro)' : '') : parsed.isNew ? ' (novo cadastro)' : '');
//       const phone = prettyPhone(chat.phone);
//       const day = request?.pickupDate ? dayOf(request.pickupDate) : '';
//       const approve =
//         request && cfg.siteUrl ? cfg.siteUrl + '/solicitacao/' + encodeURIComponent(request.token) : '';
//       const conversation = cfg.siteUrl ? cfg.siteUrl + '/conversas/' + chat._id : '';
//       const admin = await resolveChat({ phone: cfg.requestsAdminPhone });
//       if (!admin) return;
//       await sendAutomatic(
//         admin,
//         '*Biblioteca ADMP Brasil – pedido de empréstimo* 📚\n\n' +
//           name +
//           ' quer pegar emprestado ' +
//           bold(title) +
//           '.' +
//           (phone ? '\nWhatsApp: ' + phone : '') +
//           (day ? '\nDia de preferência para pegar: ' + brDate(day) : '') +
//           (request ? '' : '\n(nome e livro como a pessoa escreveu na mensagem)') +
//           (approve
//             ? '\n\nAprovar a solicitação e preencher as datas no painel:\n' + approve
//             : request
//               ? ''
//               : parsed.token
//                 ? '\n\nO link desta solicitação não vale mais (já foi registrada, virou empréstimo, foi excluída ou venceu): confira em Empréstimos › Solicitados.'
//                 : '\n\nO pedido chegou sem o link da solicitação: registre em Empréstimos › Solicitados.') +
//           (conversation ? '\n\nConversa no painel:\n' + conversation : ''),
//         'request'
//       );
//     } catch (error) {
//       // O pedido continua marcado no painel ("Pedido de empréstimo").
//       console.error('WhatsApp: não foi possível avisar o administrador do pedido:', error.message);
//     }
//   }
//
//   /**
//    * A mensagem e o pedido pronto do acervo publico ("gostaria de pegar
//    * emprestado o livro ..." com o link /solicitacao/<id>): o robo confirma
//    * para a pessoa, passa a conversa para um administrador e avisa o
//    * administrador dos pedidos. quiet: um administrador ja esta conversando
//    * aqui (o robo nao se mete; so o aviso sai). Devolve false quando nao e um
//    * pedido de verdade (link que nao existe e sem o texto do pedido): segue o
//    * atendimento normal.
//    */
//   async function handleRequest(chat, parsed, { quiet = false, staff = false } = {}) {
//     let request = parsed.token ? await LoanRequest.findOne({ token: parsed.token }).lean() : null;
//     const typedTitle = typedText(parsed.title);
//     if (!request && !typedTitle) return false;
//     const title = request?.bookTitle || typedTitle;
//     // O link ja chegou por OUTRA conversa: aqui nao se usa o nome de la.
//     const otherChat = request?.waChat && String(request.waChat) !== String(chat._id);
//     // Alguem da equipe colou aqui o link de um pedido que ja chegou por outra
//     // conversa (copiado do aviso): nao e um pedido dele. Fica quieto.
//     if (staff && otherChat) return true;
//     const first = firstName(
//       (!otherChat && request?.requesterName) || typedText(parsed.name) || typedText(chat.pushName)
//     );
//
//     // A equipe ja registrou (a pessoa mandou a mensagem de novo depois).
//     if (request && request.status !== 'pendente') {
//       if (quiet) return true;
//       await setStep(chat, 'done');
//       await reply(
//         chat,
//         say('requestDone', {
//           title: bold(title),
//           pickup: request.pickupDate
//             ? ' (retirada prevista em ' + brDate(dayOf(request.pickupDate)) + ')'
//             : '',
//         }) +
//           '\n\n' +
//           backHint()
//       );
//       return true;
//     }
//
//     // Um aviso por link: o mesmo link de novo (mensagem repetida) nao avisa
//     // outra vez. Sem link, a mesma mensagem em 30 minutos tambem nao. O link
//     // fica com a PRIMEIRA conversa que o mandou: outra conversa mandando o
//     // mesmo link (encaminhado, ou o mesmo nome pedindo o mesmo livro) recebe a
//     // resposta, mas nao toma o link nem gera aviso novo.
//     let notify;
//     if (request) {
//       const claimed = await LoanRequest.findOneAndUpdate(
//         {
//           _id: request._id,
//           status: 'pendente',
//           waNotifiedAt: null,
//           $or: [{ waChat: null }, { waChat: chat._id }],
//         },
//         { $set: { waNotifiedAt: new Date(now()), waChat: chat._id, waPhone: chat.phone || '' } },
//         { new: true }
//       ).lean();
//       notify = Boolean(claimed);
//       if (claimed) request = claimed;
//     } else {
//       const requestKey = normalizeInput(title + '|' + (parsed.name || ''));
//       const repeated =
//         chat.lastRequestKey === requestKey &&
//         chat.lastRequestAt &&
//         now() - new Date(chat.lastRequestAt).getTime() < 30 * 60 * 1000;
//       notify = !repeated;
//       if (notify) {
//         await WaChat.updateOne(
//           { _id: chat._id },
//           { $set: { lastRequestKey: requestKey, lastRequestAt: new Date(now()) } }
//         );
//       }
//     }
//
//     // A conversa passa para um administrador (o robo fica quieto) e aparece
//     // no painel como "Pedido de empréstimo".
//     const at = new Date(now());
//     const humanUntil = Math.max(
//       now() + cfg.handoffMs,
//       chat.mode === 'human' && chat.humanUntil ? new Date(chat.humanUntil).getTime() : 0
//     );
//     await WaChat.updateOne(
//       { _id: chat._id },
//       {
//         $set: {
//           mode: 'human',
//           humanUntil: new Date(humanUntil),
//           handoffAt: chat.mode === 'human' && chat.handoffAt ? chat.handoffAt : at,
//           handoffReason: 'request',
//           botStep: '',
//           botData: null,
//           botAt: at,
//         },
//       }
//     );
//
//     try {
//       if (!quiet) {
//         await reply(
//           chat,
//           say('requestReceived', { name: first ? ', ' + first : '', title: bold(title) })
//         );
//       }
//     } finally {
//       // O administrador e avisado mesmo se a resposta a pessoa falhar.
//       if (notify) await notifyRequest(chat, { request, parsed, title });
//     }
//     return true;
//   }
//
//   // ---------- Entrada de cada mensagem ----------
//
//   // choiceText: num lote de varias mensagens, a que trouxe o numero/"menu".
//   // parts: num lote de varias mensagens, o texto de cada uma (o "parar" e
//   // procurado em cada uma).
//   async function handleCore({ chat: eventChat, message, text, kind, choiceText = '', parts = null }) {
//     const at = message?.at ? new Date(message.at).getTime() : now();
//     const age = now() - at;
//     // Pedido de emprestimo pronto do acervo publico: vem antes de tudo (vale
//     // ate com um administrador ja na conversa ou com o robo silenciado - e um
//     // pedido explicito, nao um "ok").
//     const request = kind === 'text' ? parseRequestMessage(text) : null;
//     // Pedido que chegou atrasado (o servidor ficou fora do ar por horas): o
//     // administrador ainda e avisado, mas a pessoa nao recebe a resposta
//     // automatica (sairia fora de hora). Mais velho que isto, nem o aviso.
//     const lateRequest = request && age > cfg.maxAgeMs && age <= cfg.maxRequestAgeMs;
//     // (mensagem antiga demais so segue se for um "parar": ver abaixo)
//     const maybeStop = kind === 'text' && [...(parts || []), text].some((part) => detectStop(part));
//     if (age > cfg.maxAgeMs && !lateRequest && !maybeStop) return;
//
//     let chat = await WaChat.findById(eventChat._id).lean();
//     if (!chat) return;
//
//     // O numero que recebe os avisos (ou o do administrador) reencaminhando o
//     // proprio aviso de pedido para ca nao vira um pedido novo.
//     const staff = [cfg.adminPhone, cfg.requestsAdminPhone].some(
//       (phone) => phone && samePhone(chat.phone, phone)
//     );
//
//     // PARAR OS AVISOS (intents.js › detectStop): olha CADA mensagem do lote
//     // (e o lote junto), antes do numero escolhido, sem depender do modo
//     // inteligente nem da idade da mensagem. Forma exata ("parar", "pode
//     // parar"): vale na hora. Frase ("nao quero mais receber esses avisos"):
//     // o robo confirma antes. Com um administrador na conversa, robo
//     // silenciado ou mensagem antiga: a forma exata fica anotada sem resposta.
//     if (kind === 'text') {
//       const kinds = [...(parts || []), text].map(detectStop);
//       const stopExact = kinds.includes('exact');
//       // A resposta a uma pergunta do proprio robo vence o pedido "fraco"
//       // ("Cancelar" na confirmacao da extensao cancela a extensao).
//       const stepOpen =
//         chat.botStep &&
//         chat.botAt &&
//         now() - new Date(chat.botAt).getTime() <= (Number(chat.botData?.ttlMs) || cfg.sessionMs);
//       const stepAnswer =
//         stepOpen &&
//         (parseChoice(choiceText || text).digit !== undefined ||
//           confirmWord(chat.botStep, choiceText || text, kind, chat.botData) !== undefined);
//       const stopAsk = !stopExact && !stepAnswer && kinds.includes('phrase');
//       if (stopExact || stopAsk) {
//         const humanActive =
//           chat.mode === 'human' && chat.humanUntil && new Date(chat.humanUntil).getTime() > now();
//         const muted = chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now();
//         if (age > cfg.maxAgeMs || humanActive || muted || !cfg.enabled) {
//           if (stopExact) await optOut(chat, { silent: true }).catch(() => {});
//           return undefined;
//         }
//         if (stopExact) return optOut(chat);
//         await setStep(chat, 'confirm-stop');
//         await reply(chat, say('confirmStop') + '\n\n' + STOP_OPTIONS);
//         return undefined;
//       }
//     }
//     const forwardedNotice = staff && /pedido de empr[ée]stimo/i.test(String(text).slice(0, 120));
//
//     if (request && !forwardedNotice) {
//       const humanActive =
//         chat.mode === 'human' && chat.humanUntil && new Date(chat.humanUntil).getTime() > now();
//       const muted = chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now();
//       // Administrador conversando (sem pedido esperando), robo silenciado ou
//       // pedido atrasado: a pessoa nao recebe a resposta automatica, so o
//       // administrador e avisado.
//       const quiet = Boolean((humanActive && !chat.handoffAt) || muted || lateRequest);
//       if (await handleRequest(chat, request, { quiet, staff })) return;
//     }
//     if (age > cfg.maxAgeMs) return;
//
//     const choice = kind === 'text' ? parseChoice(choiceText || text) : {};
//     // Texto livre (nao e numero nem "menu"): o que a pessoa quer?
//     const free = kind === 'text' && Boolean(text) && choice.digit === undefined && !choice.word;
//     const understood = free ? await understand(text) : null;
//     // Pedido para PARAR os avisos vale sempre: com um administrador na
//     // conversa ou com o robo silenciado, fica anotado sem resposta do robo.
//
//     if (chat.mode === 'human') {
//       if (chat.humanUntil && new Date(chat.humanUntil).getTime() > now()) return;
//       // O atendimento humano venceu: o robo volta, do comeco.
//       await WaChat.updateOne(
//         { _id: chat._id, mode: 'human' },
//         {
//           $set: {
//             mode: 'bot',
//             humanUntil: null,
//             handoffAt: null,
//             handoffReason: '',
//             botStep: '',
//             botData: null,
//           },
//         }
//       );
//       chat = await WaChat.findById(chat._id).lean();
//       if (!chat || chat.mode !== 'bot') return;
//     }
//
//     const expired =
//       !chat.botStep ||
//       !chat.botAt ||
//       now() - new Date(chat.botAt).getTime() > (Number(chat.botData?.ttlMs) || cfg.sessionMs);
//
//     // Estourou o freio (outro robo do outro lado?): mudo por um tempo. Mas
//     // um pedido de administrador ainda passa (o aviso ao administrador nao
//     // depende do freio): ninguem fica sem atendimento sem o painel saber.
//     if (chat.botMutedUntil && new Date(chat.botMutedUntil).getTime() > now()) {
//       const wantsAdmin =
//         (chat.botStep === 'blocked' && !expired && choice.digit === 1) ||
//         ((expired || ['menu', 'done'].includes(chat.botStep)) &&
//           (choice.digit === 3 || (kind === 'text' && mainWord(text) === 3) || understood?.id === 'admin'));
//       if (wantsAdmin) return handoff(chat);
//       return;
//     }
//
//     // O numero do administrador recebe os avisos de atendimento: responder
//     // "ok" a um aviso nao pode puxar o menu. Para testar o robo por ele,
//     // basta mandar "menu".
//     // (Vale tambem para o numero que recebe os avisos de pedido de emprestimo.)
//     if (staff && expired && choice.word !== 'menu') return;
//
//     const pending = unread.get(String(chat._id));
//
//     // A MESMA mensagem de novo (resposta automatica de empresa, "Ola! Esta e
//     // uma mensagem automatica..." a cada mensagem nossa): silencio. Dois robos
//     // conversando e o pior sinal possivel para um numero ja barrado uma vez.
//     const normIn = kind === 'text' ? tokensOf(text).join(' ').slice(0, 200) : '';
//     if (normIn) {
//       const same =
//         chat.botLastIn === normIn &&
//         chat.botLastInAt &&
//         now() - new Date(chat.botLastInAt).getTime() < cfg.repeatMs;
//       const times = same ? (chat.botLastInCount || 1) + 1 : 1;
//       // (a pessoa que repete a pergunta UMA vez recebe resposta - e, se o robo
//       // nao entender, a oferta de um administrador; da terceira vez igual em
//       // diante e laco)
//       const repeated = !expired && choice.digit === undefined && !choice.word && times >= cfg.repeatSilentFrom;
//       await WaChat.updateOne(
//         { _id: chat._id },
//         { $set: { botLastIn: normIn, botLastInAt: new Date(now()), botLastInCount: times } }
//       ).catch(() => {});
//       if (repeated) return undefined;
//     }
//
//     // COMECO DE CONVERSA (ou a anterior ja esfriou).
//     if (expired) {
//       // (os "nao entendi" de uma conversa antiga nao contam nesta)
//       if (chat.botMisses) {
//         await WaChat.updateOne({ _id: chat._id }, { $set: { botMisses: 0 } }).catch(() => {});
//         chat = { ...chat, botMisses: 0 };
//       }
//       if (kind !== 'text') {
//         // Figurinha como "oi": a saudacao. Audio/foto/arquivo: so le texto.
//         if (kind === 'sticker') return showMain(chat, { greet: true });
//         return mediaReply(chat, kind);
//       }
//       if (understood && (understood.id || understood.book)) {
//         // Ja chegou dizendo o que quer ("oi, queria renovar meu livro"): um
//         // cumprimento curto abre a resposta, sem passar pelo menu.
//         const needsHello = !['stop', 'resume', 'thanks', 'ack', 'greeting'].includes(understood.id);
//         if (needsHello && pending) {
//           const who = await helloFor(chat, understood.hello);
//           pending.lead = pick(PHRASES.helloShort, rng).replace('{hi}', who.hi).replace('{name}', who.name);
//         }
//         if (await actOn(chat, understood, { fresh: true })) return undefined;
//         if (pending) pending.lead = '';
//       }
//       return showMain(chat, { greet: true, hello: understood?.hello || '' });
//     }
//
//     // Rajada logo depois do MENU ("Oi" / "Boa tarde" / "Tudo bem?" em
//     // sequencia, ou o que se acumulou com o servidor fora do ar): o que vem
//     // fora das opcoes nao vira uma fila de "Nao entendi". Vale so nos passos
//     // de menu (10 s: ninguem le o menu e responde em menos que isso). Nos
//     // passos com pergunta (emprestimos, confirmar) a resposta e sempre tratada.
//     const sentBefore = at < new Date(chat.botAt).getTime() + cfg.burstMs;
//     const digit = choice.digit ?? confirmWord(chat.botStep, choiceText || text, kind, chat.botData);
//     if (choice.word === 'menu') return showMain(chat);
//
//     // Audio, foto, arquivo no meio do atendimento (figurinha: nada a dizer).
//     if (kind !== 'text') {
//       if (kind === 'sticker' || sentBefore) return undefined;
//       return mediaReply(chat, kind);
//     }
//
//     const act = () => actOn(chat, understood, { sentBefore });
//     const what = { text, kind };
//     // Resto de rajada: so vale para pedacinho de conversa ("tudo bem?"). Uma
//     // pergunta inteira escrita logo depois da resposta do robo nao pode ficar
//     // sem resposta nenhuma.
//     const burst = sentBefore && tokensOf(text).length <= 4;
//
//     switch (chat.botStep) {
//       case 'menu': {
//         if (digit === 0) return showMain(chat);
//         if ([1, 2, 3].includes(digit)) return chooseMain(chat, digit);
//         // O pedido escrito ("quero renovar", "tem o livro X?") vai direto ao
//         // ponto; a palavra solta do menu ("emprestimos") abre a opcao.
//         if (await act()) return undefined;
//         const option = mainWord(text);
//         if ([1, 2, 3].includes(option)) return chooseMain(chat, option);
//         if (burst) return undefined;
//         return miss(chat, what, () => showMain(chat, { prefix: notUnderstood() }));
//       }
//       case 'done': {
//         if (digit === 1 || digit === 2 || digit === 3) return chooseMain(chat, digit);
//         if (digit === 0) return showMain(chat);
//         if (await act()) return undefined;
//         if (burst) return undefined;
//         // Depois de atendida, a pessoa escreveu algo que o robo nao entende:
//         // o menu volta sem bronca ("Nao entendi"), mas conta - se a proxima
//         // tambem nao for entendida, o robo oferece um administrador.
//         return miss(chat, what, () => showMain(chat));
//       }
//       case 'loans': {
//         const option = digit ?? loansWord(text);
//         if (option === 1) return listLoans(chat);
//         if (option === 2) return startExtension(chat);
//         if (option === 0) return showMain(chat);
//         if (await act()) return undefined;
//         return miss(chat, what, () => openLoans(chat, { prefix: notUnderstood() }));
//       }
//       case 'pick-loan': {
//         if (digit === 0) return openLoans(chat);
//         const ids = chat.botData?.ids || [];
//         let chosen = digit >= 1 && digit <= ids.length ? ids[digit - 1] : null;
//         if (!chosen && digit === undefined) {
//           // Escreveu o nome do livro (ou "o primeiro") em vez do numero.
//           const listed = await Loan.find({ _id: { $in: ids } }).select('bookTitle').lean();
//           const ordered = ids.map((id) => listed.find((loan) => String(loan._id) === String(id))).filter(Boolean);
//           chosen = pickByText(text, ordered)?._id || null;
//         }
//         if (chosen) {
//           const people = await peopleOf(chat);
//           const loan = await Loan.findById(chosen).lean();
//           if (!belongsTo(loan, chat, people)) {
//             return openLoans(chat, { prefix: say('loanGone') });
//           }
//           return offerExtension(chat, loan);
//         }
//         // (pedir de novo "estender" aqui nao muda nada: e o que ja esta na tela)
//         if (understood && !['extend', 'loans', ''].includes(understood.id) && (await act())) return undefined;
//         return miss(chat, what, () => startExtension(chat, { prefix: notUnderstood() }));
//       }
//       case 'confirm-stop': {
//         if (digit === 1) return optOut(chat);
//         if (digit === 0) {
//           await setStep(chat, 'done');
//           await reply(chat, say('stopKept') + '\n\n' + backHint());
//           return undefined;
//         }
//         if (await act()) return undefined;
//         return miss(chat, what, () => reply(chat, notUnderstood() + '\n\n' + STOP_OPTIONS).then(() => undefined));
//       }
//       case 'confirm': {
//         if (digit === 1) return confirmExtension(chat, chat.botData);
//         if (digit === 0) return openLoans(chat, { prefix: say('extensionCancelled') });
//         // Na confirmacao so valem sim/nao, parar e chamar um administrador
//         // (um "obrigado" aqui nao confirma nem cancela nada).
//         if (understood && ['stop', 'admin'].includes(understood.id) && (await act())) return undefined;
//         return miss(chat, what, () => reply(chat, notUnderstood() + '\n\n' + CONFIRM_OPTIONS).then(() => undefined));
//       }
//       case 'blocked': {
//         if (digit === 1) return handoff(chat);
//         if (digit === 0) return showMain(chat);
//         // Resposta ao AVISO DE ATRASO ("Sim, devolvo domingo", "ok", "vou
//         // levar amanha"): um "combinado, obrigado" e pronto - nem chama
//         // ninguem, nem "nao entendi". Pedido de verdade (renovar, livro,
//         // administrador) segue o caminho normal.
//         if (chat.botData?.ask !== 'admin') {
//           const real = understood && (understood.book || !['', 'ack', 'thanks', 'greeting'].includes(understood.id));
//           if (real && (await act())) return undefined;
//           await setStep(chat, 'done');
//           await reply(chat, say('noticeAck'));
//           return undefined;
//         }
//         if (await act()) return undefined;
//         return miss(chat, what, () => reply(chat, notUnderstood() + '\n\n' + HANDOFF_OPTIONS).then(() => undefined));
//       }
//       default:
//         return showMain(chat, { greet: true });
//     }
//   }
//
//   // A Meta restringiu o numero (ou avisou do limite de conversas novas): a
//   // equipe precisa saber NA HORA, e nao descobrir pelo celular dias depois.
//   // Vai para o administrador (uma conversa que ja existe: continua permitido).
//   async function notifyRestricted({ until, kind }) {
//     if (!cfg.enabled || !cfg.adminPhone) return;
//     const admin = await resolveChat({ phone: cfg.adminPhone });
//     if (!admin) return;
//     const when = until
//       ? new Intl.DateTimeFormat('pt-BR', {
//           timeZone: 'America/Sao_Paulo',
//           day: '2-digit',
//           month: '2-digit',
//           hour: '2-digit',
//           minute: '2-digit',
//         }).format(new Date(until))
//       : '';
//     const what =
//       kind === 'cap-warning'
//         ? 'O WhatsApp avisou que o número da biblioteca está perto do limite de conversas novas.'
//         : kind === 'capped'
//           ? 'O WhatsApp bloqueou conversas novas no número da biblioteca neste período (limite atingido).'
//           : 'O WhatsApp restringiu o número da biblioteca para iniciar conversas' + (when ? ' até ' + when : '') + '.';
//     await sendAutomatic(
//       admin,
//       '*Biblioteca ADMP Brasil – atenção ao número*\n\n' +
//         what +
//         '\n\nOs avisos automáticos de atraso foram pausados e voltam sozinhos, aos poucos. Responder a quem escrever continua funcionando.' +
//         '\n\nAté lá, não escreva pelo painel para quem nunca mandou mensagem para o número: insistir piora a restrição.',
//       'handoff'
//     );
//   }
//
//   /** A equipe respondeu (painel ou celular): o robo fica quieto nessa conversa. */
//   async function humanTookOver(chatId) {
//     await WaChat.updateOne(
//       { _id: chatId },
//       {
//         $set: {
//           mode: 'human',
//           humanUntil: new Date(now() + cfg.humanMs),
//           handoffAt: null,
//           handoffReason: '',
//           botStep: '',
//           botData: null,
//         },
//       }
//     );
//   }
//
//   function onEvent(event) {
//     if (event.type === 'incoming') {
//       return enqueue(event).catch((error) => {
//         console.error('WhatsApp: o atendimento automático falhou numa mensagem:', error.message);
//       });
//     }
//     if (event.type === 'phone-out') {
//       return humanTookOver(event.chat._id).catch(() => {});
//     }
//     if (event.type === 'restricted') {
//       return notifyRestricted(event).catch((error) => {
//         console.error('WhatsApp: não foi possível avisar o administrador da restrição:', error.message);
//       });
//     }
//     return undefined;
//   }
//
//   return {
//     config: cfg,
//     start() {
//       if (stop) return;
//       stop = whatsapp.onEvent(onEvent);
//       if (!cfg.siteUrl) {
//         console.warn('WhatsApp: sem PUBLIC_SITE_URL/CORS_ORIGIN https: os links do atendimento ficam sem endereço.');
//       }
//     },
//     stop() {
//       stop?.();
//       stop = null;
//     },
//     handle: (event) => enqueue(event),
//     // O que o robo entenderia de um texto (o "Testar" do painel) e a troca
//     // das respostas cadastradas (o painel chama ao salvar).
//     understand,
//     reloadAnswers() {
//       answersCache = { at: 0, list: answersCache.list };
//     },
//     // Direto (fora da fila): o painel nao espera uma resposta do robo terminar.
//     humanTookOver,
//     sendAutomatic,
//     // (o aviso de atraso usa com strict: em atendimento humano, nada)
//     stillMine,
//   };
// }
//
// /** O atendimento que o servidor usa (ligado em server.js). */
// export const bot = createBot({ whatsapp: defaultWhatsapp });
//
// // Reconectando ha mais que isto, o "Combinar" vai para o brasileiro: a
// // mensagem para o +54 ficaria horas sem resposta.
// const RECONNECT_GRACE_MS = 15 * 60 * 1000;
//
// // O WhatsApp da biblioteca recebe agora (ou vai receber em instantes)?
// // - aberto, ou outra copia do servidor com a conexao (standby, no deploy);
// // - conectando/reconectando COM sessao salva e fora do ar ha pouco tempo
// //   (servidor acordando, queda rapida). Sem sessao, conectando e o QR.
// function receivingSoon(status, now) {
//   if (status.state === 'open' || status.state === 'standby') return true;
//   if (status.state !== 'connecting' && status.state !== 'reconnecting') return false;
//   if (!status.hasSession) return false;
//   const down = status.downSince ? Date.parse(status.downSince) : NaN;
//   return Number.isFinite(down) && now - down < RECONNECT_GRACE_MS;
// }
//
// /**
//  * Para qual WhatsApp vai o "Combinar" do acervo publico:
//  * - "robo" (padrao): o numero da biblioteca conectado ao painel (+54), onde o
//  *   robo confirma o pedido e avisa o administrador dos pedidos;
//  * - "brasil": o MODELO ANTIGO, guardado como reserva - a mensagem vai direto
//  *   para o WhatsApp brasileiro (LIBRARY_WHATSAPP_BR), e a equipe combina por
//  *   la, como antes do robo. Escolhido com REQUESTS_WHATSAPP=brasil no Render.
//  * Mesmo no "robo", se o WhatsApp da biblioteca nao esta conectado (QR por
//  * ler, sessao quebrada, desligado) ou o robo esta desligado, vai para o
//  * brasileiro: ninguem fica sem resposta.
//  * Devolve { number, via: "robo" | "brasil" }.
//  */
// export function requestChannel({
//   env = process.env,
//   whatsapp = defaultWhatsapp,
//   botConfig = bot.config,
//   now = Date.now(),
// } = {}) {
//   const legacy = digitsOf(env.LIBRARY_WHATSAPP_BR || LEGACY_REQUESTS_WHATSAPP);
//   const mode = String(env.REQUESTS_WHATSAPP || 'robo').trim().toLowerCase();
//   if (mode === 'brasil' || !botConfig.enabled) return { number: legacy, via: 'brasil' };
//   const status = whatsapp.snapshot();
//   const ready = status.enabled && !status.broken && receivingSoon(status, now);
//   const number = digitsOf(whatsapp.config?.number || status.number);
//   return ready && number ? { number, via: 'robo' } : { number: legacy, via: 'brasil' };
// }
