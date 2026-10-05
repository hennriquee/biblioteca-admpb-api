import { Router } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// POST /api/auth/login  { username, password }
router.post("/login", async (req, res, next) => {
  try {
    const username = String(req.body.username || "")
      .trim()
      .toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Informe usuário e senha." });
    }

    const user = await User.findOne({ username });

    // Mensagem generica de proposito: nao revela se o erro foi no usuario ou na senha.
    if (!user) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    const passwordMatches = await user.checkPassword(password);
    if (!passwordMatches) {
      return res.status(401).json({ error: "Usuário ou senha inválidos." });
    }

    const token = jwt.sign(
      { sub: user._id.toString(), username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "12h" },
    );

    return res.json({
      token,
      user: { id: user._id, username: user.username, name: user.name },
    });
  } catch (error) {
    return next(error);
  }
});

// GET /api/auth/me  -> usado pelo front para saber se o token ainda vale
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select("username name");
    if (!user)
      return res.status(401).json({ error: "Usuário não encontrado." });
    return res.json({ user });
  } catch (error) {
    return next(error);
  }
});

export default router;
