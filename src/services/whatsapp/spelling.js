/**
 * GRAFIA TOLERANTE para o entendimento de texto livre (intents.js).
 *
 * Quem escreve no WhatsApp erra: tecla vizinha ("livri"), letra a menos
 * ("emprestmo"), troca pelo som ("praso", "orario", "devolussao",
 * "imprestimo"), letra esticada ("obrigadooo", "oiii"), abreviacao ("vc",
 * "q", "hj", "obg") e nunca poe acento. Este arquivo compara uma palavra da
 * mensagem com uma palavra conhecida e diz se "e a mesma", sem confundir
 * palavras de verdade diferentes ("litro" nao e "livro", "prato" nao e
 * "prazo", "para" nao e "parar").
 *
 * Como (tudo puro, sem banco):
 * 1. normalizeToken: sem acento/maiuscula, letra repetida 3+ vezes vira uma
 *    ("oiii" -> "oi", "kkkk" -> "k"), vogal dobrada no fim vira uma
 *    ("obrigadoo"), abreviacao comum vira a palavra ("vc" -> "voce");
 * 2. sound: a mesma palavra "como se fala" (h inicial mudo, ch -> x,
 *    c/ss/z com som de s -> s, qu -> k...), para "orario" = "horario";
 * 3. distance: distancia de edicao PONDERADA - erro "provavel" (tecla
 *    vizinha, troca pelo som, letras trocadas de lugar, letra repetida, h
 *    sobrando) custa 0,5; erro "qualquer" custa 1;
 * 4. o teto depende do TAMANHO da palavra conhecida (TOLERANCE): palavra
 *    curta quase nao aceita erro (sao muitas as palavras curtas parecidas),
 *    palavra longa aceita mais.
 *
 * Os tetos foram calibrados com um conjunto de casos (erros reais de
 * WhatsApp + erros gerados + pares de palavras diferentes que NAO podem
 * bater): ver a documentacao do robo e o avaliador nos testes.
 */

// ---------- 1. Normalizacao ----------

/** Minusculo, sem acento, so letras/numeros/espaco. */
export function foldBasic(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Abreviacoes comuns no WhatsApp (o lado esquerdo ja sem acento). So entram
// as que nao tem outro sentido comum na conversa com a biblioteca.
export const ABBREVIATIONS = {
  vc: 'voce',
  vcs: 'voces',
  voce: 'voce',
  q: 'que',
  pq: 'porque',
  porq: 'porque',
  tb: 'tambem',
  tbm: 'tambem',
  hj: 'hoje',
  amnh: 'amanha',
  amn: 'amanha',
  msg: 'mensagem',
  msgs: 'mensagens',
  qd: 'quando',
  qdo: 'quando',
  qnd: 'quando',
  qndo: 'quando',
  qto: 'quanto',
  qnto: 'quanto',
  td: 'tudo',
  tds: 'todos',
  cmg: 'comigo',
  n: 'nao',
  nn: 'nao',
  naum: 'nao',
  nd: 'nada',
  ngm: 'ninguem',
  mt: 'muito',
  mto: 'muito',
  mta: 'muita',
  pfv: 'por favor',
  pf: 'por favor',
  pfvr: 'por favor',
  obg: 'obrigado',
  obgd: 'obrigado',
  obgda: 'obrigada',
  obgdo: 'obrigado',
  brigado: 'obrigado',
  brigada: 'obrigada',
  vlw: 'valeu',
  blz: 'beleza',
  dps: 'depois',
  agr: 'agora',
  pra: 'para',
  pro: 'para o',
  eh: 'e',
  adm: 'administrador',
  admin: 'administrador',
  adms: 'administradores',
  hr: 'hora',
  hrs: 'horas',
  ctz: 'certeza',
  cad: 'cade',
  bibli: 'biblioteca',
  biblio: 'biblioteca',
  liv: 'livro',
  info: 'informacao',
  infos: 'informacoes',
  oq: 'o que',
  sdds: 'saudades',
  tmj: 'tamo junto',
};

// Palavras que TERMINAM com vogal dobrada de verdade.
const DOUBLE_VOWEL_WORDS = new Set(['voo', 'voos', 'enjoo', 'zoo', 'leem', 'creem', 'veem', 'deem', 'coo']);

/** Uma palavra da mensagem, pronta para comparar (pode virar duas: "pfv"). */
export function normalizeToken(token) {
  let word = String(token || '');
  if (!word) return '';
  // letra esticada: "oiii", "simmm", "obrigadooooo", "kkkk"
  word = word.replace(/([a-z])\1{2,}/g, '$1');
  if (!DOUBLE_VOWEL_WORDS.has(word)) word = word.replace(/([aeiou])\1$/, '$1');
  // (portugues nao termina em consoante dobrada: "bomm", "simm")
  word = word.replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return ABBREVIATIONS[word] ?? word;
}

/** A mensagem inteira: sem acento, letras esticadas e abreviacoes resolvidas. */
export function normalizeText(text) {
  const base = foldBasic(text);
  if (!base) return '';
  return base
    .split(' ')
    .map(normalizeToken)
    .filter(Boolean)
    .join(' ');
}

// ---------- 2. Som ----------

/**
 * A palavra "como se fala" em portugues do Brasil (aproximado). Serve para
 * aceitar troca de letra com o mesmo som; nao e usada sozinha para decidir.
 */
export function sound(word) {
  let w = String(word || '');
  if (!w) return '';
  w = w
    .replace(/^h/, '')
    .replace(/ph/g, 'f')
    .replace(/ch/g, 'x')
    .replace(/sh/g, 'x')
    .replace(/lh/g, 'li')
    .replace(/nh/g, 'ni')
    .replace(/qu(?=[ei])/g, 'k')
    .replace(/gu(?=[ei])/g, 'g')
    .replace(/sc(?=[ei])/g, 's')
    .replace(/xc(?=[ei])/g, 's')
    .replace(/c(?=[ei])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/ss/g, 's')
    .replace(/rr/g, 'r')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i')
    .replace(/h/g, '')
    // vogal atona do fim: "u"/"o" e "i"/"e" soam igual (obrigadu, atendenti)
    .replace(/u$/, 'o')
    .replace(/i$/, 'e')
    // "-am" e "-ao" no fim (falaram/falarao) ficam de fora de proposito
    .replace(/([a-z])\1+/g, '$1');
  return w;
}

// ---------- 3. Distancia ponderada ----------

const ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const KEY_POS = new Map();
ROWS.forEach((row, r) => [...row].forEach((ch, c) => KEY_POS.set(ch, [r, c + r * 0.5])));

function adjacentKeys(a, b) {
  const pa = KEY_POS.get(a);
  const pb = KEY_POS.get(b);
  if (!pa || !pb) return false;
  return Math.abs(pa[0] - pb[0]) <= 1 && Math.abs(pa[1] - pb[1]) <= 1;
}

// Trocas pelo som (sem acento): s/z/c/k, i/e, o/u, g/j, x/s, m/n.
// (guardados em ordem alfabetica: "ei", e nao "ie")
const pairKey = (a, b) => (a < b ? a + b : b + a);
const SOUND_PAIRS = new Set(
  [['s', 'z'], ['s', 'c'], ['c', 'k'], ['k', 'q'], ['c', 'q'], ['i', 'e'], ['o', 'u'], ['g', 'j'], ['x', 's'], ['x', 'z'], ['m', 'n'], ['k', 's']].map(
    ([a, b]) => pairKey(a, b)
  )
);
function soundAlike(a, b) {
  return SOUND_PAIRS.has(pairKey(a, b));
}
const VOWELS = 'aeiou';

// Troca por uma letra QUALQUER (nem vizinha nem pelo som) custa mais que uma
// letra a menos: e assim que palavras de verdade diferentes se parecem
// (estender/entender, acervo/acerto, revolver/devolver). Vogal por vogal fica
// no meio ("catalago", "devolucai"): erro comum de quem escreve pelo som.
function subCost(a, b) {
  if (a === b) return 0;
  if (adjacentKeys(a, b) || soundAlike(a, b)) return 0.5;
  if (VOWELS.includes(a) && VOWELS.includes(b)) return 0.75;
  return 1.25;
}

// Letra a mais (ou a menos) que e "provavel": repetida ("livvro"), h
// sobrando/faltando, u depois de q/g ("qe" / "que").
function gapCost(word, i) {
  const ch = word[i];
  if (ch === 'h') return 0.5;
  if (i > 0 && word[i - 1] === ch) return 0.5;
  if (i + 1 < word.length && word[i + 1] === ch) return 0.5;
  if (ch === 'u' && i > 0 && (word[i - 1] === 'q' || word[i - 1] === 'g')) return 0.5;
  return 1;
}

/**
 * Distancia ponderada entre a palavra digitada (a) e a conhecida (b),
 * parando cedo quando passa de max (devolve Infinity).
 */
export function distance(a, b, max = Infinity) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max * 2) return Infinity;
  const n = a.length;
  const m = b.length;
  let older = null;
  let previousBest = 0;
  let previous = new Array(m + 1);
  previous[0] = 0;
  for (let j = 1; j <= m; j += 1) previous[j] = previous[j - 1] + gapCost(b, j - 1);
  for (let i = 1; i <= n; i += 1) {
    const current = new Array(m + 1);
    current[0] = previous[0] + gapCost(a, i - 1);
    let best = current[0];
    for (let j = 1; j <= m; j += 1) {
      let value = Math.min(
        previous[j] + gapCost(a, i - 1), // letra a mais na digitada
        current[j - 1] + gapCost(b, j - 1), // letra a menos na digitada
        previous[j - 1] + subCost(a[i - 1], b[j - 1])
      );
      // duas letras trocadas de lugar ("lviro")
      if (older && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, older[j - 2] + 0.5);
      }
      current[j] = value;
      if (value < best) best = value;
    }
    // (so desiste quando as DUAS ultimas linhas passaram do teto: a troca de
    // lugar pula uma linha - "livor" so fica barato na linha seguinte)
    if (best > max && previousBest > max) return Infinity;
    previousBest = best;
    older = previous;
    previous = current;
  }
  return previous[m] <= max ? previous[m] : Infinity;
}

// ---------- 4. O teto por tamanho (calibrado) ----------

/**
 * Quanto erro se aceita numa palavra conhecida deste tamanho, e se a
 * primeira letra precisa bater. (Erro na primeira letra e raro; em palavra
 * curta, e quase sempre OUTRA palavra.)
 */
export const TOLERANCE = [
  { upTo: 3, max: 0, sameStart: true },
  { upTo: 5, max: 0.5, sameStart: true },
  { upTo: 9, max: 1, sameStart: true },
  { upTo: Infinity, max: 2, sameStart: true },
];
// Prefixo ("renov*", "estend*"): o comeco da palavra pesa mais (entender nao
// e estender), entao o teto e menor.
export const PREFIX_TOLERANCE = [
  { upTo: 7, max: 0.5 },
  { upTo: Infinity, max: 1 },
];

export function toleranceFor(length) {
  return TOLERANCE.find((t) => length <= t.upTo);
}

function startsAlike(a, b) {
  if (a[0] === b[0]) return true;
  // h mudo no comeco ("orario"/"horario")
  const x = a.replace(/^h/, '');
  const y = b.replace(/^h/, '');
  if (!x || !y) return false;
  if (x[0] === y[0]) return true;
  // pelo som: "imprestimo"/"emprestimo", "kando"/"quando", "sedo"/"cedo"
  return soundAlike(x[0], y[0]);
}

/**
 * Quanto a palavra digitada se afasta da conhecida, ou Infinity se nao e a
 * mesma. As duas ja normalizadas (normalizeToken). 0 = igual.
 */
export function wordDistance(typed, known) {
  if (!typed || !known) return Infinity;
  if (typed === known) return 0;
  const rule = toleranceFor(known.length);
  if (rule.max === 0) return Infinity;
  if (rule.sameStart && !startsAlike(typed, known)) return Infinity;
  const direct = distance(typed, known, rule.max);
  if (direct === 0) return 0;
  // mesmo som: "orario" / "horario", "praso" / "prazo" (vale meio erro)
  const st = sound(typed);
  const sk = sound(known);
  if (st && st === sk && Math.min(typed.length, known.length) >= 4) return Math.min(direct, 0.5);
  const bySound = st && sk ? distance(st, sk, rule.max - 0.5) + 0.5 : Infinity;
  return Math.min(direct, bySound);
}

/**
 * A palavra digitada COMECA com o prefixo conhecido ("renov*", "emprest*"),
 * aceitando erro no prefixo? Devolve a distancia ou Infinity.
 */
export function prefixDistance(typed, prefix) {
  if (!typed || !prefix) return Infinity;
  if (typed.startsWith(prefix)) return 0;
  if (prefix.length < 5 || typed.length < prefix.length - 1) return Infinity;
  if (!startsAlike(typed, prefix)) return Infinity;
  const max = PREFIX_TOLERANCE.find((t) => prefix.length <= t.upTo).max;
  let best = Infinity;
  for (let cut = prefix.length - 1; cut <= Math.min(typed.length, prefix.length + 1); cut += 1) {
    best = Math.min(best, distance(typed.slice(0, cut), prefix, max));
  }
  return best;
}
