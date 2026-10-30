/**
 * Busca por PALAVRAS: cada palavra digitada precisa aparecer no texto, em
 * qualquer ordem e em qualquer ponto. Assim "Maria Alessandra Dias" acha
 * "Maria Alessandra Arantes Dias" (pulou um sobrenome) e "senhor aneis" acha
 * "O Senhor dos Anéis". Tudo o que a busca antiga (o texto inteiro, junto)
 * achava continua sendo achado.
 *
 * A mesma regra roda no navegador (frontend/src/utils/bookFilter.js), para o
 * filtro local dar o mesmo resultado que a API.
 */

export function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Teto da busca: ninguem digita mais que isso num nome ou titulo, e um termo
// gigante (milhares de palavras) faria o regex estourar o limite do banco.
const MAX_TERM_LENGTH = 200;
const MAX_WORDS = 12;

// As palavras de um termo JA normalizado (minusculo, sem acento), sem
// repetidas e dentro do teto.
export function searchWords(term) {
  const words = String(term || "")
    .slice(0, MAX_TERM_LENGTH)
    .split(/\s+/)
    .filter(Boolean);
  return [...new Set(words)].slice(0, MAX_WORDS);
}

/**
 * Quao bem o texto bate com o termo (os dois normalizados). Menor = melhor:
 *   0 nome igual ao digitado | 1 comeca com o digitado | 2 tem o digitado
 *   junto (a busca antiga) | 3 cada palavra no comeco de uma palavra |
 *   4 o resto (palavra dentro de outra: "ana" em "Mariana").
 * Serve para a lista curta de sugestoes (10): com a busca por palavras mais
 * ampla, a "Maria Silva" digitada inteira precisa vir antes das doze
 * "Maria ... da Silva", senao ficava de fora da lista.
 * (A mesma regra existe no navegador: frontend/src/utils/bookFilter.js.)
 */
export function matchRank(text, term) {
  const words = searchWords(term);
  const joined = words.join(" ");
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!joined) return 4;
  if (value === joined) return 0;
  if (value.startsWith(joined)) return 1;
  if (value.includes(joined)) return 2;
  const tokens = value.split(/[\s'’.-]+/);
  if (words.every((word) => tokens.some((token) => token.startsWith(word)))) {
    return 3;
  }
  return 4;
}

// Os autores sao guardados com acento ("João"), mas a busca chega sem
// ("joao"). Cada letra com variantes vira uma classe: "j[oòóôõö]..." .
const ACCENT_VARIANTS = {
  a: "aàáâãäå",
  c: "cç",
  e: "eèéêë",
  i: "iìíîï",
  n: "nñ",
  o: "oòóôõö",
  u: "uùúûü",
  y: "yýÿ",
};

export function accentInsensitive(term) {
  return [...term]
    .map((char) =>
      ACCENT_VARIANTS[char]
        ? "[" + ACCENT_VARIANTS[char] + "]"
        : escapeRegex(char),
    )
    .join("");
}

/**
 * Um regex que so bate quando o texto tem TODAS as palavras (uma
 * "olhada adiante" por palavra). Num campo que e lista (autores), o Mongo
 * confere item a item: as palavras precisam estar no MESMO autor.
 * - accents: o campo guarda acento (autores); o termo nunca tem.
 */
export function allWordsRegex(term, { accents = false } = {}) {
  const words = searchWords(term);
  const piece = accents ? accentInsensitive : escapeRegex;
  return new RegExp(
    "^" + words.map((word) => "(?=[\\s\\S]*" + piece(word) + ")").join(""),
    "i",
  );
}
