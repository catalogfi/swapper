import * as bitcoin from "bitcoinjs-lib";
import axios from "axios";
import * as ecc from "tiny-secp256k1";
import { ECPairFactory, ECPairInterface } from "ecpair";
import {
    BTCCompatProvider,
    GetTransactionResult,
    IBitcoinProvider,
} from "./provider";
import { idToHash, parseFeeFromError } from "../utils";

export type BitcoinUTXO = {
    txid: string;
    vout: number;
    value: number;
};

class BitcoinProviderAS implements BTCCompatProvider {
    private API = "https://mempool.space/testnet/api";
    MIN_FEE = 300;
    public signer: ECPairInterface;
    public network = bitcoin.networks.testnet;
    constructor(privateKey: string, network?: bitcoin.Network) {
        this.signer = ECPairFactory(ecc).fromPrivateKey(
            Buffer.from(privateKey, "hex")
        );
        this.network = network || this.network;
    }
    async getUnspent(
        address: string,
        balance?: bigint
    ): Promise<{
        txs: BitcoinUTXO[];
        error?: string;
    }> {
        try {
            const response = await axios.get(
                `${this.API}/address/${address}/utxo`
            );
            const txs = response.data;

            if (Array.isArray(txs)) {
                if (balance) {
                    const total = txs.reduce((acc, tx) => acc + tx.value, 0);
                    if (total < Number(balance)) {
                        return {
                            txs: [],
                            error: `Insufficient funds. Needed ${balance} satoshis, but only have ${total} satoshis`,
                        };
                    }
                    let sum = BigInt(0);
                    const txsToReturn: BitcoinUTXO[] = [];
                    for (const tx of txs) {
                        sum += BigInt(tx.value);
                        txsToReturn.push(tx);
                        if (sum >= balance) {
                            break;
                        }
                    }
                    return { txs: txsToReturn };
                }

                return { txs };
            }
            return { txs: [], error: txs };
        } catch (error: any) {
            const errorPrefix = "getUnspent: ";
            if (error.response) {
                return { txs: [], error: errorPrefix + error.response.data };
            }
            return { txs: [], error: errorPrefix + error.message };
        }
    }
    getBalance(address: string): Promise<number> {
        return new Promise(async (resolve, reject) => {
            try {
                const response = await axios.get(
                    `${this.API}/address/${address}/utxo`
                );
                const txs = response.data;
                if (Array.isArray(txs)) {
                    const balance = txs.reduce(
                        (acc, tx) => acc + tx.value,
                        0
                    );
                    resolve(balance);
                }
                reject(txs);
            } catch (error: any) {
                reject(error.response ? error.response.data : error.message);
            }
        });
    }
    calculateBalance(txs: BitcoinUTXO[]): number {
        return txs.reduce((acc, tx) => acc + tx.value, 0);
    }
    async sendBTC(
        address: string,
        amount: string,
        fee?: number
    ): Promise<{
        txId: string;
        error?: string;
    }> {
        const user = this.getAddress();
        const utxos = await this.getUnspent(user, BigInt(amount) + BigInt(400));
        if (utxos.error) return { txId: "", error: utxos.error };
        const balance = this.calculateBalance(utxos.txs);
        if (balance < Number(amount)) {
            return {
                txId: "",
                error: `sendBTC: Insufficient balance. Balance: ${balance} sat`,
            };
        }
        const psbt = new bitcoin.Psbt({ network: this.network });

        for (const utxo of utxos.txs) {
            try {
                const res = await axios.get(`${this.API}/tx/${utxo.txid}/hex`);
                psbt.addInput({
                    hash: idToHash(utxo.txid),
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(res.data, "hex"),
                });
            } catch (error: any) {
                return {
                    txId: "",
                    error:
                        `sendBTC: while fetching utxo hex: ${utxo.txid}: ` +
                        error.response
                            ? error.response.data
                            : error.message,
                };
            }
        }
        psbt.addOutput({
            address,
            value: Number(amount),
        });

        const change = balance - Number(amount) - (fee || this.MIN_FEE);
        if (change > 0) {
            psbt.addOutput({
                address: user,
                value: change,
            });
        }

        psbt.signAllInputs(this.signer).finalizeAllInputs();
        const { txId, error } = await this.broadcast(psbt.extractTransaction());
        if (error && error.includes("min relay fee not met")) {
            console.log("updating the fee and trying again...");
            return this.sendBTC(address, amount, parseFeeFromError(error));
        }
        return { txId, error };
    }

    getPublicKey(): string {
        return this.signer.publicKey.toString("hex");
    }
    getAddress(): string {
        return bitcoin.payments.p2pkh({
            pubkey: this.signer.publicKey,
            network: this.network,
        }).address as string;
    }
    async fundingTransactions(
        address: string,
        confirmations: number
    ): Promise<string> {
        const fundingTxsRes = await axios.get(
            `${this.API}/address/${address}/txs`
        );
        const txs = await this.parseTxs(
            fundingTxsRes.data,
            confirmations,
            address,
            true
        );
        if (txs.length === 0) throw new Error("No funding transactions found");
        return txs[0].txid;
    }

    async getSecret(address: string): Promise<string> {
        try {
            const fundingTxsRes = await axios.get(
                `${this.API}/address/${address}/txs`
            );
            const txs = await this.parseTxs(
                fundingTxsRes.data,
                0,
                address,
                false
            );
            if (txs.length === 0)
                throw new Error("No spending transactions found");

            const tx = fundingTxsRes.data.find(
                (tx: any) => tx.txid === txs[0].txid
            );
            return tx.vin[0].scriptsig_asm.split(" ")[5];
        } catch (error: any) {
            throw new Error(error.message);
        }
    }
    sign(hash: Buffer): Buffer {
        return this.signer.sign(hash);
    }
    async broadcast(tx: bitcoin.Transaction): Promise<{
        txId: string;
        error?: string;
    }> {
        try {
            const res = await axios.post(`${this.API}/tx`, tx.toHex());
            return {
                txId: res.data,
            };
        } catch (error: any) {
            const errorPrefix = "broadcast: ";
            if (error.response) {
                return { txId: "", error: errorPrefix + error.response.data };
            }
            return { txId: "", error: errorPrefix + error.message };
        }
    }

    async getTransaction(txId: string): Promise<GetTransactionResult> {
        try {
            return {
                txHex: (await axios.get(`${this.API}/tx/${txId}/hex`)).data,
            };
        } catch (error: any) {
            return {
                txHex: "",
                error:
                    "getTransaction: " + error.response
                        ? error.response.data
                        : error.message,
            };
        }
    }

    private async parseTxs(
        txs: any[],
        confirmations: number,
        address: string,
        funding: boolean
    ) {
        if (!txs.length) return [];
        const parsedTxs = txs.map((tx: any) => {
            //   if (tx.status.confirmed === false) return;
            //   if (!tx.status.block_height) return;
            if (funding && tx.vin[0].prevout.scriptpubkey_address !== address) {
                return tx;
            } else if (
                !funding &&
                tx.vin[0].prevout.scriptpubkey_address === address
            ) {
                return tx;
            }
        });
        const filteredTxs = parsedTxs.filter((tx: any) => tx !== undefined);
        return filteredTxs;
    }
}

class BitcoinProvider implements IBitcoinProvider {
    private API = `https://blockstream.info/testnet/api`;
    async getUnspent(address: string): Promise<any> {
        try {
            const unspent = await axios.get(
                `${this.API}/address/${address}/txs`
            );
            return unspent.data;
        } catch (error: any) {
            return { error: error.message };
        }
    }
    getBalance(address: string): Promise<number> {
        throw new Error("Method not implemented.");
    }
    getTransaction(txId: string): Promise<GetTransactionResult> {
        throw new Error("Method not implemented.");
    }
    broadcast(tx: bitcoin.Transaction): Promise<{
        txId: string;
        error?: string;
    }> {
        throw new Error("Method not implemented.");
    }
}

export { BitcoinProviderAS, BitcoinProvider };
