/**
 * Gateway IPC Handlers
 * Provides ORPC handlers for controlling the API Gateway service (NestJS version)
 */
import { bootstrapNestServer, stopNestServer, getNestServerStatus } from '../../server/main';
import { ConfigManager } from '../config/manager';
import { v4 as uuidv4 } from 'uuid';

/**
 * Start the gateway server (NestJS)
 */
export const startGateway = async (port: number): Promise<boolean> => {
  try {
    // Stop if already running
    await stopNestServer();
    // Start NestJS server
    return await bootstrapNestServer(port);
  } catch (e) {
    console.error('Failed to start gateway:', e);
    return false;
  }
};

/**
 * Stop the gateway server (NestJS)
 */
export const stopGateway = async (): Promise<boolean> => {
  try {
    return await stopNestServer();
  } catch (e) {
    console.error('Failed to stop gateway:', e);
    return false;
  }
};

/**
 * Get gateway status (NestJS)
 */
export const getGatewayStatus = async () => {
  return getNestServerStatus();
};

/**
 * Generate a new API key
 */
export const generateApiKey = async (): Promise<string> => {
  const newKey = `sk-${uuidv4().replace(/-/g, '')}`;

  // Save to config
  const config = ConfigManager.loadConfig();
  config.proxy.api_key = newKey;
  ConfigManager.saveConfig(config);

  return newKey;
};

/**
 * Get quota metrics for all accounts (for dashboard)
 * Returns RPM, rate limit status, and quota percentage for each account
 */
export const getQuotaMetrics = async () => {
  // Import dynamically to avoid circular dependency issues with NestJS
  const { getNestApp } = await import('../../server/main');
  const app = getNestApp();

  if (!app) {
    return { metrics: [], serverRunning: false };
  }

  try {
    const { TokenManagerService } =
      await import('../../server/modules/proxy/token-manager.service');
    const tokenManager = app.get(TokenManagerService);
    const metrics = await tokenManager.getQuotaMetrics();
    return { metrics, serverRunning: true };
  } catch (e) {
    console.error('Failed to get quota metrics:', e);
    return { metrics: [], serverRunning: true, error: String(e) };
  }
};
