/**
 * Cria (ou atualiza) o PRIMEIRO administrador. Rede de seguranca para quando
 * NINGUEM consegue entrar no painel - no dia a dia, quem da e quem tira acesso
 * e a tela de manutencao (ver src/services/devAccess.js).
 *
 * Rode com:  npm run seed
 *
 * Administrador nao e uma conta separada: e uma pessoa do cadastro que tem
 * login e senha (ver models/Person.js). Por isso o script:
 *  - se o login ja existe, so troca a senha de quem o tem;
 *  - senao, procura UMA pessoa com o nome de ADMIN_NAME. Se houver mais de uma
 *    com esse nome, ele para e nao escolhe no seu lugar: duas pessoas podem ter
 *    o mesmo nome, e dar login e senha para a errada seria dar o painel a ela.
 *
 * Variaveis aceitas no .env: ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_NAME.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDatabase } from '../config/db.js';
import Person from '../models/Person.js';
import { normalizeText } from '../models/Book.js';
import { cleanPersonName, createPerson } from '../services/people.js';
import { readPassword, readUsername, usernameTaken } from '../services/credentials.js';

function stop(message) {
  console.error(message);
  process.exit(1);
}

async function run() {
  // As mesmas regras do resto do sistema: um login que a tela recusaria nao
  // pode entrar por aqui (e ADMIN_USERNAME nunca pode ser o login reservado).
  const login = readUsername(process.env.ADMIN_USERNAME || 'admin');
  if (login.error) stop('ADMIN_USERNAME nao serve: ' + login.error);

  const senha = readPassword(process.env.ADMIN_PASSWORD || '@dmpb');
  if (senha.error) stop('ADMIN_PASSWORD nao serve: ' + senha.error);

  const fullName = cleanPersonName(process.env.ADMIN_NAME) || 'Administrador';

  await connectDatabase();

  let person = await Person.findOne({ username: login.username });
  let created = false;

  if (!person) {
    const sameName = await Person.find({ nameSort: normalizeText(fullName) })
      .sort({ code: 1 })
      .select('code fullName username')
      .lean();

    if (sameName.length > 1) {
      stop(
        'Ha ' +
          sameName.length +
          ' pessoas chamadas "' +
          fullName +
          '" no cadastro (' +
          sameName.map((p) => '#' + p.code).join(', ') +
          '). O script nao escolhe por voce: use a tela de manutencao para dar' +
          ' login e senha a pessoa certa.'
      );
    }

    if (sameName.length === 1) {
      person = await Person.findById(sameName[0]._id);
      if (person.username) {
        stop(
          '#' +
            person.code +
            ' ' +
            person.fullName +
            ' ja entra no painel com o login "' +
            person.username +
            '". Troque a senha dela pela tela de manutencao, ou ajuste' +
            ' ADMIN_USERNAME para esse login.'
        );
      }
    } else {
      person = await createPerson({ fullName });
      created = true;
    }
  }

  // Cinto e suspensorio: o indice do banco ja barraria dois logins iguais,
  // mas aqui o erro vira uma frase em vez de um "E11000" cru.
  if (await usernameTaken(login.username, person._id)) {
    stop('O login "' + login.username + '" ja esta com outra pessoa.');
  }

  person.username = login.username;
  person.passwordHash = await Person.hashPassword(senha.password);
  await person.save();

  console.log('Administrador pronto:', person.username);
  console.log(
    'Ficha da pessoa:',
    '#' + person.code,
    person.fullName,
    created ? '(ficha criada agora)' : '(ficha que ja existia)'
  );
  console.log('A senha em texto puro NAO foi gravada em lugar nenhum: so o hash dela.');
  console.log('Ajuste nome, telefone e foto em Configuracoes > Administradores.');

  await mongoose.connection.close();
  process.exit(0);
}

run().catch((error) => {
  console.error('Falha ao preparar o administrador:', error.message);
  process.exit(1);
});
