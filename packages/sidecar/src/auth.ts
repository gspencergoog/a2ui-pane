import { IncomingMessage } from 'node:http';
import crypto from 'node:crypto';

/**
 * Validates request authentication against the expected sidecar UI token using constant-time comparison.
 * Extracts token from either query parameter (?token=...) or HTTP headers.
 * If no expected token is configured (e.g. standalone local development), allows all requests.
 */
export function checkToken(req: IncomingMessage, url: URL, expectedToken?: string): boolean {
  if (!expectedToken) {
    // Development mode without configured token
    return true;
  }

  // 1. Check query parameter ?token=...
  let candidateToken = url.searchParams.get('token');

  // 2. Check headers: x-sidecar-token, x-token, authorization Bearer
  if (!candidateToken) {
    const rawHeader = req.headers['x-sidecar-token'] || req.headers['x-token'];
    if (typeof rawHeader === 'string') {
      candidateToken = rawHeader;
    } else if (typeof req.headers.authorization === 'string') {
      const match = req.headers.authorization.match(/^Bearer\s+(.+)$/i);
      if (match) {
        candidateToken = match[1];
      }
    }
  }

  if (!candidateToken) {
    return false;
  }

  const expectedBuf = Buffer.from(expectedToken);
  const candidateBuf = Buffer.from(candidateToken);

  if (expectedBuf.length !== candidateBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuf, candidateBuf);
}
