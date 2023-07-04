export type Network = "testnet" | "mainnet";

export interface AtomicSwap {
  initiate(): Promise<string>;
  redeem(secret: string, fee?: number): Promise<string>;
  refund(): Promise<string>;
  waitForInitiate(): Promise<boolean>;
  waitForRedeem(): Promise<string | void>;
}
