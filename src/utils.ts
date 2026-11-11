import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import { bool, cleanEnv, num, port, str, testOnly } from 'envalid';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { NextFunction, RequestHandler, Request, Response } from 'express';
import { User } from './db/types';
import { Pool } from 'pg';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'node:fs';
import util from 'node:util';
import path from 'node:path';

// Utils functions
export const asyncWrapper = (fn: RequestHandler) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Logger
export const logger = pino({
  redact: ['req.headers.authorization', 'req.headers.cookie'],
});

export const loggerMiddleware = pinoHttp({
  logger: logger.child({ category: 'HttpEvent' }),
  genReqId: function (req, res) {
    const id = randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel: function (req, res, err) {
    if (res.statusCode >= 400 && res.statusCode < 500) {
      return 'warn';
    } else if (res.statusCode >= 500 || err) {
      return 'error';
    }
    return 'info';
  },
  quietReqLogger: true,
});

export class HttpError extends Error {
  readonly status: number;
  readonly message: string;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.message = message;
  }
}

// Config
export const config = cleanEnv(process.env, {
  NODE_ENV: str({ devDefault: testOnly('test'), choices: ['development', 'production', 'test'] }),
  CORS_ORIGIN: str(),
  FRONTEND_HOST: str(),
  SECRET_KEY: str({ devDefault: testOnly(crypto.randomBytes(32).toString('hex')) }),
  ACCESS_TOKEN_EXPIRE_MINUTES: num({ default: 60 * 24 }), // 24 hours
  REFRESH_TOKEN_EXPIRE_DAYS: num({ default: 30 }),
  COMMON_TOKEN_EXPIRE_HOURS: num({ default: 8 }),

  // Database
  DATABASE_URL: str(),

  // First Superuser
  FIRST_SUPERUSER: str({ default: undefined }),
  FIRST_SUPERUSER_PASSWORD: str({ default: undefined }),

  // Emails
  SMTP_HOST: str({ default: undefined }),
  SMTP_USER: str({ default: undefined }),
  SMTP_PASSWORD: str({ default: undefined }),
  SMTP_PORT: port({ default: 587 }),
  SMTP_TLS: bool({ default: true }),
  SMTP_SSL: bool({ default: false }),
  EMAILS_FROM_EMAIL: str({ default: undefined }),
  EMAILS_FROM_NAME: str({ default: undefined }),

  // CDN
  CLOUDINARY_URL: str(),

  // AI Sales Assistant (DeepSeek — OpenAI-compatible)
  DEEPSEEK_API_KEY: str({ default: '' }),
  DEEPSEEK_BASE_URL: str({ default: 'https://api.deepseek.com' }),
  DEEPSEEK_MODEL: str({ default: 'deepseek-chat' }),

  // WhatsApp gateway (same pattern as glassShop)
  WHATSAPP_GATEWAY_URL: str({ default: '' }),
  WHATSAPP_API_KEY: str({ default: '' }),
  WHATSAPP_WEBHOOK_SECRET: str({ default: '' }),

  // Paymob — نفس أسلوب glassShop: Integration ID رقمي + unified checkout
  PAYMOB_SECRET_KEY: str({ default: '' }),
  PAYMOB_PUBLIC_KEY: str({ default: '' }),
  PAYMOB_HMAC: str({ default: '' }),
  PAYMOB_API_KEY: str({ default: '' }),
  PAYMOB_INTEGRATION_ID: str({ default: '' }),
  PAYMOB_BASE_URL: str({ default: 'https://ksa.paymob.com' }),
  PAYMOB_COUNTRY: str({ default: 'SA' }),
  PAYMOB_CURRENCY: str({ default: 'SAR' }),
  PAYMOB_NOTIFICATION_URL: str({ default: '' }),
  PAYMOB_REDIRECTION_URL: str({ default: '' }),

  // Tamara BNPL — https://docs.tamara.co/ (fill from Partners Portal / email)
  TAMARA_API_TOKEN: str({ default: '' }),
  TAMARA_NOTIFICATION_TOKEN: str({ default: '' }),
  TAMARA_PUBLIC_KEY: str({ default: '' }),
  TAMARA_API_URL: str({ default: 'https://api-sandbox.tamara.co' }),
  TAMARA_COUNTRY_CODE: str({ default: 'SA' }),
  TAMARA_CURRENCY: str({ default: 'SAR' }),
  TAMARA_PAYMENT_TYPE: str({ default: 'PAY_BY_INSTALMENTS' }),
  TAMARA_INSTALMENTS: str({ default: '3' }),
  TAMARA_LOCALE: str({ default: 'ar_SA' }),
  TAMARA_SUCCESS_URL: str({ default: '' }),
  TAMARA_FAILURE_URL: str({ default: '' }),
  TAMARA_CANCEL_URL: str({ default: '' }),
});

// Security
export async function generateToken(user: User, pool: Pool): Promise<string> {
  const { accessToken } = await issueTokenPair(user, pool);
  return accessToken;
}

export async function issueTokenPair(
  user: User,
  db: Pool,
  deviceInfo?: string,
): Promise<{ accessToken: string; refreshToken: string; jti: string }> {
  const jti = crypto.randomUUID();
  await db.query('UPDATE users SET jti = $1, last_login_at = NOW(), failed_login_attempts = 0 WHERE id = $2', [
    jti,
    user.id,
  ]);

  const accessToken = jwt.sign(
    { id: user.id, email: user.email, role: user.role, jti, typ: 'access' },
    config.SECRET_KEY,
    { expiresIn: `${config.ACCESS_TOKEN_EXPIRE_MINUTES}m` },
  );

  const refreshToken = crypto.randomBytes(48).toString('hex');
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(
    Date.now() + config.REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60 * 1000,
  );

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [user.id, refreshHash, deviceInfo ?? null, expiresAt],
  );

  return { accessToken, refreshToken, jti };
}

export const verifyToken = (token: string) => jwt.verify(token, config.SECRET_KEY);

// Emails
const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  auth: {
    user: config.SMTP_USER,
    pass: config.SMTP_PASSWORD,
  },
});

export async function sendEmail(to: string, subject: string, html: string) {
  await transporter.sendMail({
    from: config.EMAILS_FROM_NAME || 'Arkan Store',
    to,
    subject,
    html,
  });
}

// Upload
const uploadsRoot = path.join(__dirname, '../../uploads');

function makeDiskStorage(subdir: string) {
  return multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(uploadsRoot, subdir);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-()+ ]/g, '_');
      cb(null, `${Date.now()}-${safe}`);
    },
  });
}

const fileFilter = (_req: any, file: any, cb: any) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed'), false);
};

export const upload = multer({
  storage: makeDiskStorage('avatars'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

/** Product images — pick from device, stored under /uploads/products */
export const uploadProductImages = multer({
  storage: makeDiskStorage('products'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024, files: 10 },
}).array('images', 10);

/** Brand logo — single image under /uploads/brands */
export const uploadBrandLogo = multer({
  storage: makeDiskStorage('brands'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('logo');

/** Category image — single image under /uploads/categories */
export const uploadCategoryImage = multer({
  storage: makeDiskStorage('categories'),
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('image');

export const UPLOADS_ROOT = uploadsRoot;

/** Public URL path for a saved file under uploads/ */
export function publicUploadPath(subdir: string, filename: string) {
  return `/uploads/${subdir}/${filename}`;
}

const unlinkFile = util.promisify(fs.unlink);

cloudinary.config();

export const uploadToCloudinary = async (filePath: string) => {
  const result = await cloudinary.uploader.upload(filePath, {
    folder: 'media',
  });
  await unlinkFile(filePath);
  return result;
};
