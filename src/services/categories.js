/**
 * Categorias dos livros.
 *
 * O acervo e quase todo religioso, entao "Religiao" ou "Literatura" nao
 * ajudam a separar nada. As categorias do app sao temas dentro disso
 * (Lideranca, Oracao, Adoracao, Vida com Deus, Ensinamentos biblicos...).
 *
 * Cada fonte de ISBN devolve a categoria de um jeito:
 * - BrasilAPI: "subjects", lista de textos em portugues e bem genericos
 *   (ex.: "Literatura"). Pode vir vazia, repetida, ou com mais de um assunto
 *   no mesmo texto, separados por ";".
 * - Google Books: "volumeInfo.categories", textos hierarquicos separados por
 *   " / " (ex.: "Religion / Christian Ministry / Leadership"), normalmente em
 *   ingles. E a que traz o tema nos niveis de baixo.
 * - Open Library: "subject" e uma nuvem de dezenas de etiquetas soltas em
 *   varios idiomas ("futurology", "Ingsoc", "Romans"...), sem ordem de
 *   importancia. Nao serve como categoria e por isso nao e usada.
 *
 * Aqui o texto inteiro da fonte (todos os niveis) e comparado com as regras
 * de TEMAS abaixo. A primeira que casar vira a categoria sugerida. Se nada
 * casar e o texto for generico (so "Religiao", "Literatura"...), nao sugere
 * nada e a pessoa escolhe na lista. A sugestao e so um ponto de partida:
 * no cadastro ela sempre pode trocar.
 */
import { normalizeText } from "../models/Book.js";

export const MAX_CATEGORIES = 3;
export const MAX_CATEGORY_LENGTH = 40;

// Temas, em ordem de prioridade (a primeira regra que casar vence).
// Os padroes sao aplicados em minusculas e sem acento, em ingles e portugues.
const THEME_RULES = [
  [/^bibles?\b|^biblias?\b/, "Bíblias"],
  [/juvenile|children|young adult|infantil|juvenil|\bkids\b/, "Infantojuvenil"],
  [/biograph|autobiograph|biografia|testimon/, "Biografias"],
  [/leadership|lideran/, "Liderança"],
  [/prayer|oracao|intercess/, "Oração"],
  [/worship|liturgy|adoracao|louvor|hymn/, "Adoração"],
  [/devotion|devocio/, "Devocionais"],
  [/marriage|parenting|family|famil|casamento|relationship/, "Família e casamento"],
  [/evangel|\bmission|missoes|missao/, "Evangelismo e missões"],
  [/theolog|doctrin|doutrin|apolog/, "Teologia"],
  [/bible|biblical|scripture|biblia|biblic|comment|comentar|testament/, "Ensinamentos bíblicos"],
  [/church|ministry|pastor|igreja|ministerio|disciple|discipul/, "Igreja e ministério"],
  [/christian life|christian living|spiritual|faith|inspirational|vida crista|vida com deus|body, mind/, "Vida com Deus"],
  [/fiction|ficcao|romance|\bnovel/, "Ficção"],
];

// Categorias gerais demais para um acervo religioso: se o texto for so isso,
// nada e sugerido.
const GENERIC = new Set([
  "religion",
  "religiao",
  "christianity",
  "cristianismo",
  "literatura",
  "literature",
  "general",
  "geral",
]);

// Fora dos temas acima, alguns assuntos de nivel mais alto do Google Books
// ainda aparecem em portugues (o resto fica como veio).
const TOP_LEVEL_TO_PT = {
  "self-help": "Autoajuda",
  history: "História",
  education: "Educação",
  philosophy: "Filosofia",
  psychology: "Psicologia",
  music: "Música",
  poetry: "Poesia",
  "business & economics": "Negócios e economia",
  "health & fitness": "Saúde e bem-estar",
  "social science": "Ciências sociais",
  reference: "Referência",
  "study aids": "Material de estudo",
  "language arts & disciplines": "Linguagem e comunicação",
};

// Limpa um nome de categoria: tira espacos sobrando, limita o tamanho,
// passa "TUDO MAIUSCULO" para minusculas e poe a primeira letra em maiuscula.
export function cleanCategoryName(raw) {
  let name = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CATEGORY_LENGTH)
    .trim();
  if (!name) return "";
  if (name.length > 3 && name === name.toUpperCase()) name = name.toLowerCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// Aceita lista (ou texto unico), limpa cada item e tira repetidos
// (sem diferenciar maiuscula/minuscula nem acento).
export function cleanCategoryList(value, max = MAX_CATEGORIES) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const name = cleanCategoryName(item);
    const key = normalizeText(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    result.push(name);
    if (result.length >= max) break;
  }
  return result;
}

// Transforma UM texto de categoria de uma fonte no tema do app, ou "" se nao
// houver nada util para sugerir.
function themeFor(text, keepUnknown) {
  const full = normalizeText(text);
  if (!full) return "";

  for (const [pattern, theme] of THEME_RULES) {
    if (pattern.test(full)) return theme;
  }

  const topLevel = full.split(/[/;]/)[0].trim();
  if (!topLevel || GENERIC.has(topLevel)) return "";
  if (TOP_LEVEL_TO_PT[topLevel]) return TOP_LEVEL_TO_PT[topLevel];
  return keepUnknown ? cleanCategoryName(text.split(/[/;]/)[0]) : "";
}

// Converte o que uma fonte de ISBN devolveu (BrasilAPI ou Google Books) nos
// temas do app. Devolve [] quando a fonte so tem categorias genericas.
// keepUnknown: o que nao casar com nenhum tema e mantido como veio (certo para
// a BrasilAPI, que ja fala portugues); com false e descartado (certo para o
// Google Books, cujos nomes soltos viriam em ingles).
export function categoriesFromProvider(raw, { keepUnknown = true } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const themes = list
    .filter((item) => typeof item === "string")
    .map((item) => themeFor(item, keepUnknown))
    .filter(Boolean);
  return cleanCategoryList(themes);
}
