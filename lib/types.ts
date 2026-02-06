export type ApiResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code: ErrorCode };

export type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "BUDGET_EXCEEDED"
  | "TRANSACTION_TOO_LARGE"
  | "WALLET_ERROR"
  | "INTERNAL_ERROR"
  | "L402_FETCH_ERROR"
  | "L402_PARSE_ERROR"
  | "L402_INVALID_CHALLENGE"
  | "L402_PAYMENT_FAILED"
  | "L402_NO_PREIMAGE"
  | "L402_RETRY_ERROR";
