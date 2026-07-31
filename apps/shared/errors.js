export class AppError extends Error {
  constructor(code, message, status = 400, meta = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}

export const issue = (code, message, status = 400, meta = {}) => new AppError(code, message, status, meta);

export function asPublicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message, meta: error.meta };
  return { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했습니다. 저장된 데이터는 유지됩니다.' };
}
