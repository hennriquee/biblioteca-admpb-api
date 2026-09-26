/**
 * Cria (ou atualiza) o unico usuario do sistema.
 * Rode com:  npm run seed
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import User from '../models/User.js';

async function run() {
  await connectDatabase();

  const username = (process.env.ADMIN_USERNAME || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '@dmpb';

  const passwordHash = await User.hashPassword(password);

  const user = await User.findOneAndUpdate(
    { username },
    { username, passwordHash, name: 'Administrador' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log('Usuario pronto:', user.username);
  console.log('Hash salvo no banco:', user.passwordHash);
  console.log('A senha em texto puro NAO foi gravada em lugar nenhum.');

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((error) => {
  console.error('Falha ao criar o usuario:', error.message);
  process.exit(1);
});
