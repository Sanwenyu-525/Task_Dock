/** 统一的错误→响应码映射（对齐 10-api-and-protocol.md §5 错误码约定）。 */
import { ZodError } from 'zod';
import { SecurityError } from '../core/errors.js';

export interface ApiError {
  statusCode: number;
  error: string;
  code: string;
  message: string;
}

const SECURITY_STATUS: Record<string, { status: number; code: string }> = {
  INVALID_SIGNATURE: { status: 401, code: 'IDENTITY_MISMATCH' },
  FINGERPRINT_MISMATCH: { status: 401, code: 'IDENTITY_MISMATCH' },
  STALE_TIMESTAMP: { status: 401, code: 'IDENTITY_MISMATCH' },
  IDENTITY_MISMATCH: { status: 401, code: 'IDENTITY_MISMATCH' },
  DEVICE_NOT_FOUND: { status: 404, code: 'DEVICE_NOT_FOUND' },
  DEVICE_ALREADY_EXISTS: { status: 409, code: 'DEVICE_ALREADY_EXISTS' },
  DEVICE_REVOKED: { status: 403, code: 'DEVICE_REVOKED' },
  INVALID_INVITATION: { status: 400, code: 'INVALID_INVITATION' },
  INVITATION_EXPIRED: { status: 400, code: 'INVALID_INVITATION' },
  INVITATION_NOT_PENDING: { status: 400, code: 'INVALID_INVITATION' },
  REQUEST_NOT_FOUND: { status: 404, code: 'REQUEST_NOT_FOUND' },
  RATE_LIMITED: { status: 429, code: 'RATE_LIMITED' },
  REPLAY_DETECTED: { status: 400, code: 'REPLAY_DETECTED' },
  SIGNAL_EXPIRED: { status: 400, code: 'SESSION_EXPIRED' },
  CIPHERTEXT_HASH_MISMATCH: { status: 400, code: 'IDENTITY_MISMATCH' },
  'TURN_SECRET is not configured': { status: 500, code: 'SERVER_MISCONFIGURED' },
};

export function toApiError(err: unknown): ApiError {
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      error: 'Bad Request',
      code: 'INVALID_SCHEMA',
      message: 'request payload failed schema validation',
    };
  }
  if (err instanceof SecurityError) {
    const mapped = SECURITY_STATUS[err.code] ?? {
      status: 400,
      code: err.code,
    };
    return {
      statusCode: mapped.status,
      error: mapped.status === 401 ? 'Unauthorized' : 'Forbidden',
      code: mapped.code,
      message: err.code,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  const mapped = SECURITY_STATUS[message] ?? {
    status: 500,
    code: 'INTERNAL_ERROR',
  };
  return {
    statusCode: mapped.status,
    error: mapped.status >= 500 ? 'Internal Server Error' : 'Forbidden',
    code: mapped.code,
    // 内部错误不泄漏堆栈或原始消息，仅返回稳定错误码。
    message: mapped.code,
  };
}
