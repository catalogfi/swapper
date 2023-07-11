import { exec } from "child_process";
import { expect } from "chai";
import { randomBytes } from "crypto";
import { sha256 } from "ethers/lib/utils";
import { ECPairFactory, ECPairInterface } from "ecpair";
import { BuildAtomicSwapScript } from "../bitcoin/AtomicSwap";
import axios from "axios";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";

const ECPair = ECPairFactory(ecc);

require("dotenv").config();

describe("--- ATOMIC SWAP - BITCOIN ---", () => {
  const indexerURL = "http://localhost:30000";

  let network: bitcoin.Network;

  let alice: ECPairInterface;
  let bob: ECPairInterface;
  let charlie: ECPairInterface;

  let secret1: Buffer;
  let secret2: Buffer;

  let initTxHashes: string[] = [];

  const idToHash = (txid: string): Buffer => {
    return Buffer.from(txid, "hex").reverse();
  };
  const toOutputScript = (address: string): Buffer => {
    return bitcoin.address.toOutputScript(address, network);
  };

  const getP2PKHAddress = (publicKey: Buffer, network: bitcoin.Network) => {
    const { address } = bitcoin.payments.p2pkh({ pubkey: publicKey, network });
    return address;
  };

  const mineBTC = (address: string, amount: number) => {
    exec(`nigiri faucet ${address} ${amount}`, (err, stdout, stderr) => {
      if (err) throw err;
      if (stderr) throw new Error(stderr);
    });
  };

  const getBalance = async (address: string) => {
    const { data } = await axios.get(`${indexerURL}/address/${address}/utxo`);
    return data.reduce((acc: number, utxo: any) => acc + utxo.value, 0);
  };

  const getRequiredUTXOs = async (address: string, amount: number) => {
    const { data } = await axios.get(`${indexerURL}/address/${address}/utxo`);
    const utxos = data.map((utxo: any) => ({
      txId: utxo.txid,
      vout: utxo.vout,
      value: utxo.value,
      script: utxo.script,
    }));

    let acc = 0;
    const requiredUTXOs = [];
    for (const utxo of utxos) {
      acc += utxo.value;
      requiredUTXOs.push(utxo);
      if (acc >= amount) break;
    }

    return requiredUTXOs;
  };

  const sendBTC = async (
    from: ECPairInterface,
    to: string,
    amount: number,
    index: number
  ) => {
    const fromAddress = getP2PKHAddress(from.publicKey, network);
    if (!fromAddress) throw new Error("Unable to generate from address");

    const utxos = await getRequiredUTXOs(fromAddress, amount);

    const psbt = new bitcoin.Psbt({ network });
    for (const utxo of utxos) {
      const { data: txHex } = await axios.get(
        `${indexerURL}/tx/${utxo.txId}/hex`
      );

      psbt.addInput({
        hash: utxo.txId,
        index: utxo.vout,
        nonWitnessUtxo: Buffer.from(txHex, "hex"),
      });
    }

    psbt.addOutput({
      address: to,
      value: amount,
    });
    psbt.addOutput({
      address: fromAddress,
      value: utxos[0].value - amount - 500,
    });

    psbt.signAllInputs(from);
    psbt.finalizeAllInputs();

    const txHex = psbt.extractTransaction().toHex();
    exec("nigiri push " + txHex, (err, stdout, stderr) => {
      if (err) throw err;
      if (stderr) throw new Error(stderr);

      initTxHashes[index] = stdout.trim().split(" ")[1];
    });
  };

  before(() => {
    network = bitcoin.networks.regtest;

    alice = ECPair.makeRandom({ network });
    bob = ECPair.makeRandom({ network });
    charlie = ECPair.makeRandom({ network });

    secret1 = randomBytes(32);
    secret2 = randomBytes(32);
  });

  describe("- Pre-conditions -", () => {
    it("Users should have different private keys", () => {
      expect(alice.privateKey).to.not.equal(bob.privateKey);
      expect(alice.privateKey).to.not.equal(charlie.privateKey);
      expect(bob.privateKey).to.not.equal(charlie.privateKey);
    });

    it("Users should have different p2pkh addresses", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      const charlieAddress = getP2PKHAddress(charlie.publicKey, network);

      expect(aliceAddress).to.not.equal(bobAddress);
      expect(aliceAddress).to.not.equal(charlieAddress);
      expect(bobAddress).to.not.equal(charlieAddress);
    });

    it("Users should have balance", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      const charlieAddress = getP2PKHAddress(charlie.publicKey, network);

      if (!aliceAddress || !bobAddress || !charlieAddress)
        throw new Error("Unable to generate addresses");

      let aliceBalance = await getBalance(aliceAddress);
      let bobBalance = await getBalance(bobAddress);
      let charlieBalance = await getBalance(charlieAddress);

      expect(aliceBalance).to.be.equal(0);
      expect(bobBalance).to.be.equal(0);
      expect(charlieBalance).to.be.equal(0);

      mineBTC(aliceAddress, 10);
      mineBTC(bobAddress, 10);
      mineBTC(charlieAddress, 10);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      aliceBalance = await getBalance(aliceAddress);
      bobBalance = await getBalance(bobAddress);
      charlieBalance = await getBalance(charlieAddress);

      expect(aliceBalance).to.be.equal(1000000000);
      expect(bobBalance).to.be.equal(1000000000);
      expect(charlieBalance).to.be.equal(1000000000);
    });

    it("Secrets should be different", () => {
      expect(secret1).to.not.equal(secret2);
    });
  });

  describe("- Atomic Swap - Initiate -", () => {
    it("Alice should not be able to initiate a swap with no redeemer", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      if (!aliceAddress) throw new Error("Unable to generate addresses");

      let flag: boolean;
      try {
        BuildAtomicSwapScript(
          sha256(secret1).slice(2),
          "",
          aliceAddress,
          10,
          network
        );
        flag = false;
      } catch (e: any) {
        flag = true;
      }

      expect(flag).to.be.true;
    });

    it("Alice should be able to initiate a swap", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
        sha256(secret1).slice(2),
        bobAddress,
        aliceAddress,
        10,
        network
      );

      await sendBTC(alice, atomicSwapScriptAddress, 100000000, 0);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const { data } = await axios.get(
        `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
      );

      expect(data.length).to.be.equal(1);

      const utxo = data[0];
      expect(utxo.value).to.be.equal(100000000);
    });

    it("Alice should be able to initiate another swaps with different secret", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
        sha256(secret2).slice(2),
        bobAddress,
        aliceAddress,
        17,
        network
      );

      await sendBTC(alice, atomicSwapScriptAddress, 70000000, 1);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const { data } = await axios.get(
        `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
      );

      expect(data.length).to.be.equal(1);

      const utxo = data[0];
      expect(utxo.value).to.be.equal(70000000);
    });
  });

  describe("- Atomic Swap - Redeem -", () => {
    it("Bob should not be able to redeem a swap with invalid secret", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret1).slice(2),
        bobAddress,
        aliceAddress,
        10,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[0]), 0);
      tx.addOutput(toOutputScript(bobAddress), 100000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        100000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(bob.sign(signatureHash), hashType),
            bob.publicKey,
            randomBytes(32),
            bitcoin.opcodes.OP_TRUE,
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);
      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (error, stdout, stderr) => {
        if (error) {
          expect(error.message).to.contain(
            "Script failed an OP_EQUALVERIFY operation"
          );
          return;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    it("Bob should be able to redeem a swap with valid secret", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret1).slice(2),
        bobAddress,
        aliceAddress,
        10,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[0]), 0);
      tx.addOutput(toOutputScript(bobAddress), 100000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        100000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(bob.sign(signatureHash), hashType),
            bob.publicKey,
            secret1,
            bitcoin.opcodes.OP_TRUE,
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (err, stdout, stderr) => {
        if (err) throw err;
        if (stderr) throw new Error(stderr);
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const bobBalance = await getBalance(bobAddress);
      expect(bobBalance).to.be.equal(1099999500);
    });

    it("Bob should not be able to redeem a swap with the same secret", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret1).slice(2),
        bobAddress,
        aliceAddress,
        10,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[0]), 0);
      tx.addOutput(toOutputScript(bobAddress), 100000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        100000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(bob.sign(signatureHash), hashType),
            bob.publicKey,
            secret1,
            bitcoin.opcodes.OP_TRUE,
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (error, stdout, stderr) => {
        if (error) {
          expect(error.message).to.contain(
            "Transaction already in block chain"
          );
          return;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
  });

  describe("- Atomic Swap - Refund -", () => {
    it("Alice should not be able to refund a swap that is already redeemed", async () => {
      exec("nigiri rpc --generate 10", (err, stdout, stderr) => {
        if (err) throw err;
        if (stderr) throw new Error(stderr);
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret1).slice(2),
        bobAddress,
        aliceAddress,
        10,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[0]), 0, 10);
      tx.addOutput(toOutputScript(aliceAddress), 100000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        100000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(
              alice.sign(signatureHash),
              hashType
            ),
            alice.publicKey,
            Buffer.from([]),
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (error, stdout, stderr) => {
        if (error) {
          expect(error.message).to.contain("bad-txns-inputs-missingorspent");
          return;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });

    it("Alice should not be able to refund a swap earlier than the locktime", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret2).slice(2),
        bobAddress,
        aliceAddress,
        17,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[1]), 0, 17);
      tx.addOutput(toOutputScript(aliceAddress), 70000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        70000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(
              alice.sign(signatureHash),
              hashType
            ),
            alice.publicKey,
            Buffer.from([]),
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (error, stdout, stderr) => {
        if (error) {
          expect(error.message).to.contain("non-BIP68-final");
          return;
        }
      });
    });

    it("Alice should be able to refund a swap after the locktime", async () => {
      exec("nigiri rpc --generate 10", (err, stdout, stderr) => {
        if (err) throw err;
        if (stderr) throw new Error(stderr);
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret2).slice(2),
        bobAddress,
        aliceAddress,
        17,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[1]), 0, 17);
      tx.addOutput(toOutputScript(aliceAddress), 70000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        70000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(
              alice.sign(signatureHash),
              hashType
            ),
            alice.publicKey,
            Buffer.from([]),
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (err, stdout, stderr) => {
        if (err) throw err;
        if (stderr) throw new Error(stderr);
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const aliceBalance = await getBalance(aliceAddress);
      expect(aliceBalance).to.equal(899998500);
    });

    it("Alice should not be able to refund a swap that is already refunded", async () => {
      const aliceAddress = getP2PKHAddress(alice.publicKey, network);
      const bobAddress = getP2PKHAddress(bob.publicKey, network);
      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      const { AtomicSwapScript } = BuildAtomicSwapScript(
        sha256(secret2).slice(2),
        bobAddress,
        aliceAddress,
        17,
        network
      );

      const tx = new bitcoin.Transaction();
      tx.version = 2;
      tx.addInput(idToHash(initTxHashes[1]), 0, 17);
      tx.addOutput(toOutputScript(aliceAddress), 70000000 - 500);

      const hashType = bitcoin.Transaction.SIGHASH_ALL;

      const signatureHash = tx.hashForWitnessV0(
        0,
        AtomicSwapScript,
        70000000,
        hashType
      );

      const redeemScriptSig = bitcoin.payments.p2wsh({
        redeem: {
          input: bitcoin.script.compile([
            bitcoin.script.signature.encode(
              alice.sign(signatureHash),
              hashType
            ),
            alice.publicKey,
            Buffer.from([]),
          ]),
          output: AtomicSwapScript,
        },
      });
      tx.setWitness(0, redeemScriptSig.witness!);

      const txHex = tx.toHex();

      exec("nigiri push " + txHex, (error, stdout, stderr) => {
        if (error) {
          expect(error.message).to.contain(
            "Transaction already in block chain"
          );
          return;
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    });
  });
});
