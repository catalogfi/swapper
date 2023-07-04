import { buildRedeemScript } from "./script";
import { Network } from "./interface";
import * as bitcoin from "bitcoinjs-lib";
import { AtomicSwap } from "./interface";
import { BTCCompatProvider } from "./btc-compat";
import { parseFeeFromError } from "./utils";

export class BTCAtomicSwap implements AtomicSwap {
  public network: bitcoin.Network;
  public provider: BTCCompatProvider;
  public amount: string;
  public expiry: number;
  public redeemScript: Buffer;
  public scriptAddress: string;
  public confirmations: number;
  public frequency: number;
  public redeemTxHash: string = "";
  public recipientAddress: string;
  public initTxHash: string = "";
  public refundAddress: string = "";
  constructor(
    network: Network,
    provider: BTCCompatProvider,
    secretHash: string,
    recipientAddress: string,
    refundAddress: string,
    amount: Number,
    expiry: number,
    confirmations?: number,
    frequency?: number
  ) {
    this.network = network === "testnet" ? bitcoin.networks.testnet : bitcoin.networks.bitcoin;

    this.provider = provider;
    this.amount = amount.toString();
    this.expiry = expiry;
    this.recipientAddress = recipientAddress;
    this.refundAddress = refundAddress;

    const { address, redeemScript } = buildRedeemScript(
      secretHash.slice(0, 2) === "0x" ? secretHash.slice(2) : secretHash,
      recipientAddress,
      refundAddress,
      expiry,
      this.network
    );
    this.redeemScript = redeemScript;
    this.scriptAddress = address;
    this.confirmations = confirmations || 0;
    this.frequency = frequency || 1000;
  }

  async initiate(): Promise<string> {
    const { txId: txHash, error } = await this.provider.sendBTC(this.scriptAddress, this.amount);
    if (error) {
      throw new Error(error);
    }
    this.initTxHash = txHash;
    return txHash;
  }

  async waitForInitiate(): Promise<boolean> {
    while (true) {
      try {
        if (Math.floor(Date.now() / 1000) >= this.expiry) return false;
        const txHash = await this.provider.fundingTransactions(this.scriptAddress, this.confirmations);
        if (txHash) {
          this.redeemTxHash = txHash;
          return true;
        }
      } catch (error: any) {
        // console.error(error.message);
        await new Promise((resolve) => setTimeout(resolve, this.frequency));
        continue;
      }
    }
  }

  async redeem(secret: string, fee?: number): Promise<string> {
    if (!this.redeemTxHash) throw new Error("No redeem transaction found");

    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(this.idToHash(this.redeemTxHash), 0);
    tx.addOutput(this.toOutputScript(this.recipientAddress), Number(this.amount) - (fee || this.provider.MIN_FEE));

    const hashType = bitcoin.Transaction.SIGHASH_ALL;

    const signatureHash = tx.hashForSignature(0, this.redeemScript, hashType);

    const redeemScriptSig = bitcoin.payments.p2sh({
      redeem: {
        input: bitcoin.script.compile([
          bitcoin.script.signature.encode(this.provider.sign(signatureHash), hashType),
          Buffer.from(this.provider.getPublicKey(), "hex"),
          Buffer.from(secret, "hex"),
          bitcoin.opcodes.OP_TRUE,
        ]),
        output: this.redeemScript,
      },
    }).input;
    tx.setInputScript(0, redeemScriptSig!);
    const { txId, error } = await this.provider.broadcast(tx);
    if (error) {
      if (error.includes("min relay fee not met")) {
        console.log("updating the fee and trying again...");
        return this.redeem(secret, parseFeeFromError(error));
      }
      console.log("Redeem", error);
      throw new Error(error);
    }
    return txId;
  }
  async refund(): Promise<string> {
    if (!this.initTxHash) throw new Error("No initiate transaction found");
    if (this.expiry > Math.floor(Date.now() / 1000)) throw new Error("Refund time has not been reached");

    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(this.idToHash(this.initTxHash), 0);
    tx.addOutput(this.toOutputScript(this.refundAddress), Number(BigInt(this.amount) - BigInt(this.provider.MIN_FEE)));

    const hashType = bitcoin.Transaction.SIGHASH_ALL;

    const signatureHash = tx.hashForSignature(0, this.redeemScript, hashType);

    const redeemScriptSig = bitcoin.payments.p2sh({
      redeem: {
        input: bitcoin.script.compile([
          bitcoin.script.signature.encode(this.provider.sign(signatureHash), hashType),
          Buffer.from(this.provider.getPublicKey(), "hex"),
          bitcoin.opcodes.OP_FALSE,
        ]),
        output: this.redeemScript,
      },
    });

    tx.setInputScript(0, redeemScriptSig!.input!);
    const { txId, error } = await this.provider.broadcast(tx);
    if (error) {
      console.log("Refund", error);
      throw new Error(error);
    }
    return txId;
  }
  //TODO: test
  async waitForRedeem(): Promise<string | void> {
    while (true) {
      try {
        if (Math.floor(Date.now() / 1000) >= this.expiry) return;
        const secret = await this.provider.getSecret(this.scriptAddress);
        if (!secret) {
          await new Promise((resolve) => setTimeout(resolve, this.frequency));
          continue;
        }

        return secret;
      } catch (error: any) {
        // console.log(error.message);
        await new Promise((resolve) => setTimeout(resolve, this.frequency));

        continue;
      }
    }
  }

  private idToHash(txid: string): Buffer {
    return Buffer.from(txid, "hex").reverse();
  }
  private toOutputScript(address: string): Buffer {
    return bitcoin.address.toOutputScript(address, this.network);
  }
}

/**
 * @class BTCAtomicSwapClient :
 * Client side of the atomic swap protocol for BTC
 * @param {Network} network - The network to use
 * @param {BTCCompatProvider} provider - The provider to use
 * @param {string} secretHash - The secret hash
 * @param {string} recipientAddress - The recipient address
 * @param {string} refundAddress - The refund address
 * @param {number} amount - The amount to swap
 * @param {number} expiry - The expiry time
 * @param {number} confirmations - The number of confirmations to wait for
 * @param {number} frequency - The frequency to check for updates
 *
 */
// class BTCAtomicSwapClient implements AtomicSwap {
//     private network: bitcoin.Network;
//     private provider: IBitcoinProvider;
//     private secretHash: string;
//     private recipientAddress: string;
//     private refundAddress: string;
//     private amount: number;
//     private expiry: number;
//     private confirmations: number;
//     private frequency: number;

//     private redeemScript: Buffer;
//     private scriptAddress: string;
//     private initTxHash: string | undefined;
//     private redeemTxHash: string | undefined;

//     constructor(
//         network: Network,
//         provider: IBitcoinProvider,
//         secretHash: string,
//         recipientAddress: string,
//         refundAddress: string,
//         amount: number,
//         expiry: number,
//         confirmations?: number,
//         frequency?: number
//     ) {
//         this.network =
//             network === "testnet"
//                 ? bitcoin.networks.testnet
//                 : bitcoin.networks.bitcoin;

//         this.provider = provider;
//         this.amount = amount;
//         this.expiry = expiry;
//         this.recipientAddress = recipientAddress;
//         this.refundAddress = refundAddress;
//         this.secretHash = secretHash;
//         const { address, redeemScript } = buildRedeemScript(
//             secretHash,
//             recipientAddress,
//             refundAddress,
//             expiry,
//             this.network
//         );
//         this.redeemScript = redeemScript;
//         this.scriptAddress = address;
//         this.confirmations = confirmations || 0;
//         this.frequency = frequency || 1000;
//     }
//     /**
//      * Returns the address to which the initiator should send the funds.
//      * This call should be followed by a call to waitForInitiate
//      * @returns {Promise<string>} - Address to which the initiator should send the funds
//      */
//     async initiate(): Promise<string> {
//         return this.scriptAddress;
//     }
//     redeem(secret: string): Promise<string> {
//         throw new Error("Method not implemented.");
//     }
//     refund(): Promise<string> {
//         throw new Error("Method not implemented.");
//     }

//     async waitForInitiate(): Promise<boolean> {
//         while (true) {
//             //check if expiry has been reached
//             if (Math.floor(Date.now() / 1000) >= this.expiry) return false;

//             // get unspent outputs from the script address
//             const unspent = await this.provider.getUnspent(this.scriptAddress);
//             if (!unspent) {
//                 await this.wait();
//                 continue;
//             }
//             const fundingtx = await this.fundingTxs(unspent);
//             if (!fundingtx) {
//                 await this.wait();
//                 continue;
//             }
//             return true;
//         }
//     }

//     private async wait() {
//         await new Promise((resolve) => setTimeout(resolve, this.frequency));
//     }
//     waitForRedeem(): Promise<string | void> {
//         throw new Error("Method not implemented.");
//     }
//     /**
//      * Finds the funding transaction for the the script address
//      * @param unspentTxs - The unspent transactions to use for finding the funding transaction
//      */
//     private async fundingTxs(unspentTxs: any[]): Promise<any> {
//         for (let index = 0; index < unspentTxs.length; index++) {
//             const tx = unspentTxs[index];
//             if (tx.vin[0].prevout.scriptpubkey_address === this.refundAddress) {
//                 return tx;
//             }
//         }
//         return undefined;
//     }
// }

export const executeAliceAtomicSwap = async (native: AtomicSwap, foreign: AtomicSwap, secret: string) => {
  console.log("Alice", "running atomic swap");
  const tx = await native.initiate();
  console.log("AliceInit", tx);
  const shouldRedeem = await foreign.waitForInitiate();
  if (shouldRedeem) {
    const redeemTx = await foreign.redeem(secret);
    console.log("AliceRedeem", redeemTx);
  } else {
    await native.refund();
  }
};

export const executeBobAtomicSwap = async (native: AtomicSwap, foreign: AtomicSwap) => {
  console.log("Bob", "running atomic swap");

  const wait = await foreign.waitForInitiate();
  if (!wait) throw new Error("Alice failed to send funds");
  const tx = await native.initiate();
  console.log("BobInit", tx);

  const secret = await native.waitForRedeem();
  if (secret) {
    const redeemTx = await foreign.redeem(secret);
    console.log("BobRedeem", redeemTx);
  } else {
    await native.refund();
  }
};
