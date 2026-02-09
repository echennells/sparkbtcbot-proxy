import { SparkWallet } from "@buildonspark/spark-sdk";

const STALE_LEAF_ERROR_PATTERNS = [
  "refund transaction sequence must be less than or equal to",
  "validating refresh timelock failed",
  "Failed to request leaves swap",
];

/**
 * Check if an error is due to stale leaf timelocks.
 * This happens when leaves haven't been refreshed and their timelocks have drifted.
 */
export function isStaleLeafError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return STALE_LEAF_ERROR_PATTERNS.some((pattern) => message.includes(pattern));
}

/**
 * Consolidate all leaves by sending funds to self.
 * This creates fresh leaves with reset timelocks.
 * Returns true if consolidation was performed, false if wallet is empty.
 */
export async function consolidateLeaves(wallet: SparkWallet): Promise<boolean> {
  // Get current balance
  const balance = await wallet.getBalance();
  const balanceSats = Number(balance.balance);

  if (balanceSats <= 0) {
    return false; // Nothing to consolidate
  }

  // Get our own Spark address
  const info = await wallet.getSparkAddress();

  // Send all funds to ourselves
  await wallet.transfer({
    receiverSparkAddress: info,
    amountSats: balanceSats,
  });

  return true;
}

/**
 * Execute a wallet operation with automatic stale leaf recovery.
 * If the operation fails due to stale leaves, consolidate and retry once.
 */
export async function withStaleLeafRecovery<T>(
  wallet: SparkWallet,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isStaleLeafError(err)) {
      // Try to consolidate leaves
      const consolidated = await consolidateLeaves(wallet);
      if (consolidated) {
        // Retry the operation once
        return await operation();
      }
    }
    // Re-throw if not a stale leaf error or consolidation didn't help
    throw err;
  }
}
