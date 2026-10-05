import mongoose from 'mongoose';

export async function connectDatabase() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error('A variável MONGODB_URI não foi definida no arquivo .env');
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('Conectado ao MongoDB Atlas.');
  return mongoose.connection;
}
