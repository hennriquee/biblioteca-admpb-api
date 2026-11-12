/**
 * HUMANIZACAO dos envios do WhatsApp da biblioteca.
 *
 * O WhatsApp (Meta) desconfia de numero que se comporta como maquina:
 * resposta instantanea, sem "digitando…", sem ler antes de responder, sempre
 * o mesmo texto, sempre o mesmo intervalo. Este arquivo reune o que faz o
 * robo parecer gente:
 *
 * - TEMPOS com variacao (jitter): leitura proporcional ao que a pessoa
 *   escreveu, "digitando…" proporcional ao tamanho da resposta (~30 a 55 ms
 *   por letra, como a orientacao corrente para Baileys), pausas no meio de
 *   textos longos e intervalos irregulares entre mensagens;
 * - TEXTOS com variacao: cada frase do robo tem varias formas equivalentes
 *   (sinonimos de verdade, nada de caractere invisivel, que e truque
 *   conhecido de spam e pode piorar a situacao).
 *
 * Tudo aceita um "rng" (gerador de 0 a 1) para os testes serem repetiveis.
 */

export const defaultRng = Math.random;

/** Um numero entre min e max (inclusive), com o gerador dado. */
export function between(min, max, rng = defaultRng) {
  return min + (max - min) * rng();
}

/** Valor com variacao de +/- spread (0.25 = 25%). */
export function jitter(value, spread = 0.25, rng = defaultRng) {
  return Math.max(0, Math.round(value * (1 - spread + 2 * spread * rng())));
}

/** Um item da lista (ou o proprio valor, se nao for lista). */
export function pick(list, rng = defaultRng) {
  if (!Array.isArray(list)) return list;
  if (!list.length) return '';
  return list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
}

/**
 * Gerador repetivel a partir de um texto (ex.: o id do emprestimo), para a
 * MESMA situacao dar sempre o mesmo texto (o painel compara o rascunho com o
 * texto pronto) e situacoes diferentes darem textos diferentes.
 */
export function seededRng(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  return () => {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Tempos ----------

export const TIMING = {
  // Ler a mensagem que chegou: base + um pouco por letra, ate o teto.
  readBaseMs: [700, 1800],
  readPerCharMs: 18,
  readMaxMs: 5000,
  // Pensar um instante entre ler e comecar a digitar.
  thinkMs: [300, 1400],
  distractChance: 0.2,
  distractMs: [2000, 9000],
  // Digitar: por letra (faixa), com minimo e teto.
  typePerCharMs: [30, 55],
  typeMinMs: 1400,
  // Resposta a quem esta esperando (robo): nao pode demorar demais.
  typeMaxReplyMs: 9000,
  // Mensagem que o numero puxa (aviso de atraso): pode ser mais lenta.
  typeMaxProactiveMs: 14000,
  // Texto longo: o "digitando…" para no meio (a pessoa parou para pensar).
  pauseAfterChars: 140,
  pauseMs: [500, 1800],
};

/** Quanto tempo "lendo" a mensagem recebida antes de responder. */
export function readingMs(incomingText, rng = defaultRng, t = TIMING) {
  const len = String(incomingText || '').length;
  const base = between(t.readBaseMs[0], t.readBaseMs[1], rng);
  return Math.round(Math.min(t.readMaxMs, base + len * t.readPerCharMs * between(0.7, 1.3, rng)));
}

export function thinkingMs(rng = defaultRng, t = TIMING) {
  // De vez em quando a pessoa se distrai (outra conversa, o celular na mao
  // errada): uns segundos a mais. Sem isso, o tempo de resposta fica
  // "certinho" demais para mensagens iguais.
  const distracted = rng() < t.distractChance ? between(t.distractMs[0], t.distractMs[1], rng) : 0;
  return Math.round(between(t.thinkMs[0], t.thinkMs[1], rng) + distracted);
}

/**
 * O "digitando…" de um texto, em trechos: [{ typeMs, pauseMs }]. Texto curto
 * = um trecho so; texto longo = 2 ou 3 trechos com pausa ("paused") entre
 * eles. A soma dos typeMs respeita o teto.
 */
export function typingPlan(text, { proactive = false, rng = defaultRng, t = TIMING } = {}) {
  const len = Math.max(1, String(text || '').length);
  const perChar = between(t.typePerCharMs[0], t.typePerCharMs[1], rng);
  const cap = proactive ? t.typeMaxProactiveMs : t.typeMaxReplyMs;
  // (o teto tambem varia um pouco: senao todo texto longo daria o mesmo tempo)
  // (o minimo tambem: senao toda resposta curta daria exatamente o minimo)
  const total = Math.round(
    Math.min(jitter(cap, 0.12, rng), Math.max(jitter(t.typeMinMs, 0.3, rng), len * perChar))
  );
  const pieces = len > t.pauseAfterChars * 2 ? (rng() < 0.5 ? 3 : 2) : len > t.pauseAfterChars ? 2 : 1;
  if (pieces === 1) return [{ typeMs: total, pauseMs: 0 }];
  // Divide com pesos aleatorios (nada de partes iguais).
  const weights = Array.from({ length: pieces }, () => between(0.6, 1.4, rng));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w, i) => ({
    typeMs: Math.round((total * w) / sum),
    pauseMs: i < pieces - 1 ? Math.round(between(t.pauseMs[0], t.pauseMs[1], rng)) : 0,
  }));
}

export function planTotalMs(plan) {
  return plan.reduce((sum, step) => sum + step.typeMs + step.pauseMs, 0);
}

// ---------- Textos ----------

/**
 * As frases do robo, cada uma com formas equivalentes. Os numeros das opcoes
 * (1️⃣, 2️⃣...) e as palavras que o robo entende NAO mudam: so o jeito de
 * dizer. Quem mexer aqui: manter o mesmo sentido em todas as formas.
 */
export const PHRASES = {
  // {hi}: "Olá" / "Oi" / "Bom dia"... (o robo devolve o cumprimento que a
  // pessoa usou); {name}: ", Maria" quando o numero e de UMA ficha do cadastro.
  greeting: [
    '{hi}{name}, aqui é da Biblioteca ADMP Brasil. 📚 Como posso ajudar?',
    '{hi}{name}! Aqui é da Biblioteca ADMP Brasil 📚 Em que posso ajudar?',
    '{hi}{name}! Você falou com a Biblioteca ADMP Brasil. 📚 Como posso te ajudar?',
    '{hi}{name}, tudo bem? Aqui é a Biblioteca ADMP Brasil 📚 Como posso ajudar?',
    '{hi}{name}! Biblioteca ADMP Brasil por aqui 📚 O que você precisa?',
    'A paz{name}! Aqui é da Biblioteca ADMP Brasil. 📚 Como posso ajudar?',
  ],
  // O cumprimento curto que abre a PRIMEIRA resposta quando a pessoa ja
  // chegou dizendo o que quer ("oi, queria renovar meu livro").
  helloShort: [
    '{hi}{name}! Aqui é da Biblioteca ADMP Brasil. 📚',
    '{hi}{name}, aqui é da Biblioteca ADMP Brasil 📚',
    '{hi}{name}! Biblioteca ADMP Brasil por aqui 📚',
    '{hi}{name}, tudo bem? Aqui é da Biblioteca ADMP Brasil. 📚',
  ],
  // Resposta da pessoa ao aviso de atraso ("Sim, devolvo domingo").
  noticeAck: [
    'Combinado, obrigado pelo retorno! 🙏',
    'Certo, obrigado por avisar! 📚',
    'Obrigado! Fico no aguardo. 🙏',
  ],
  thanksReply: [
    'De nada! 🙏 Precisando, é só chamar.',
    'Por nada! Qualquer coisa, é só mandar mensagem. 📚',
    'Imagina! Estamos à disposição. 🙏',
    'Disponha! Se precisar de algo, é só escrever.',
    'Nós que agradecemos! Até mais. 📚',
  ],
  audio: [
    'Por aqui eu não consigo ouvir áudio. Pode escrever, por favor? Se preferir, chamo um administrador:',
    'Desculpe, não consigo ouvir áudios por aqui. Consegue mandar por escrito? Ou, se quiser, chamo um administrador:',
    'Ainda não consigo ouvir áudio neste atendimento. Pode digitar a mensagem? Se preferir falar com um administrador:',
  ],
  media: [
    'Recebi, mas por aqui eu só consigo ler mensagens de texto. Se quiser mostrar isso a um administrador:',
    'Chegou aqui, só que neste atendimento eu leio apenas texto. Para um administrador ver, é só escolher:',
    'Recebi o arquivo, mas não consigo abrir por aqui. Quer que um administrador veja?',
  ],
  // Terceiro 'nao entendi' seguido: uma linha so.
  missHint: [
    'Se quiser, é só responder 1️⃣ que eu chamo um administrador.',
    'Se preferir, responda 1️⃣ para falar com um administrador.',
  ],
  // Segundo "não entendi" seguido: em vez de repetir o menu, oferece gente.
  offerAdmin: [
    'Acho que não estou conseguindo te ajudar por aqui. Quer falar com um administrador?',
    'Desculpe, não estou entendendo bem. Prefere que eu chame um administrador?',
    'Não quero te fazer perder tempo: posso chamar um administrador para continuar com você?',
  ],
  optedOut: [
    'Tudo bem, não envio mais avisos por aqui. Se precisar da biblioteca, é só chamar. 🙏',
    'Combinado: você não recebe mais avisos por este número. Quando precisar, é só escrever. 🙏',
    'Certo, parei com os avisos. Se precisar de algo da biblioteca, estamos por aqui.',
  ],
  // Pedido para parar por frase (nao pela palavra exata): o robo confirma.
  confirmStop: [
    'Você quer parar de receber os avisos da biblioteca por aqui?',
    'Só para confirmar: quer deixar de receber os avisos da biblioteca neste número?',
    'Entendi que você não quer mais receber os avisos da biblioteca. É isso?',
  ],
  stopKept: [
    'Certo, continua tudo como está. 🙏',
    'Combinado, os avisos continuam. 🙏',
  ],
  optedIn: [
    'Combinado, você volta a receber os avisos da biblioteca por aqui. 📚',
    'Pronto! Os avisos da biblioteca voltam a chegar por este número.',
  ],
  // Perguntaram se e um robo: a resposta e sempre a verdade.
  botHonest: [
    'Este é o atendimento automático da Biblioteca ADMP Brasil. Consigo ajudar com o catálogo e com os seus empréstimos; se preferir falar com uma pessoa, é só escolher:',
    'Aqui é o atendimento automático da biblioteca (um sistema, não uma pessoa). Se preferir conversar com alguém da equipe:',
    'Sou o atendimento automático da Biblioteca ADMP Brasil. Para falar com uma pessoa da equipe, é só escolher:',
  ],
  borrowHow: [
    'Para pegar um livro, é só escolher no catálogo e tocar em *Solicitar empréstimo*: você informa seu nome e o dia em que quer buscar, e um administrador combina com você por aqui.',
    'É simples: abra o catálogo, escolha o livro e toque em *Solicitar empréstimo*. Você diz seu nome e o dia em que quer buscar, e um administrador combina a retirada por aqui.',
    'Funciona assim: no catálogo, toque no livro que quiser e depois em *Solicitar empréstimo*. Um administrador recebe o pedido e combina a retirada com você por aqui.',
  ],
  bookOne: ['Encontrei no acervo:', 'Achei este no acervo:', 'Temos este no acervo:'],
  bookMany: ['Encontrei estes no acervo:', 'Achei estes no acervo:', 'Olha o que encontrei no acervo:'],
  // A busca aproximada (com erro de digitacao) achou: confere com a pessoa.
  bookApprox: [
    'Não achei exatamente “{query}”, mas encontrei estes no acervo:',
    'Com esse nome não achei; seria algum destes?',
    'Não encontrei “{query}” do jeito que está escrito. Será algum destes?',
  ],
  bookMore: [
    'E há outros parecidos no catálogo.',
    'Há mais resultados no catálogo.',
  ],
  bookHow: [
    'Para pedir, abra o catálogo e toque em *Solicitar empréstimo*:',
    'Dá para pedir pelo catálogo, em *Solicitar empréstimo*:',
    'Se quiser pegar, é só pedir pelo catálogo:',
  ],
  bookNone: [
    'Não encontrei “{query}” no acervo. Pode estar com outro nome; dá para conferir no catálogo:',
    'Procurei por “{query}” e não achei no acervo. Vale conferir no catálogo, pode estar com outro título:',
    'Não achei “{query}” por aqui. O catálogo completo fica neste endereço:',
  ],
  howCanIHelp: [
    'Como posso ajudar?',
    'Em que posso ajudar?',
    'Posso ajudar em mais alguma coisa?',
    'O que você gostaria de fazer?',
    'Como posso te ajudar agora?',
  ],
  replyHint: [
    'Responda com o número da opção.',
    'É só responder com o número da opção.',
    'Digite o número da opção desejada.',
    'Me responda com o número da opção, por favor.',
    'Responda só com o número, por favor.',
  ],
  notUnderstood: [
    'Não entendi. Por favor, selecione uma opção válida.',
    'Desculpe, não consegui entender. Escolha uma das opções, por favor.',
    'Hmm, não entendi. Pode escolher uma das opções abaixo?',
    'Não captei. Responda com uma das opções, por favor.',
    'Desculpe, não entendi bem. Pode responder com o número de uma opção?',
  ],
  backHint: [
    'Digite 0️⃣ para voltar ao menu.',
    'Para voltar ao menu, é só digitar 0️⃣.',
    'Se quiser voltar ao menu, digite 0️⃣.',
    'Digite 0️⃣ quando quiser voltar ao menu.',
  ],
  catalogLink: [
    'Acesse o catálogo da biblioteca:',
    'Aqui está o catálogo da biblioteca:',
    'Você pode ver todos os livros no catálogo:',
    'O catálogo da biblioteca fica neste endereço:',
  ],
  catalogNoLink: [
    'O catálogo da biblioteca está disponível no site da biblioteca.',
    'Você encontra o catálogo no site da biblioteca.',
  ],
  loansTitle: [
    '*Empréstimos*',
    '*Empréstimos* 📚',
    '*Empréstimos* – o que você quer fazer?',
    '*Seus empréstimos*',
    '*Empréstimos* – escolha uma opção:',
  ],
  noRecord: [
    'Não encontramos um cadastro vinculado a este número de WhatsApp.',
    'Não achei nenhum cadastro com este número de WhatsApp.',
    'Este número de WhatsApp não está vinculado a nenhum cadastro da biblioteca.',
  ],
  noLoans: [
    'Você não possui empréstimos ativos no momento.',
    'No momento você não tem nenhum empréstimo ativo.',
    'Não encontrei empréstimos ativos no seu nome agora.',
  ],
  oneLoan: ['Seu empréstimo ativo:', 'Este é o seu empréstimo ativo:', 'Encontrei este empréstimo ativo:'],
  manyLoans: [
    'Seus empréstimos ativos:',
    'Estes são os seus empréstimos ativos:',
    'Encontrei estes empréstimos ativos:',
  ],
  whichLoan: [
    'Qual empréstimo deseja estender?',
    'Qual deles você quer estender?',
    'Qual empréstimo você gostaria de estender?',
  ],
  confirmExtension: [
    'Confirma a extensão?',
    'Posso confirmar a extensão?',
    'Confirma a nova data?',
    'Deseja confirmar a extensão?',
  ],
  extended: [
    'Pronto. A nova data de devolução de {title} é {date}.',
    'Prontinho! {title} agora deve ser devolvido até {date}.',
    'Feito! A devolução de {title} ficou para {date}.',
    'Tudo certo. A nova data de devolução de {title} é {date}.',
  ],
  extensionCancelled: ['Extensão cancelada.', 'Certo, a extensão foi cancelada.', 'Ok, não estendi o prazo.'],
  handoff: [
    'Certo. Sua solicitação foi encaminhada a um administrador, que continuará o atendimento por aqui assim que possível.',
    'Combinado! Já avisei um administrador; ele vai continuar o atendimento por aqui assim que puder.',
    'Certo! Passei sua mensagem para um administrador, que vai te responder por aqui assim que possível.',
    'Tudo bem. Um administrador foi avisado e vai continuar a conversa por aqui assim que possível.',
  ],
  loanGone: ['Este empréstimo não está mais ativo.', 'Esse empréstimo já não está ativo.'],
  loanChanged: [
    'Os dados deste empréstimo acabaram de mudar. Confira novamente.',
    'Esse empréstimo acabou de ser atualizado. Confira de novo, por favor.',
  ],
  requestReceived: [
    'Olá{name}! Recebemos o seu pedido do livro {title}. 📚\n\nVou passar o seu pedido para um de nossos administradores, que entrará em contato com você assim que possível.',
    'Oi{name}! Seu pedido do livro {title} chegou aqui. 📚\n\nJá estou encaminhando para um dos nossos administradores, que vai falar com você assim que possível.',
    'Olá{name}, tudo bem? Recebemos seu pedido de {title} 📚\n\nUm de nossos administradores vai entrar em contato com você em breve para combinar.',
    'Oi{name}! Pedido do livro {title} recebido 📚\n\nVou passar para um administrador, que retorna para você assim que puder.',
  ],
  requestDone: [
    'A sua solicitação do livro {title} já foi registrada pela equipe da biblioteca{pickup}. 📚',
    'Seu pedido de {title} já foi registrado pela equipe da biblioteca{pickup}. 📚',
    'A equipe da biblioteca já registrou o seu pedido de {title}{pickup}. 📚',
  ],
};

/** Uma forma da frase, com {chaves} trocadas pelos valores. */
export function phrase(name, values = {}, rng = defaultRng) {
  const text = pick(PHRASES[name], rng) || '';
  return text.replace(/\{(\w+)\}/g, (_, k) => (values[k] === undefined ? '' : String(values[k])));
}

// ---------- Semelhanca de textos ----------

/** Texto reduzido para comparar: minusculo, sem acento, sem numeros. */
export function normalizeForCompare(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}#\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(text, n = 3) {
  const words = normalizeForCompare(text).split(' ').filter(Boolean);
  const set = new Set();
  if (words.length < n) {
    if (words.length) set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i + n <= words.length; i += 1) set.add(words.slice(i, i + n).join(' '));
  return set;
}

/** Quanto dois textos se parecem (0 = nada, 1 = iguais), por trios de palavras. */
export function similarity(a, b) {
  const x = shingles(a);
  const y = shingles(b);
  if (!x.size && !y.size) return 1;
  let common = 0;
  for (const s of x) if (y.has(s)) common += 1;
  return common / (x.size + y.size - common);
}

/**
 * Entre varios textos possiveis (build(rng) gera um), escolhe o MENOS parecido
 * com os ja enviados recentemente a outras pessoas. Devolve { text, score }.
 */
export function leastSimilar(build, recentTexts, { tries = 8, rng = defaultRng, key = (t) => t } = {}) {
  // key: o que se compara (ex.: o molde do texto, sem nome/titulo/data).
  const others = recentTexts.map(key);
  let best = null;
  for (let i = 0; i < tries; i += 1) {
    const text = build(rng);
    const mine = key(text);
    const score = others.reduce((max, other) => Math.max(max, similarity(mine, other)), 0);
    if (!best || score < best.score) best = { text, score };
    if (score < 0.5) break;
  }
  return best;
}
