/**
 * Datas pelo dia de Brasilia ("AAAA-MM-DD"). Usadas pelas regras de prazo e de
 * cobranca dos emprestimos (routes/loans.js e services/charges.js).
 */

export function todayInBrazil() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/Sao_Paulo',
  });
}

// O dia ("AAAA-MM-DD") de uma data salva, do mesmo jeito que o app mostra
// (utils/dates.js no front): meia-noite UTC e "so a data" (e assim que as
// datas dos campos chegam aqui); o resto vale pelo dia de Brasilia.
export function dayOf(date) {
  if (!date) return '';
  const value = new Date(date);
  if (
    value.getUTCHours() === 0 &&
    value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 &&
    value.getUTCMilliseconds() === 0
  ) {
    return value.toISOString().slice(0, 10);
  }
  return value.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

// O dia de Brasilia de um MOMENTO (ex.: quando cobrou).
export function brazilDay(date) {
  return new Date(date).toLocaleDateString('en-CA', {
    timeZone: 'America/Sao_Paulo',
  });
}

export function addDays(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function brDate(day) {
  const [year, month, date] = day.split('-');
  return date + '/' + month + '/' + year;
}
