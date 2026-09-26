import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    // Nunca guardamos a senha em texto puro, apenas o hash dela.
    passwordHash: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      default: 'Administrador',
    },
  },
  { timestamps: true }
);

// Gera o hash a partir da senha em texto puro.
userSchema.statics.hashPassword = async function hashPassword(plainPassword) {
  const saltRounds = 12;
  return bcrypt.hash(plainPassword, saltRounds);
};

// Compara a senha digitada com o hash salvo no banco.
userSchema.methods.checkPassword = function checkPassword(plainPassword) {
  return bcrypt.compare(plainPassword, this.passwordHash);
};

export default mongoose.model('User', userSchema);
