import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config } from '../config';

/** Constant-time compare that tolerates length mismatches. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * HTTP Basic Auth gate in front of the whole site (dashboard + API).
 * Browsers cache the credentials for the session, so the panel's own
 * fetch() calls stay authenticated with no extra client-side code.
 */
export function basicAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.authEnabled) {
    next();
    return;
  }

  // Container/uptime probes must stay reachable without credentials.
  if (req.path === '/health') {
    next();
    return;
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');

  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const user = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (separator !== -1 && safeEqual(user, config.authUser) && safeEqual(password, config.authPassword)) {
      next();
      return;
    }
  }

  res.setHeader('WWW-Authenticate', `Basic realm="${config.authRealm}", charset="UTF-8"`);
  res.status(401).json({ status: 'error', message: 'Authentication required.' });
}
