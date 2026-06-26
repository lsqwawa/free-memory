import 'dotenv/config';

export const env = {
  APP_PORT: Number(process.env.APP_PORT || 4000),
  DATABASE_URL: process.env.DATABASE_URL || 'postgresql://postgres:xl241216@localhost:5432/FreeMemory?schema=public',
  JWT_SECRET: process.env.JWT_SECRET || 'free-memory-dev-secret',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',
  UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 20),
};
