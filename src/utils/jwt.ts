import jwt from 'jsonwebtoken';

import { JWT_EXPIRY, JWT_SECRET } from '../constants/environment';

interface TokenPayload {
  userId: string;
  channelUserId: string;
  appName: string;
}

export const generateToken = (payload: TokenPayload): string => (
  jwt.sign(payload, JWT_SECRET!, {
    expiresIn: JWT_EXPIRY || '24h'
  })
);

export const verifyToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, JWT_SECRET!) as TokenPayload;
  } catch (error) {
    throw new Error('Invalid token');
  }
};