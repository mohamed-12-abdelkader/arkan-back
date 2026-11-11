import express, { Request } from 'express';
import { config, loggerMiddleware, UPLOADS_ROOT } from './utils';
import { errorHandlerMiddleware } from './middleware/errorHandler';
import cors, { CorsOptionsDelegate } from 'cors';
import { router } from './routes';

const allowedOrigins = config.CORS_ORIGIN.split(',').map((origin) => origin.trim());

const corsOptionsDelegate: CorsOptionsDelegate<Request> = (req, callback) => {
  const requestOrigin = req.header('Origin') || '';
  const allow =
    allowedOrigins.includes('*') || allowedOrigins.includes(requestOrigin);
  callback(null, {
    origin: allow,
    credentials: true,
  });
};

export const app = express();

app.use(
  express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      // Needed to verify HMAC signatures on inbound WhatsApp webhooks.
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cors(corsOptionsDelegate));
app.use(loggerMiddleware);

// Serve locally stored uploads (product images, etc.)
app.use('/uploads', express.static(UPLOADS_ROOT));

// Routes (v1 + legacy alias)
app.use('/api/v1', router);
app.use('/api', router);

app.use(errorHandlerMiddleware);
