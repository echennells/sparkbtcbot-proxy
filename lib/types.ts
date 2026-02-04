export type ApiResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code: ErrorCode };

export type ErrorCode =
  | "UNAUTHORIZED"
  | "BAD_REQUEST"
  | "BUDGET_EXCEEDED"
  | "TRANSACTION_TOO_LARGE"
  | "WALLET_ERROR"
  | "INTERNAL_ERROR";
