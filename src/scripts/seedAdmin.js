/**
 * Cria (ou atualiza) a PRIMEIRA conta de administrador.
 * Rode com:  npm run seed
 *
 * Depois disso, as outras contas se cadastram pelo proprio app, em
 * Configuracoes > Administradores. Este script existe para o caso em que
 * ainda nao ha ninguem para entrar no painel.
 *
 * Variaveis aceitas no .env: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_NAME.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import User from '../models/User.js';
import Person from '../models/Person.js';
import { normalizeText } from '../models/Book.js';
import { cleanPersonName, createPerson } from '../services/people.js';

async function run() {
  await connectDatabase();

  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '@dmpb';
  const fullName = cleanPersonName(process.env.ADMIN_NAME) || 'Administrador';

  // O nome e o telefone do administrador ficam no registro de Pessoa (a mesma
  // pessoa que pode pegar livros emprestados). Reaproveita quem ja existe com
  // esse nome em vez de criar um segundo registro para a mesma pessoa.
  const nameSort = normalizeText(fullName);
  let person = await Person.findOne({ nameSort });
  if (!person) person = await createPerson({ fullName });

  const passwordHash = await User.hashPassword(password);
  const user = await User.findOneAndUpdate(
    { username },
    { username, passwordHash, person: person._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('Usuario pronto:', user.username);
  console.log('Nome (pessoa ligada a conta):', person.fullName);
  console.log('Hash salvo no banco:', user.passwordHash);
  console.log('A senha em texto puro NAO foi gravada em lugar nenhum.');
  console.log('Ajuste nome, telefone e foto em Configuracoes > Administradores.');

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((error) => {
  console.error('Falha ao criar o usuario:', error.message);
  process.exit(1);
});
