import {
  API_PREFIX,
  DEPENDENCY_CHECK_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
} from './config/constants.js';
import { env } from './config/env.js';
import { createApp } from './app.js';
import { disconnectPrisma, pingDatabase } from './database/prisma.js';
import { logger } from './lib/logger.js';
import { connectRedis, disconnectRedis } from './lib/redis.js';
import { startAttemptExpiryWorker } from './modules/assessments/expiry-worker.js';
import {
  settleQuizCertificateDispatch,
  startQuizCertificateWorker,
} from './modules/academy-quizzes/quiz-certificates.worker.js';
import {
  settleNotificationDispatch,
  startNotificationEmailWorker,
} from './modules/notifications/dispatcher.js';
import { startPaymentReconciliationWorker } from './modules/payments/worker.js';
import { withTimeout } from './utils/with-timeout.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    `ASRA Academy API listening on http://localhost:${env.PORT}${API_PREFIX} (${env.NODE_ENV})`,
  );
});

server.on('error', (error) => {
  logger.fatal({ err: error }, 'HTTP server failed to start');
  process.exit(1);
});

/**
 * Verify PostgreSQL once at startup so a misconfiguration is visible immediately. The API keeps
 * running if it fails (Neon may be waking from scale-to-zero; Docker may still be starting):
 * liveness stays green, readiness (`/health/ready`) reports the database as down, and requests
 * that need the database return 503 until it is reachable. Migrations are never run here.
 */
async function verifyDatabase(): Promise<void> {
  try {
    await withTimeout(pingDatabase(), DEPENDENCY_CHECK_TIMEOUT_MS * 5, 'PostgreSQL');
    logger.info('PostgreSQL connected');
  } catch (error) {
    // Log the error class/code only — driver messages can contain host names.
    const { name, code } = error as { name?: string; code?: string };
    logger.error(
      { errorName: name, errorCode: code },
      'PostgreSQL unreachable at startup — check DATABASE_URL and that the database is running',
    );
  }
}

void verifyDatabase();
void connectRedis();

// Finalizes exam/quiz attempts whose deadline passed while nobody was online (PHASE 09).
const stopExpiryWorker = startAttemptExpiryWorker();
// Re-checks unsettled orders/refunds and unsent payment emails (PHASE 10, docs/PAYMENTS.md §10).
const stopPaymentWorker = startPaymentReconciliationWorker();
// Retries notification emails that could not be sent right after their event (PHASE 11).
const stopNotificationWorker = startNotificationEmailWorker();
// Processes bulk quiz certificate generation and email delivery batches.
const stopQuizCertificateWorker = startQuizCertificateWorker();

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  stopExpiryWorker();
  stopPaymentWorker();
  stopNotificationWorker();
  stopQuizCertificateWorker();
  try {
    // Stop accepting new connections, let in-flight requests finish, then drop idle keep-alives.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeIdleConnections();
    });
    // Emails and certificate batches already handed to dispatchers finish (or stay PENDING for next start).
    await Promise.allSettled([settleNotificationDispatch(), settleQuizCertificateDispatch()]);
    await Promise.allSettled([disconnectPrisma(), disconnectRedis()]);
    logger.info('Shutdown complete');
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
