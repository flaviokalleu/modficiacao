import gracefulShutdown from "http-graceful-shutdown";
import app from "./app";
import { initIO } from "./libs/socket";
import { logger } from "./utils/logger";
import { StartAllWhatsAppsSessions } from "./services/WbotServices/StartAllWhatsAppsSessions";
import Company from "./models/Company";
import { startQueueProcess } from "./queues";
import { TransferTicketQueue } from "./wbotTransferTicketQueue";
import cron from "node-cron";

// Configuração do servidor com rate limiting e timeout
const server = app.listen(process.env.PORT);

// Gerenciamento de sessões em lotes
async function initializeSessions() {
  try {
    const companies = await Company.findAll();
    const batchSize = 5; // Processa 5 empresas por vez
    
    for (let i = 0; i < companies.length; i += batchSize) {
      const batch = companies.slice(i, i + batchSize);
      await Promise.all(batch.map(c => StartAllWhatsAppsSessions(c.id)));
      
      // Pequena pausa entre lotes para evitar sobrecarga
      if (i + batchSize < companies.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    startQueueProcess();
    logger.info(`Server started on port: ${process.env.PORT}`);
  } catch (error) {
    logger.error("Error starting server:", error);
    process.exit(1);
  }
}

// Tratamento de erros com retry
const errorHandler = (type, error) => {
  logger.error(`${new Date().toUTCString()} ${type}:`, error);
  // Implementar lógica de retry se necessário
};

process.on("uncaughtException", err => errorHandler("uncaughtException", err));
process.on("unhandledRejection", (reason, p) => errorHandler("unhandledRejection", reason));

// Otimização do cron job
const transferTicketJob = cron.schedule("*/5 * * * *", async () => {
  try {
    const timeout = setTimeout(() => {
      logger.warn("Transfer ticket job timed out");
      transferTicketJob.stop();
    }, 60000); // 1 minuto timeout

    await TransferTicketQueue();
    clearTimeout(timeout);
  } catch (error) {
    logger.error("Error in transfer ticket job:", error);
  }
}, {
  scheduled: false
});

transferTicketJob.start();

initIO(server);
initializeSessions();

// Graceful shutdown otimizado
gracefulShutdown(server, {
  signals: "SIGINT SIGTERM",
  timeout: 30000,
  development: process.env.NODE_ENV !== "production",
  onShutdown: async () => {
    transferTicketJob.stop();
    logger.info("Shutting down services...");
  },
  finally: () => logger.info("Shutdown complete")
});