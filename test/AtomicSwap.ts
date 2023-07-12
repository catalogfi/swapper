import axios from "axios";
import { ethers } from "hardhat";
import { expect, use } from "chai";
import { randomBytes } from "crypto";
import { exec } from "child_process";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import { sha256 } from "ethers/lib/utils";
import { solidity } from "ethereum-waffle";
import { ECPairFactory, ECPairInterface } from "ecpair";
import { AtomicSwap, TestToken } from "../typechain-types";
import { BuildAtomicSwapScript } from "../bitcoin/AtomicSwap";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { latestBlock } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";

use(solidity);
const indexerURL = "http://localhost:30000";
const ECPair = ECPairFactory(ecc);

describe("--- ATOMIC SWAP ---", () => {
  const secret1 = randomBytes(32);
  const secret2 = randomBytes(32);
  const secret3 = randomBytes(32);
  const secret4 = randomBytes(32);

  const network = bitcoin.networks.regtest;

  let ownerE: HardhatEthersSigner;
  let aliceE: HardhatEthersSigner;
  let bobE: HardhatEthersSigner;
  let charlieE: HardhatEthersSigner;

  let aliceB: ECPairInterface;
  let bobB: ECPairInterface;

  let usdc: TestToken;
  let atomicSwap: AtomicSwap;

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

    let acc = 0;
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

      acc += utxo.value;
    }

    psbt.addOutput({
      address: to,
      value: amount,
    });
    psbt.addOutput({
      address: fromAddress,
      value: acc - amount - 500,
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

  before(async () => {
    [ownerE, aliceE, bobE, charlieE] = await ethers.getSigners();

    aliceB = ECPair.makeRandom({ network });
    bobB = ECPair.makeRandom({ network });

    const TestToken = await ethers.getContractFactory("TestToken");
    usdc = (await TestToken.deploy(
      "USDC",
      "USDC",
      6n,
      ethers.utils.parseUnits("100000000", 6n),
      ownerE.address
    )) as TestToken;
    await usdc.deployed();

    const AtomicSwap = await ethers.getContractFactory("AtomicSwap");
    atomicSwap = (await AtomicSwap.deploy(usdc.address)) as AtomicSwap;
    await atomicSwap.deployed();
  });

  describe("- Pre-conditions -", () => {
    it("All accounts should have valid addresses", async () => {
      expect(ethers.utils.isAddress(ownerE.address)).to.equal(true);
      expect(ethers.utils.isAddress(aliceE.address)).to.equal(true);
      expect(ethers.utils.isAddress(bobE.address)).to.equal(true);
      expect(ethers.utils.isAddress(charlieE.address)).to.equal(true);
    });

    it("All accounts should have different addresses", async () => {
      expect(ownerE.address).to.not.equal(aliceE.address);
      expect(ownerE.address).to.not.equal(bobE.address);
      expect(ownerE.address).to.not.equal(charlieE.address);
      expect(aliceE.address).to.not.equal(bobE.address);
      expect(aliceE.address).to.not.equal(charlieE.address);
      expect(bobE.address).to.not.equal(charlieE.address);
    });

    it("Owner should have 100M USDC", async () => {
      expect(await usdc.balanceOf(ownerE.address)).to.equal(
        ethers.utils.parseUnits("100000000", 6n)
      );
    });

    it("All users' accounts should have 0 USDC", async () => {
      expect(await usdc.balanceOf(aliceE.address)).to.equal(0n);
      expect(await usdc.balanceOf(bobE.address)).to.equal(0n);
      expect(await usdc.balanceOf(charlieE.address)).to.equal(0n);
    });

    it("AtomicSwap should have 0 USDC", async () => {
      expect(await usdc.balanceOf(atomicSwap.address)).to.equal(0n);
    });

    it("AtomicSwap should be deployed with correct USDC address", async () => {
      expect(await atomicSwap.token()).to.equal(usdc.address);
    });

    it("Users should have different private keys", () => {
      expect(aliceB.privateKey).to.not.equal(bobB.privateKey);
    });

    it("Users should have different p2pkh addresses", async () => {
      const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
      const bobAddress = getP2PKHAddress(bobB.publicKey, network);

      expect(aliceAddress).to.not.equal(bobAddress);
    });

    it("Users should have balance", async () => {
      const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
      const bobAddress = getP2PKHAddress(bobB.publicKey, network);

      if (!aliceAddress || !bobAddress)
        throw new Error("Unable to generate addresses");

      let aliceBalance = await getBalance(aliceAddress);
      let bobBalance = await getBalance(bobAddress);

      expect(aliceBalance).to.be.equal(0);
      expect(bobBalance).to.be.equal(0);

      mineBTC(aliceAddress, 10);
      mineBTC(bobAddress, 10);
      await new Promise((resolve) => setTimeout(resolve, 5000));

      aliceBalance = await getBalance(aliceAddress);
      bobBalance = await getBalance(bobAddress);

      expect(aliceBalance).to.be.equal(1000000000);
      expect(bobBalance).to.be.equal(1000000000);
    });

    it("Secrets should be different", async () => {
      expect(secret1).to.not.equal(secret2);
      expect(secret1).to.not.equal(secret3);
      expect(secret1).to.not.equal(secret4);
      expect(secret2).to.not.equal(secret3);
      expect(secret2).to.not.equal(secret4);
      expect(secret3).to.not.equal(secret4);
    });
  });

  describe("- BITCOIN to ETHEREUM -", () => {
    describe("Redeem -", () => {
      // Alice initiates a swap with Bob on Bitcoin
      it("Alice should not be able to initiate a swap with no redeemer", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
          sha256(secret1).slice(2),
          bobAddress,
          aliceAddress,
          10,
          network
        );

        await sendBTC(aliceB, atomicSwapScriptAddress, 100000000, 0);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const { data } = await axios.get(
          `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
        );

        expect(data.length).to.be.equal(1);

        const utxo = data[0];
        expect(utxo.value).to.be.equal(100000000);
      });

      // Bob initiates a swap with Alice on Ethereum
      it("Bob should not be able to initiate a swap with no redeemer", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              ethers.constants.AddressZero,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: invalid redeemer address");
      });

      it("Bob should not be able to initiate a swap with no amount", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.constants.Zero,
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: amount cannot be zero");
      });

      it("Bob should not be able to initiate a swap with self as redeemer", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: redeemer and initiator cannot be the same"
        );
      });

      it("Bob should not be able to initiate a swap with a past block number", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) - 1,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: expiry cannot be lower than current block"
        );
      });

      it("Bob should not be able to initiate a swap with amount greater than his allowance", async () => {
        await usdc
          .connect(bobE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.allowance(bobE.address, atomicSwap.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );

        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Bob should not be able to initiate a swap with amount greater than her balance", async () => {
        await usdc
          .connect(ownerE)
          .transfer(bobE.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.balanceOf(bobE.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );

        await usdc
          .connect(bobE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("1000", 6n));
        expect(await usdc.allowance(bobE.address, atomicSwap.address)).to.equal(
          ethers.utils.parseUnits("1000", 6n)
        );

        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("Bob should be able to initiate a swap", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret1)
            )
        )
          .to.emit(atomicSwap, "Initiated")
          .withArgs(
            ethers.utils.sha256(secret1),
            ethers.utils.parseUnits("100", 6n)
          );
      });

      it("Bob should not be able to initiate a swap with the same secret", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret1)
            )
        ).to.be.revertedWith("AtomicSwap: insecure secret hash");
      });

      // Alice redeems the swap on Ethereum
      it("Alice should not be able to redeem a swap with no initiator", async () => {
        await expect(
          atomicSwap.connect(aliceE).redeem(randomBytes(32))
        ).to.be.revertedWith(
          "AtomicSwap: order not initated or invalid secret"
        );
      });

      it("Alice should not be able to redeem a swap with invalid secret", async () => {
        await expect(
          atomicSwap.connect(aliceE).redeem(randomBytes(32))
        ).to.be.revertedWith(
          "AtomicSwap: order not initated or invalid secret"
        );
      });

      it("Alice should be able to redeem a swap with valid secret", async () => {
        await expect(atomicSwap.connect(aliceE).redeem(secret1))
          .to.emit(atomicSwap, "Redeemed")
          .withArgs(
            ethers.utils.sha256(secret1),
            ethers.utils.hexlify(secret1)
          );

        expect(await usdc.balanceOf(aliceE.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );
      });

      it("Alice should not be able to redeem a swap with the same secret", async () => {
        await expect(
          atomicSwap.connect(aliceE).redeem(secret1)
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });

      // Bob redeems the swap on Bitcoin
      it("Bob should not be able to redeem a swap with invalid secret", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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

    describe("Refund -", () => {
      // Alice initiates a swap with Bob on Bitcoin
      it("Alice should not be able to initiate a swap with no redeemer", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        if (!aliceAddress) throw new Error("Unable to generate addresses");

        let flag: boolean;
        try {
          BuildAtomicSwapScript(
            sha256(secret2).slice(2),
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
          sha256(secret2).slice(2),
          bobAddress,
          aliceAddress,
          10,
          network
        );

        await sendBTC(aliceB, atomicSwapScriptAddress, 100000000, 1);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const { data } = await axios.get(
          `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
        );

        expect(data.length).to.be.equal(1);

        const utxo = data[0];
        expect(utxo.value).to.be.equal(100000000);
      });

      // Bob initiates a swap with Alice on Ethereum
      it("Bob should not be able to initiate a swap with no redeemer", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              ethers.constants.AddressZero,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: invalid redeemer address");
      });

      it("Bob should not be able to initiate a swap with no amount", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.constants.Zero,
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: amount cannot be zero");
      });

      it("Bob should not be able to initiate a swap with self as redeemer", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: redeemer and initiator cannot be the same"
        );
      });

      it("Bob should not be able to initiate a swap with a past block number", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) - 1,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: expiry cannot be lower than current block"
        );
      });

      it("Bob should not be able to initiate a swap with amount greater than his allowance", async () => {
        await usdc
          .connect(bobE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.allowance(bobE.address, atomicSwap.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );

        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Bob should not be able to initiate a swap with amount greater than her balance", async () => {
        await usdc
          .connect(ownerE)
          .transfer(bobE.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.balanceOf(bobE.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );

        await usdc
          .connect(bobE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("1000", 6n));
        expect(await usdc.allowance(bobE.address, atomicSwap.address)).to.equal(
          ethers.utils.parseUnits("1000", 6n)
        );

        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("Bob should be able to initiate a swap", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret2)
            )
        )
          .to.emit(atomicSwap, "Initiated")
          .withArgs(
            ethers.utils.sha256(secret2),
            ethers.utils.parseUnits("100", 6n)
          );
      });

      it("Bob should not be able to initiate a swap with the same secret", async () => {
        await expect(
          atomicSwap
            .connect(bobE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret2)
            )
        ).to.be.revertedWith("AtomicSwap: insecure secret hash");
      });

      // Bob refunds the swap on Ethereum
      it("Bob should not be able to refund a swap with no initiator", async () => {
        await expect(
          atomicSwap.connect(bobE).refund(randomBytes(32))
        ).to.be.revertedWith("AtomicSwap: order not initated");
      });

      it("Bob should not be able to refund a swap that is already redeemed", async () => {
        await expect(
          atomicSwap.connect(bobE).refund(ethers.utils.sha256(secret1))
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });

      it("Bob should not be able to refund a swap earlier than the locktime", async () => {
        await expect(
          atomicSwap.connect(bobE).refund(ethers.utils.sha256(secret2))
        ).to.be.revertedWith("AtomicSwap: order not expired");
      });

      it("Bob should be able to refund a swap after the locktime", async () => {
        mine((await ethers.provider.getBlockNumber()) + 1000);

        await expect(
          atomicSwap.connect(bobE).refund(ethers.utils.sha256(secret2))
        )
          .to.emit(atomicSwap, "Refunded")
          .withArgs(ethers.utils.sha256(secret2));

        expect(await usdc.balanceOf(bobE.address)).to.equal(
          ethers.utils.parseUnits("100", 6n)
        );
      });

      it("Bob should not be able to refund a swap that is already refunded", async () => {
        await expect(
          atomicSwap.connect(bobE).refund(ethers.utils.sha256(secret2))
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });

      // Alice refunds the swap on Bitcoin
      it("Alice should not be able to refund a swap that is already redeemed", async () => {
        exec("nigiri rpc --generate 5", (err, stdout, stderr) => {
          if (err) throw err;
          if (stderr) throw new Error(stderr);
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret2).slice(2),
          bobAddress,
          aliceAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[1]), 0, 10);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
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

        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret2).slice(2),
          bobAddress,
          aliceAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[1]), 0, 10);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
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
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret2).slice(2),
          bobAddress,
          aliceAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[1]), 0, 10);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
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

  describe("- ETHEREUM to BITCOIN -", () => {
    describe("Redeem -", () => {
      // Alice initiates a swap with Bob on Ethereum
      it("Alice should not be able to initiate a swap with no redeemer", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              ethers.constants.AddressZero,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: invalid redeemer address");
      });

      it("Alice should not be able to initiate a swap with no amount", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.constants.Zero,
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: amount cannot be zero");
      });

      it("Alice should not be able to initiate a swap with self as redeemer", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: redeemer and initiator cannot be the same"
        );
      });

      it("Alice should not be able to initiate a swap with a past block number", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) - 1,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: expiry cannot be lower than current block"
        );
      });

      it("Alice should not be able to initiate a swap with amount greater than her allowance", async () => {
        await usdc
          .connect(aliceE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("100", 6n));
        expect(
          await usdc.allowance(aliceE.address, atomicSwap.address)
        ).to.equal(ethers.utils.parseUnits("100", 6n));

        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Alice should not be able to initiate a swap with amount greater than her balance", async () => {
        await usdc
          .connect(ownerE)
          .transfer(aliceE.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.balanceOf(aliceE.address)).to.equal(
          ethers.utils.parseUnits("200", 6n)
        );

        await usdc
          .connect(aliceE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("1000", 6n));
        expect(
          await usdc.allowance(aliceE.address, atomicSwap.address)
        ).to.equal(ethers.utils.parseUnits("1000", 6n));

        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("400", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("Alice should be able to initiate a swap", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret3)
            )
        )
          .to.emit(atomicSwap, "Initiated")
          .withArgs(
            ethers.utils.sha256(secret3),
            ethers.utils.parseUnits("100", 6n)
          );
      });

      it("Alice should not be able to initiate a swap with the same secret", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret3)
            )
        ).to.be.revertedWith("AtomicSwap: insecure secret hash");
      });

      // Bob initiates a swap with Alice on Bitcoin
      it("Bob should not be able to initiate a swap with no redeemer", async () => {
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!bobAddress) throw new Error("Unable to generate addresses");

        let flag: boolean;
        try {
          BuildAtomicSwapScript(
            sha256(secret3).slice(2),
            "",
            bobAddress,
            10,
            network
          );
          flag = false;
        } catch (e: any) {
          flag = true;
        }

        expect(flag).to.be.true;
      });

      it("Bob should be able to initiate a swap", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
          sha256(secret3).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        await sendBTC(bobB, atomicSwapScriptAddress, 100000000, 2);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const { data } = await axios.get(
          `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
        );

        expect(data.length).to.be.equal(1);

        const utxo = data[0];
        expect(utxo.value).to.be.equal(100000000);
      });

      // Alice redeems the swap on Bitcoin
      it("Alice should not be able to redeem a swap with invalid secret", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret3).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[2]), 0);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
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

      it("Alice should be able to redeem a swap with valid secret", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret3).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[2]), 0);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
              secret3,
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

        const aliceBalance = await getBalance(aliceAddress);
        expect(aliceBalance).to.be.equal(999998000);
      });

      it("Alice should not be able to redeem a swap with the same secret", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret3).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[2]), 0);
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
                aliceB.sign(signatureHash),
                hashType
              ),
              aliceB.publicKey,
              secret3,
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

      // Bob redeems the swap on Ethereum
      it("Bob should not be able to redeem a swap with no initiator", async () => {
        await expect(
          atomicSwap.connect(bobE).redeem(randomBytes(32))
        ).to.be.revertedWith(
          "AtomicSwap: order not initated or invalid secret"
        );
      });

      it("Bob should not be able to redeem a swap with invalid secret", async () => {
        await expect(
          atomicSwap.connect(bobE).redeem(randomBytes(32))
        ).to.be.revertedWith(
          "AtomicSwap: order not initated or invalid secret"
        );
      });

      it("Bob should be able to redeem a swap with valid secret", async () => {
        await expect(atomicSwap.connect(bobE).redeem(secret3))
          .to.emit(atomicSwap, "Redeemed")
          .withArgs(
            ethers.utils.sha256(secret3),
            ethers.utils.hexlify(secret3)
          );

        expect(await usdc.balanceOf(bobE.address)).to.equal(
          ethers.utils.parseUnits("200", 6n)
        );
      });

      it("Bob should not be able to redeem a swap with the same secret", async () => {
        await expect(
          atomicSwap.connect(bobE).redeem(secret3)
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });
    });

    describe("Refund -", () => {
      // Alice initiates a swap with Bob on Ethereum
      it("Alice should not be able to initiate a swap with no redeemer", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              ethers.constants.AddressZero,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: invalid redeemer address");
      });

      it("Alice should not be able to initiate a swap with no amount", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.constants.Zero,
              randomBytes(32)
            )
        ).to.be.revertedWith("AtomicSwap: amount cannot be zero");
      });

      it("Alice should not be able to initiate a swap with self as redeemer", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              aliceE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: redeemer and initiator cannot be the same"
        );
      });

      it("Alice should not be able to initiate a swap with a past block number", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) - 1,
              ethers.utils.parseUnits("100", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith(
          "AtomicSwap: expiry cannot be lower than current block"
        );
      });

      it("Alice should not be able to initiate a swap with amount greater than her allowance", async () => {
        await usdc
          .connect(aliceE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("100", 6n));
        expect(
          await usdc.allowance(aliceE.address, atomicSwap.address)
        ).to.equal(ethers.utils.parseUnits("100", 6n));

        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("200", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: insufficient allowance");
      });

      it("Alice should not be able to initiate a swap with amount greater than her balance", async () => {
        await usdc
          .connect(ownerE)
          .transfer(aliceE.address, ethers.utils.parseUnits("100", 6n));
        expect(await usdc.balanceOf(aliceE.address)).to.equal(
          ethers.utils.parseUnits("200", 6n)
        );

        await usdc
          .connect(aliceE)
          .approve(atomicSwap.address, ethers.utils.parseUnits("1000", 6n));
        expect(
          await usdc.allowance(aliceE.address, atomicSwap.address)
        ).to.equal(ethers.utils.parseUnits("1000", 6n));

        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("400", 6n),
              randomBytes(32)
            )
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });

      it("Alice should be able to initiate a swap", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret4)
            )
        )
          .to.emit(atomicSwap, "Initiated")
          .withArgs(
            ethers.utils.sha256(secret4),
            ethers.utils.parseUnits("100", 6n)
          );
      });

      it("Alice should not be able to initiate a swap with the same secret", async () => {
        await expect(
          atomicSwap
            .connect(aliceE)
            .initiate(
              bobE.address,
              (await latestBlock()) + 1000,
              ethers.utils.parseUnits("100", 6n),
              ethers.utils.sha256(secret4)
            )
        ).to.be.revertedWith("AtomicSwap: insecure secret hash");
      });

      // Bob initiates a swap with Alice on Bitcoin
      it("Bob should not be able to initiate a swap with no redeemer", async () => {
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!bobAddress) throw new Error("Unable to generate addresses");

        let flag: boolean;
        try {
          BuildAtomicSwapScript(
            sha256(secret4).slice(2),
            "",
            bobAddress,
            10,
            network
          );
          flag = false;
        } catch (e: any) {
          flag = true;
        }

        expect(flag).to.be.true;
      });

      it("Bob should be able to initiate a swap", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { address: atomicSwapScriptAddress } = BuildAtomicSwapScript(
          sha256(secret4).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        await sendBTC(bobB, atomicSwapScriptAddress, 100000000, 3);
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const { data } = await axios.get(
          `${indexerURL}/address/${atomicSwapScriptAddress}/utxo`
        );

        expect(data.length).to.be.equal(1);

        const utxo = data[0];
        expect(utxo.value).to.be.equal(100000000);
      });

      // Bob refunds the swap on Bitcoin
      it("Bob should not be able to refund a swap that is already redeemed", async () => {
        exec("nigiri rpc --generate 5", (err, stdout, stderr) => {
          if (err) throw err;
          if (stderr) throw new Error(stderr);
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret3).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[2]), 0, 10);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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

      it("Bob should not be able to refund a swap earlier than the locktime", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret4).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[3]), 0, 10);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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

      it("Bob should be able to refund a swap after the locktime", async () => {
        exec("nigiri rpc --generate 10", (err, stdout, stderr) => {
          if (err) throw err;
          if (stderr) throw new Error(stderr);
        });
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret4).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[3]), 0, 10);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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

        const bobBalance = await getBalance(bobAddress);
        expect(bobBalance).to.equal(999998000);
      });

      it("Alice should not be able to refund a swap that is already refunded", async () => {
        const aliceAddress = getP2PKHAddress(aliceB.publicKey, network);
        const bobAddress = getP2PKHAddress(bobB.publicKey, network);
        if (!aliceAddress || !bobAddress)
          throw new Error("Unable to generate addresses");

        const { AtomicSwapScript } = BuildAtomicSwapScript(
          sha256(secret4).slice(2),
          aliceAddress,
          bobAddress,
          10,
          network
        );

        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(idToHash(initTxHashes[3]), 0, 10);
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
              bitcoin.script.signature.encode(
                bobB.sign(signatureHash),
                hashType
              ),
              bobB.publicKey,
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

      // Alice refunds the swap on Ethereum
      it("Alice should not be able to refund a swap with no initiator", async () => {
        await expect(
          atomicSwap.connect(aliceE).refund(randomBytes(32))
        ).to.be.revertedWith("AtomicSwap: order not initated");
      });

      it("Alice should not be able to refund a swap that is already redeemed", async () => {
        await expect(
          atomicSwap.connect(aliceE).refund(ethers.utils.sha256(secret3))
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });

      it("Alice should not be able to refund a swap earlier than the locktime", async () => {
        await expect(
          atomicSwap.connect(aliceE).refund(ethers.utils.sha256(secret4))
        ).to.be.revertedWith("AtomicSwap: order not expired");
      });

      it("Alice should be able to refund a swap after the locktime", async () => {
        mine((await ethers.provider.getBlockNumber()) + 1000);

        await expect(
          atomicSwap.connect(aliceE).refund(ethers.utils.sha256(secret4))
        )
          .to.emit(atomicSwap, "Refunded")
          .withArgs(ethers.utils.sha256(secret4));

        expect(await usdc.balanceOf(aliceE.address)).to.equal(
          ethers.utils.parseUnits("200", 6n)
        );
      });

      it("Alice should not be able to refund a swap that is already refunded", async () => {
        await expect(
          atomicSwap.connect(aliceE).refund(ethers.utils.sha256(secret4))
        ).to.be.revertedWith("AtomicSwap: order already fulfilled");
      });
    });
  });
});
