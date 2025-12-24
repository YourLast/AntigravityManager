import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { getServerConfig } from '../../server-config';

@Injectable()
export class ProxyGuard implements CanActivate {
  private readonly logger = new Logger(ProxyGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const config = getServerConfig();

    // 1. Check for API Key in config
    const apiKey = config?.api_key;

    // 2. Bypass if no api_key set (Open Mode) or config missing
    if (!apiKey || apiKey.trim() === '') {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const headers = request.headers;

    // 3. Extract Token from Headers
    let clientToken: string | undefined;

    // A. standard 'authorization: Bearer <token>'
    if (headers['authorization']) {
      const parts = headers['authorization'].split(' ');
      if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
        clientToken = parts[1];
      }
    }

    // B. 'x-api-key' (Anthropic)
    if (!clientToken && headers['x-api-key']) {
      clientToken = headers['x-api-key'] as string;
    }

    // C. 'x-goog-api-key' (Gemini)
    if (!clientToken && headers['x-goog-api-key']) {
      clientToken = headers['x-goog-api-key'] as string;
    }

    // 4. Validate
    if (clientToken === apiKey) {
      return true;
    }

    this.logger.warn(`Blocked unauthorized access from ${request.ip}`);
    throw new UnauthorizedException('Invalid API Key');
  }
}
