import * as bitcoin from "bitcoinjs-lib";
import { BitcoinUTXO } from "./bitcoin";

export type GetTransactionResult = {
    txHex: string;
    error?: string;
};

/**
 * Generic interface for a Bitcoin provider
 */
export interface IBitcoinProvider {
    getUnspent(address: string): Promise<{
        txs: BitcoinUTXO[];
        error?: string;
    }>;
    getBalance(address: string): Promise<number>;
    getTransaction(txId: string): Promise<GetTransactionResult>;
    broadcast(tx: bitcoin.Transaction): Promise<{
        txId: string;
        error?: string;
    }>;
}

export interface BTCCompatProvider extends IBitcoinProvider {
    MIN_FEE: number;
    sendBTC(
        address: string,
        amount: string
    ): Promise<{
        txId: string;
        error?: string;
    }>;
    fundingTransactions(
        address: string,
        confirmations: number
    ): Promise<string>;
    getSecret(address: string): Promise<string>;
    getPublicKey(): string;
    sign(hash: Buffer): Buffer;
}
