import jwt from 'jsonwebtoken';
import { env } from './env';

export type JwtPayload = {
  sub: string;
  username: string;
};

export function signToken(payload: JwtPayload) {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as unknown as number });
}

export function verifyToken(token: string) {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload & { iat: number; exp: number };
}
