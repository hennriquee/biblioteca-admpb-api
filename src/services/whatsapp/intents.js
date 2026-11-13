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
// /**
//  * ENTENDIMENTO DE TEXTO LIVRE do atendimento automatico ("modo IA" por
//  * palavras-chave, sem servico externo e sem custo).
//  *
//  * O menu numerado continua valendo; isto aqui e o que deixa a pessoa escrever
//  * do jeito dela ("oi, queria renovar meu livro", "vcs tem o peregrino?",
//  * "obrigada!") e ser entendida, em vez de receber "Nao entendi".
//  *
//  * Como funciona (tudo PURO, sem banco: o robo traz as respostas cadastradas):
//  * - o texto vira palavras sem acento/maiuscula/pontuacao;
//  * - cada assunto tem expressoes; uma expressao "bate" quando TODAS as palavras
//  *   dela aparecem na mensagem - tolerando plural, final diferente
//  *   ("renov*" pega renovar/renovacao) e UM erro de digitacao em palavra
//  *   comprida ("catalago", "enprestimo");
//  * - ganha o assunto com mais pontos; empate = o primeiro da lista (do mais
//  *   serio para o menos: parar avisos > administrador > ...);
//  * - as RESPOSTAS CADASTRADAS no painel (models/WaAnswer.js) concorrem junto e
//  *   ganham no empate (quem cadastrou sabe o que quer);
//  * - "tem o livro X?" vira uma busca no acervo (o robo procura; ver bot.js);
//  * - saudacao, agradecimento e "ok" so contam em mensagem CURTA e sem outro
//  *   assunto ("ok, mas que horas abre?" nao e um "ok").
//  *
//  * Nada aqui decide sozinho coisa seria: estender prazo continua pedindo
//  * confirmacao com 1/0 (bot.js).
//  */
//
// import { normalizeText, normalizeToken, prefixDistance, sound, wordDistance } from './spelling.js';
//
// const KEYCAP = /([0-9])️?⃣/g;
//
// /** Minusculo, sem acento, sem pontuacao; emoji de numero vira o numero. */
// export function fold(text) {
//   return String(text || '')
//     .replace(KEYCAP, '$1')
//     .normalize('NFD')
//     .replace(/[̀-ͯ]/g, '')
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, ' ')
//     .replace(/\s+/g, ' ')
//     .trim();
// }
//
// /**
//  * As palavras da mensagem, prontas para comparar: sem acento, letra esticada
//  * desfeita ("obrigadooo") e abreviacao resolvida ("vc" -> "voce"): ver
//  * spelling.js.
//  */
// export function tokensOf(text) {
//   const value = normalizeText(String(text || '').replace(KEYCAP, '$1'));
//   return value ? value.split(' ') : [];
// }
//
// // Plural simples do portugues (livros -> livro, opcoes -> opcao, bons -> bom).
// function stem(word) {
//   if (word.length <= 4) return word;
//   if (/(oes|aes)$/.test(word)) return word.slice(0, -3) + 'ao';
//   if (/ns$/.test(word)) return word.slice(0, -2) + 'm';
//   if (/[^s]s$/.test(word)) return word.slice(0, -1);
//   return word;
// }
//
// /**
//  * Quanto a palavra da mensagem se afasta da palavra conhecida (0 = a mesma;
//  * Infinity = outra palavra):
//  * - "renov*": comeca com "renov" (com tolerancia a erro no comeco);
//  * - igual depois do plural, ou a conhecida com um finalzinho a mais
//  *   (horario -> horarios, renova -> renovar, abre -> abrem);
//  * - senao, a distancia ponderada de spelling.js (tecla vizinha, troca pelo
//  *   som, letra a menos...), com o teto pelo tamanho da palavra.
//  */
// export function wordScore(token, word) {
//   if (!token || !word) return Infinity;
//   if (word.endsWith('*')) return prefixDistance(token, word.slice(0, -1));
//   if (token === word) return 0;
//   const a = stem(token);
//   const b = stem(word);
//   if (a === b) return 0;
//   if (b.length >= 5 && a.startsWith(b) && a.length - b.length <= 3) return 0;
//   if (b.length === 4 && a.startsWith(b) && a.length - b.length <= 1) return 0;
//   return Math.min(wordDistance(token, word), a !== token || b !== word ? wordDistance(a, b) : Infinity);
// }
//
// /** A palavra da mensagem "e" a palavra conhecida? (ver wordScore) */
// export function sameWord(token, word) {
//   return wordScore(token, word) < Infinity;
// }
//
// /** Todas as palavras da expressao aparecem na mensagem (em qualquer ordem)? */
// export function hasPhrase(tokens, phrase) {
//   const words = Array.isArray(phrase) ? phrase : wordsOf(phrase);
//   if (!words.length) return false;
//   return words.every((word) => tokens.some((token) => sameWord(token, word)));
// }
//
// /** As palavras da expressao aparecem JUNTAS e na ordem (com tolerancia a erro)? */
// export function hasSequence(tokens, phrase) {
//   const words = Array.isArray(phrase) ? phrase : wordsOf(phrase);
//   if (!words.length) return false;
//   for (let i = 0; i + words.length <= tokens.length; i += 1) {
//     if (words.every((word, k) => sameWord(tokens.at(i + k), word))) return true;
//   }
//   return false;
// }
//
// // As palavras de uma expressao ("renov*" continua com o asterisco no fim).
// const compiled = new Map();
// function wordsOf(phrase) {
//   const key = String(phrase);
//   let words = compiled.get(key);
//   if (!words) {
//     words = key
//       .split(/\s+/)
//       .map((word) => (word.endsWith('*') ? normalizeToken(fold(word)) + '*' : normalizeToken(fold(word))))
//       .flatMap((word) => word.split(' '))
//       .filter((word) => word && word !== '*');
//     if (compiled.size < 5000) compiled.set(key, words);
//   }
//   return words;
// }
//
// // ---------- Pedido para PARAR os avisos ----------
// //
// // Fica FORA dos assuntos de fabrica, com regras proprias (achados de tres
// // rodadas de revisao). A pergunta e: a mensagem e SO um pedido para parar?
// //
// // 1. Vocabulario fechado ("exact"): depois de tirar cumprimento e cortesia
// //    (oi, ok, sim, por favor, obrigado...), TODAS as palavras que sobram sao
// //    do vocabulario de parar (parar, me, mandar, mais, nao, mensagem, aviso,
// //    isso, lista, tira...) e ha um verbo de parar (ou "nao" + mandar/enviar/
// //    receber, ou tirar + lista/numero/nome). Pega qualquer ordem e variacao
// //    curta: "para de me mandar mensagem", "Ok, parar", "pfv parem", "nao
// //    manda mais isso nao", "me tira dessa lista". Qualquer palavra de outro
// //    assunto ("Minha filha CHEGA DE viagem e leva esses livros", "Obrigada
// //    pelo lembrete! Vou levar PARA a igreja DE manha") tira a mensagem daqui.
// // 2. Mensagem longa com outro assunto junto: so vale o imperativo com o
// //    objeto IMEDIATAMENTE depois ("pare de mandar essas mensagens, ja
// //    devolvi"), e nunca se o objeto for de audio/foto ("nao me mande mais
// //    mensagem de audio").
// // 3. Pedido menos firme ("phrase"): o robo PERGUNTA. "nao quero (mais)
// //    receber/mensagens..." so com o vocabulario; "quero parar de receber";
// //    "cancelar"/"sair"/"chega" sozinhos; mensagem curta com "parar"/"pare".
// // As palavras sao comparadas SEM tolerancia a erro (so plural; o objeto
// // aceita o mesmo som: "avizos"). Respostas que sao opcoes das perguntas do
// // proprio robo ("Cancelar" na confirmacao) vencem o pedido menos firme
// // (bot.js). Nao depende do modo inteligente (WHATSAPP_BOT_SMART).
//
// const STOP_VERBS = new Set(['parar', 'pare', 'para', 'parem', 'paro', 'stop', 'chega', 'basta', 'descadastrar', 'desinscrever']);
// // Cancelar so e firme com o objeto ("cancelar os avisos"); sem ele, pergunta.
// const STOP_CANCEL = new Set(['cancelar', 'cancela', 'cancele', 'cancelem']);
// const STOP_SEND = new Set(['mandar', 'manda', 'mande', 'mandem', 'enviar', 'envia', 'envie', 'enviem', 'receber', 'recebo', 'mandando', 'enviando']);
// const STOP_REMOVE = new Set(['tira', 'tire', 'tirar', 'remove', 'remova', 'remover', 'sair', 'saia', 'exclui', 'exclua', 'excluir', 'apaga', 'apague', 'apagar']);
// const STOP_PLACE = new Set(['lista', 'listas', 'numero', 'nome', 'contato', 'contatos', 'cadastro']);
// const STOP_OBJECT_WORDS = new Set([
//   'aviso', 'avisos', 'lembrete', 'lembretes', 'cobranca', 'cobrancas', 'notificacao', 'notificacoes',
//   'mensagem', 'mensagens', 'msg', 'msgs',
// ]);
// const STOP_OBJECT_SOUNDS = new Set([...STOP_OBJECT_WORDS].filter((word) => word.length >= 5).map(sound));
// const isObject = (token) => STOP_OBJECT_WORDS.has(token) || STOP_OBJECT_SOUNDS.has(sound(token));
// // O resto do vocabulario de parar (ligacoes, pronomes, determinantes).
// const STOP_GLUE = new Set(
//   ('de me mais nao n com isso isto essa esse essas esses esta este estas estes os as o a do da dos das dessa desse ' +
//     'dessas desses desta deste meu minha meus minhas seu sua seus suas pode podem quero queria favor tudo ' +
//     'nenhuma nenhum nunca agora ja vez mesmo pra para por aqui ai la sim')
//     .split(' ')
// );
// // Cortesia e cumprimento que nao mudam o pedido ("Parar, por favor").
// const STOP_POLITE = new Set(
//   ('por favor pfv pf obrigado obrigada obg oi ola ok okay sim bom boa dia tarde noite irmao irma viu ta ' +
//     'gente pessoal tenho interesse desculpa desculpe')
//     .split(' ')
// );
// // Objeto de outra coisa: "nao me mande mais mensagem de AUDIO".
// const NOT_STOP_QUALIFIERS = new Set(['audio', 'audios', 'foto', 'fotos', 'video', 'videos', 'figurinha', 'figurinhas', 'voz', 'link', 'links']);
// // Imperativos que, numa mensagem com outro assunto, valem com o objeto logo depois.
// const STOP_FIRM = [
//   'pare de mandar', 'para de mandar', 'parem de mandar', 'parar de mandar',
//   'pare de me mandar', 'para de me mandar', 'parem de me mandar',
//   'pare de enviar', 'para de enviar', 'parem de enviar', 'parar de enviar',
//   'pare de me enviar', 'para de me enviar', 'parem de me enviar',
//   'chega de', 'nao mande mais', 'nao mandem mais', 'nao envie mais', 'nao enviem mais',
//   'nao me mande mais', 'nao me mandem mais', 'nao me envie mais', 'nao me enviem mais',
// ];
// const DETERMINERS = new Set(['essas', 'esses', 'estas', 'estes', 'os', 'as', 'mais', 'me', 'tanta', 'tantas', 'tanto', 'tantos', 'suas', 'seus']);
//
// const sameExact = (token, word) => token === word || stem(token) === stem(word);
//
// /** Posicao do fim da sequencia (palavras juntas e na ordem), ou -1. */
// function sequenceEnd(tokens, phrase) {
//   const words = phrase.split(' ');
//   for (let i = 0; i + words.length <= tokens.length; i += 1) {
//     if (words.every((word, k) => sameExact(tokens.at(i + k), word))) return i + words.length;
//   }
//   return -1;
// }
//
// // O objeto vem IMEDIATAMENTE depois (no maximo um determinante no meio:
// // "essas", "os", "me") e nao e de audio/foto.
// function objectRightAfter(tokens, end) {
//   if (end < 0) return false;
//   let i = end;
//   if (DETERMINERS.has(tokens.at(i))) i += 1;
//   if (!isObject(tokens.at(i) || '')) return false;
//   const next = tokens.slice(i + 1, i + 3);
//   return !next.some((token) => NOT_STOP_QUALIFIERS.has(token));
// }
//
// /** "exact", "phrase" ou "" (ver acima). */
// export function detectStop(text) {
//   const tokens = tokensOf(text);
//   if (!tokens.length || tokens.length > 20) return '';
//   const core = tokens.filter((token) => !STOP_POLITE.has(token));
//   if (!core.length) return '';
//   const has = (set) => core.some((token) => set.has(token));
//   const verb = has(STOP_VERBS);
//   const negSend = core.includes('nao') && has(STOP_SEND);
//   const remove = has(STOP_REMOVE) && has(STOP_PLACE);
//   const object = core.some(isObject);
//   const qualified = tokens.some((token) => NOT_STOP_QUALIFIERS.has(token));
//
//   // 1. So o vocabulario de parar.
//   const closed = core.every(
//     (token) =>
//       STOP_VERBS.has(token) ||
//       STOP_CANCEL.has(token) ||
//       STOP_SEND.has(token) ||
//       STOP_REMOVE.has(token) ||
//       STOP_PLACE.has(token) ||
//       STOP_GLUE.has(token) ||
//       isObject(token)
//   );
//   if (closed && !qualified) {
//     // "chega", "basta" sozinhos: as vezes sao outra coisa.
//     const weakAlone = core.length === 1 && ['chega', 'basta'].includes(core[0]);
//     const cancel = has(STOP_CANCEL);
//     if (cancel && object) return 'exact';
//     if ((verb && !weakAlone) || negSend || remove) return 'exact';
//     if (weakAlone || cancel) return 'phrase';
//     // "nao quero mais mensagens", "nao quero mais essas mensagens"
//     if (core.includes('nao') && object) return 'phrase';
//     if (core.length === 1 && STOP_REMOVE.has(core[0])) return 'phrase';
//   }
//   // 2. Com outro assunto junto: imperativo + objeto logo depois.
//   if (STOP_FIRM.some((phrase) => objectRightAfter(tokens, sequenceEnd(tokens, phrase)))) return 'exact';
//   // 3. Menos firme: perguntar.
//   if (['parar de receber', 'deixar de receber', 'quero parar de', 'nao quero receber mais', 'nao quero mais receber'].some((phrase) => sequenceEnd(tokens, phrase) >= 0) && !qualified) {
//     return 'phrase';
//   }
//   if (core.length <= 4 && core.some((token) => ['parar', 'pare', 'parem'].includes(token))) return 'phrase';
//   return '';
// }
//
// // ---------- Assuntos de fabrica ----------
//
// // A ordem e a prioridade no empate.
// const TASKS = [
//   {
//     id: 'resume',
//     decisive: true,
//     exact: ['voltar avisos', 'reativar avisos', 'receber avisos', 'quero receber avisos', 'quero receber os avisos'],
//     // Palavras juntas e na ordem, sempre com o objeto ("quero voltar a receber
//     // o livro" nao e isto), e NUNCA com "nao" na frase ("nao quero mais
//     // receber avisos" e o contrario).
//     ordered: true,
//     negatable: true,
//     strong: [
//       'voltar a receber os avisos',
//       'voltar a receber avisos',
//       'voltar a receber as mensagens',
//       'quero receber os avisos',
//       'quero receber avisos',
//       'pode mandar os avisos',
//       'pode voltar a mandar os avisos',
//       'pode voltar a mandar',
//       'reativar os avisos',
//       'reativar avisos',
//     ],
//   },
//   {
//     id: 'admin',
//     // Chamar uma pessoa avisa o administrador e cala o robo por 24 h: so
//     // com pedido de ATENDIMENTO (detectAdmin): "falar com"/"chamar" seguido
//     // de QUEM atende. "preciso falar com meu marido", "pode chamar meu filho"
//     // e "vou falar com a secretaria e devolvo" nao sao isto.
//     detect: (tokens) => detectAdmin(tokens),
//   },
//   {
//     id: 'bot',
//     // So PERGUNTA sobre quem responde: com "?" ou falando com o numero
//     // ("voce", "isso", "aqui"). A resposta automatica de uma empresa ("Esta e
//     // uma mensagem automatica") nao e pergunta - senao os dois robos
//     // conversariam ate o freio.
//     question: true,
//     strong: [
//       'robo',
//       'bot',
//       'chatbot',
//       'voce e uma pessoa',
//       'isso e uma pessoa',
//       'voce e humano',
//       'isso e humano',
//       'voce humano',
//       'voce e real',
//       'voce e gente',
//       'pessoa de verdade',
//       'pessoa real',
//       'falando com pessoa',
//       'falando com uma pessoa',
//       'falando com robo',
//       'falando com gente',
//       'falando com alguem',
//       'inteligencia artificial',
//       'mensagem automatica',
//       'resposta automatica',
//       'e automatico',
//     ],
//   },
//   {
//     id: 'extend',
//     strong: [
//       'renov*',
//       'prorrog*',
//       'estend*',
//       'extens*',
//       'adiar',
//       'mais tempo',
//       'mais dias',
//       'mais prazo',
//       'aumentar o prazo',
//       'ficar mais',
//     ],
//   },
//   {
//     id: 'borrow',
//     strong: [
//       'como pegar',
//       'como pego',
//       'como faco pegar',
//       'como faz pegar',
//       'como emprestar',
//       'como funciona',
//       'como retiro',
//       'como retirar',
//       'como solicitar',
//       'como solicito',
//       'como peco',
//       'como pedir',
//       'posso pegar',
//       'quero pegar livro',
//       'pegar emprestado',
//       'pegar um livro',
//       'livro emprestado',
//       'fazer emprestimo',
//     ],
//   },
//   {
//     id: 'loans',
//     strong: [
//       'emprestimo*',
//       'meus livros',
//       'livros que peguei',
//       'livro que peguei',
//       'livro comigo',
//       'livros comigo',
//       'quando devolvo',
//       'quando devo devolver',
//       'quando tenho devolver',
//       'que dia devolvo',
//       'data de devolucao',
//       'data da devolucao',
//       'quando vence',
//       'meu prazo',
//       'quando devolucao',
//       'quando devolver',
//       'quando entregar',
//       'dia devolucao',
//       'prazo devolucao',
//       'estou devendo',
//     ],
//     weak: ['prazo', 'devolucao', 'devolver', 'devolvo', 'vence', 'vencimento', 'atrasado', 'atraso'],
//   },
//   {
//     id: 'catalog',
//     strong: [
//       'catalogo',
//       'acervo',
//       'quais livros',
//       'que livros',
//       'lista de livros',
//       'lista dos livros',
//       'livros disponiveis',
//       'ver os livros',
//       'ver livros',
//       'conhecer os livros',
//     ],
//   },
// ];
//
// const GREETING = [
//   'tem alguem ai',
//   'alguem ai',
//   'oi',
//   'oie',
//   'oii',
//   'oiii',
//   'ola',
//   'opa',
//   'eai',
//   'e ai',
//   'bom dia',
//   'boa tarde',
//   'boa noite',
//   'a paz',
//   'paz do senhor',
//   'graca e paz',
//   'hello',
//   'hi',
//   'salve',
// ];
// const THANKS = [
//   'obrigad*',
//   'obg',
//   'brigad*',
//   'valeu',
//   'vlw',
//   'agradec*',
//   'gratidao',
//   'deus abencoe',
//   'deus te abencoe',
//   'deus lhe abencoe',
//   'amem',
//   'tchau',
//   'ate mais',
//   'ate logo',
//   'ate breve',
//   'ate amanha',
//   'fica com deus',
//   'fique com deus',
//   'boa semana',
// ];
// const ACK = [
//   'ok',
//   'okay',
//   'okk',
//   'blz',
//   'beleza',
//   'certo',
//   'entendi',
//   'entendido',
//   'ta bom',
//   'tudo bem',
//   'tudo certo',
//   'ta certo',
//   'show',
//   'perfeito',
//   'otimo',
//   'combinado',
//   'joia',
//   'tranquilo',
//   'sim',
//   'isso',
//   'ata',
//   'ah ta',
//   'legal',
//   'de nada',
//   'pode deixar',
//   'so isso',
//   'era so isso',
//   'e so',
//   'maravilha',
// ];
// // Palavras que acompanham uma saudacao/agradecimento sem mudar o assunto.
// const FILLER = new Set(
//   'tudo bem bom boa como vai voce vc vcs voces ai por favor muito mto mt ta esta tb tambem e a o que irmao irma pastor pastora pessoal gente amigo amiga querido querida viu hein ne pra para mim ja aqui la entao ah eh haha kkk kk rs dia tarde noite paz senhor deus te lhe abencoe fica fique com ate de nada mesmo demais so era isso por enquanto'.split(
//     ' '
//   )
// );
//
// const TIME_HELLO = [
//   { words: 'bom dia', text: 'Bom dia' },
//   { words: 'boa tarde', text: 'Boa tarde' },
//   { words: 'boa noite', text: 'Boa noite' },
// ];
//
// /** "Bom dia"/"Boa tarde"/"Boa noite" se a pessoa cumprimentou assim; senao ''. */
// export function mirroredHello(text) {
//   const tokens = tokensOf(text);
//   const hit = TIME_HELLO.find((item) => hasPhrase(tokens, item.words));
//   return hit ? hit.text : '';
// }
//
// // ---------- "Tem o livro X?" ----------
//
// // sure: a pessoa PERGUNTOU por um livro ("tem o livro X?"); se nao houver,
// // o robo diz que nao achou. As outras formas so valem se a busca achar algo
// // (senao "o livro ta atrasado, posso entregar sexta?" viraria uma busca).
// const BOOK_PATTERNS = [
//   {
//     sure: true,
//     re: /\b(?:tem|teria|teriam|possui|possuem|existe|ha|procuro|procurando|busco|buscando|queria|quero|gostaria|preciso|acho|encontro|sabe se tem|sabem se tem)\b(?: (?:de|do|da|ai|na biblioteca|saber se tem|saber se voces tem|ver se tem|ver se voces tem|voces|vcs|vc|voce|disponivel))*(?: (?:o|a|os|as|um|uma|algum|alguma|esse|este|aquele))?(?: (?:livros?|exemplar(?:es)?|obras?))(?: (?:de|do|da|dos|das|sobre|chamado|chamada|intitulado|com o titulo|com o nome))?\s+(.{2,90})$/,
//   },
//   {
//     sure: true,
//     re: /\b(?:tem|teria|possui|possuem|existe|ha)\b(?: (?:algo|alguma coisa|algum|alguma|livros?|obras?))(?: (?:de|do|da|dos|das|sobre))\s+(.{3,90})$/,
//   },
//   { sure: false, re: /^(?:o |a )?(?:livros?|obras?)(?: (?:de|do|da|dos|das|sobre|chamado|chamada))?\s+(.{3,90})$/ },
//   { sure: false, re: /^(?:o |a )?(.{3,60}?) (?:esta|ta|tem|fica) disponivel\b/ },
//   { sure: false, re: /^(?:voces |vcs |vc |voce |ai |la )*(?:tem|teria|possui|possuem)\s+(?:o |a |os |as |um |uma )?(.{3,60})$/ },
// ];
// // Sobras que nao fazem parte do titulo.
// const QUERY_TAIL =
//   /\b(?:por favor|pfv|pf|por gentileza|ai|na biblioteca|da biblioteca|no acervo|disponivel|disponiveis|para emprestar|para emprestimo|pra emprestar|para pegar|pra pegar|emprestado|voces|vcs|obrigad[oa])\b/g;
// // So com isto, nao e um titulo: e outro assunto ("o livro que peguei").
// const NOT_A_TITLE = new Set(
//   'alguem ninguem gente voces vc voce o a os as um uma de do da dos das que eu meu meus minhas peguei pegou comigo esta ta com atrasado atrasada atraso emprestado emprestimo emprestimos renovar renovacao devolver devolucao prazo novo novos nova novas algum alguma livro livros para pra pegar quero queria e em no na sobre ai la isso esse este aquele mais tempo dias'.split(
//     ' '
//   )
// );
//
// /**
//  * O que a pessoa quer achar no acervo: { query, sure } ou null (a mensagem
//  * nao e uma busca).
//  */
// export function extractBookQuery(text) {
//   // (com as abreviacoes resolvidas: "vcs tem o livro X?")
//   const value = tokensOf(text).join(' ');
//   if (!value || value.length > 160) return null;
//   for (const { re, sure } of BOOK_PATTERNS) {
//     const match = value.match(re);
//     if (!match) continue;
//     const query = match[1].replace(QUERY_TAIL, ' ').replace(/\s+/g, ' ').trim();
//     const words = query.split(' ').filter(Boolean);
//     const useful = words.filter((word) => !NOT_A_TITLE.has(word) && word.length > 1);
//     if (!useful.length || useful.join('').length < 3) continue;
//     if (!sure && words.length > 6) continue;
//     return { query: words.slice(0, 10).join(' '), sure };
//   }
//   return null;
// }
//
// // ---------- A decisao ----------
//
// const ADDRESSING = new Set(['voce', 'voces', 'isso', 'aqui', 'ai']);
//
// // Quem atende (depois de "falar com" / "chamar").
// const ADMIN_TARGETS = new Set(
//   ('alguem pessoa humano humana administrador administradora administradores adm atendente atendentes ' +
//     'secretaria secretario responsavel bibliotecaria bibliotecario voces equipe pastor pastora gente ' +
//     'funcionario funcionaria lider lideranca diacono diaconisa')
//     .split(' ')
// );
// const ADMIN_SKIP = new Set(['o', 'a', 'os', 'as', 'um', 'uma', 'algum', 'alguma', 'com', 'de', 'da', 'do', 'ai', 'la', 'aqui', 'real', 'verdade']);
// // "vou falar com", "ja falei com": relato, nao pedido.
// const ADMIN_REPORT = new Set(['vou', 'vamos', 'irei', 'ja', 'fui', 'falei', 'falou', 'falaram', 'ela', 'ele', 'eles']);
//
// /** A mensagem pede atendimento de uma pessoa da equipe? */
// export function detectAdmin(tokens) {
//   // palavras que so aparecem nesse pedido
//   if (tokens.some((token) => sameWord(token, 'administrador*') || sameWord(token, 'atendente'))) {
//     if (!tokens.some((token) => ['nao'].includes(token))) return true;
//   }
//   if (hasSequence(tokens, 'atendimento humano')) return true;
//   for (let i = 0; i < tokens.length; i += 1) {
//     const token = tokens.at(i);
//     const call = ['chama', 'chame', 'chamar', 'chamem'].includes(token);
//     const talk = sameWord(token, 'falar') && tokens.at(i + 1) === 'com';
//     if (!call && !talk) continue;
//     if (ADMIN_REPORT.has(tokens.at(i - 1) || '') || ADMIN_REPORT.has(tokens.at(i - 2) || '')) continue;
//     if (tokens.at(i - 1) === 'nao' || tokens.at(i - 2) === 'nao') continue;
//     // quem: a primeira palavra que nao e artigo/preposicao depois do verbo
//     const rest = tokens.slice(i + (talk ? 2 : 1)).filter((word) => !ADMIN_SKIP.has(word));
//     if (rest.length && ADMIN_TARGETS.has(rest.at(0))) return true;
//   }
//   return false;
// }
//
// function scoreTask(task, tokens, whole, raw = '') {
//   if (task.exact?.includes(whole)) return 9;
//   if (task.detect) return task.detect(tokens) ? 3 : 0;
//   if (task.question && !raw.includes('?') && !tokens.some((token) => ADDRESSING.has(token))) return 0;
//   if (task.negatable && tokens.includes('nao')) return 0;
//   let strong = 0;
//   const match = task.ordered ? hasSequence : hasPhrase;
//   for (const phrase of task.strong || []) {
//     if (match(tokens, phrase)) strong += 1;
//     if (strong >= 2) break;
//   }
//   let weak = 0;
//   for (const phrase of task.weak || []) if (hasPhrase(tokens, phrase)) weak += 1;
//   return strong * 3 + Math.min(weak, 3);
// }
//
// /** Pontos de uma resposta cadastrada: 3 por palavra-chave (4 se for expressao). */
// export function scoreAnswer(entry, tokens) {
//   let score = 0;
//   let hits = 0;
//   for (const keyword of entry.keywords || []) {
//     const words = tokensOf(keyword);
//     if (!words.length) continue;
//     if (hasPhrase(tokens, words)) {
//       hits += 1;
//       score += words.length > 1 ? 4 : 3;
//     }
//   }
//   return hits ? score + Math.min(hits - 1, 2) : 0;
// }
//
// function social(tokens, whole) {
//   if (!tokens.length || tokens.length > 8) return '';
//   const used = new Set();
//   const mark = (list) => {
//     let found = false;
//     for (const phrase of list) {
//       const words = wordsOf(phrase);
//       if (!words.every((word) => tokens.some((token) => sameWord(token, word)))) continue;
//       found = true;
//       tokens.forEach((token, index) => {
//         if (words.some((word) => sameWord(token, word))) used.add(index);
//       });
//     }
//     return found;
//   };
//   const thanks = mark(THANKS);
//   const greeting = mark(GREETING);
//   const ack = mark(ACK);
//   if (!thanks && !greeting && !ack) return '';
//   // Sobrou assunto de verdade? ("ok, mas que horas abre?")
//   const rest = tokens.filter((token, index) => !used.has(index) && !FILLER.has(token));
//   if (rest.length > 1) return '';
//   if (rest.length === 1 && whole.includes('?')) return '';
//   // "Tudo bem?" / "tudo certo por ai?" com pergunta: e um cumprimento (pede
//   // resposta), nao um "ok".
//   if (!thanks && !greeting && ack && whole.includes('?')) return 'greeting';
//   return thanks ? 'thanks' : greeting ? 'greeting' : 'ack';
// }
//
// const ONLY_SYMBOLS = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{P}\p{S}\s‍️]+$/u;
//
// /**
//  * O que a mensagem quer.
//  * answers: as respostas cadastradas ativas [{ _id, keywords, ... }].
//  * Devolve {
//  *   id: "stop" | "resume" | "bot" | "admin" | "extend" | "borrow" | "loans" |
//  *       "catalog" | "custom" | "greeting" | "thanks" | "ack" | "" (nao entendi),
//  *   kind: "task" | "custom" | "social" | "",
//  *   score, entry (a resposta cadastrada), book (o que procurar no acervo ou ""),
//  *   bookSure (a pessoa perguntou mesmo por um livro: sem achar, o robo diz),
//  *   hello ("Bom dia"... se a pessoa cumprimentou assim)
//  * }
//  */
// export function classify(text, { answers = [] } = {}) {
//   const raw = String(text || '').trim();
//   const hello = mirroredHello(raw);
//   const none = { id: '', kind: '', score: 0, entry: null, book: '', bookSure: false, hello };
//   if (!raw) return none;
//   // So emoji/pontuacao ("👍", "🙏", "!!"): vale como um "ok".
//   if (ONLY_SYMBOLS.test(raw) && !/\d/.test(raw)) return { ...none, id: 'ack', kind: 'social', score: 1 };
//   if (raw.length > 400) return none;
//   const tokens = tokensOf(raw);
//   if (!tokens.length) return none;
//   const whole = tokens.join(' ');
//
//   // Pedido para parar os avisos (ver detectStop): vem antes de tudo.
//   const stop = detectStop(raw);
//   if (stop) return { ...none, id: 'stop', kind: 'task', score: stop === 'exact' ? 9 : 5, stop };
//
//   let best = null;
//   for (const task of TASKS) {
//     const score = scoreTask(task, tokens, whole, raw);
//     if (score < 2) continue;
//     if (task.decisive && score >= 3) return { ...none, id: task.id, kind: 'task', score };
//     if (!best || score > best.score) best = { id: task.id, kind: 'task', score, entry: null };
//   }
//   for (const entry of answers) {
//     const score = scoreAnswer(entry, tokens);
//     if (score < 3) continue;
//     if (!best || score >= best.score) best = { id: 'custom', kind: 'custom', score, entry };
//   }
//
//   const book = extractBookQuery(raw);
//   if (best) {
//     // "quero renovar o livro X" e renovacao, nao busca; so o catalogo cede
//     // a vez para a busca ("que livros de fulano voces tem?").
//     // "o livro O Robo Selvagem esta disponivel?" e busca, nao "e um robo?"
//     if (best.id === 'bot' && book) return { ...none, book: book.query, bookSure: book.sure };
//     const usable = best.id === 'catalog' && book;
//     return { ...none, ...best, book: usable ? book.query : '', bookSure: Boolean(usable && book.sure) };
//   }
//   if (book) return { ...none, book: book.query, bookSure: book.sure };
//
//   const kind = social(tokens, raw);
//   if (kind) return { ...none, id: kind, kind: 'social', score: 1 };
//   return none;
// }
//
// /**
//  * Todas as palavras que o robo conhece (dos assuntos de fabrica e das
//  * conversas sociais), sem repetir. Usado pelo avaliador de grafia.
//  */
// export function knownWords() {
//   const all = new Set();
//   const add = (phrase) => wordsOf(phrase).forEach((word) => all.add(word));
//   for (const task of TASKS) [...(task.exact || []), ...(task.strong || []), ...(task.weak || [])].forEach(add);
//   [...GREETING, ...THANKS, ...ACK].forEach(add);
//   return [...all];
// }
