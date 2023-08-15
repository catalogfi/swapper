import { expect, use } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { randomBytes } from "crypto";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { AtomicSwap, TestToken } from "../typechain-types";
import { solidity } from "ethereum-waffle";
import { latestBlock } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";

use(solidity);

describe("--- ATOMIC SWAP - ETHEREUM ---", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;

  let usdc: TestToken;

  let atomicSwap: AtomicSwap;

  let secret1: Buffer;
  let secret2: Buffer;
  let secret3: Buffer;
  let secret4: Buffer;

  let orderId1 : string;
  let orderId2 : string;
  let orderId3 : string;
  let orderId4 : string;

  before(async () => {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    const TestToken = await ethers.getContractFactory("TestToken");
    usdc = (await TestToken.deploy("USDC", "USDC", 6n, ethers.utils.parseUnits("100000000", 6n), owner.address)) as TestToken;
    await usdc.deployed();

    const AtomicSwap = await ethers.getContractFactory("AtomicSwap");
    atomicSwap = (await AtomicSwap.deploy(usdc.address)) as AtomicSwap;
    await atomicSwap.deployed();

    secret1 = randomBytes(32);
    secret2 = randomBytes(32);
    secret3 = randomBytes(32);
    secret4 = randomBytes(32);
  });

  describe("- Pre-conditions -", () => {
    it("All accounts should have valid addresses", async () => {
      expect(ethers.utils.isAddress(owner.address)).to.equal(true);
      expect(ethers.utils.isAddress(alice.address)).to.equal(true);
      expect(ethers.utils.isAddress(bob.address)).to.equal(true);
      expect(ethers.utils.isAddress(charlie.address)).to.equal(true);
    });

    it("All accounts should have different addresses", async () => {
      expect(owner.address).to.not.equal(alice.address);
      expect(owner.address).to.not.equal(bob.address);
      expect(owner.address).to.not.equal(charlie.address);
      expect(alice.address).to.not.equal(bob.address);
      expect(alice.address).to.not.equal(charlie.address);
      expect(bob.address).to.not.equal(charlie.address);
    });

    it("Owner should have 100M USDC", async () => {
      expect(await usdc.balanceOf(owner.address)).to.equal(ethers.utils.parseUnits("100000000", 6n));
    });

    it("All users' accounts should have 0 USDC", async () => {
      expect(await usdc.balanceOf(alice.address)).to.equal(0n);
      expect(await usdc.balanceOf(bob.address)).to.equal(0n);
      expect(await usdc.balanceOf(charlie.address)).to.equal(0n);
    });

    it("AtomicSwap should have 0 USDC", async () => {
      expect(await usdc.balanceOf(atomicSwap.address)).to.equal(0n);
    });

    it("Secrets should be different", async () => {
      expect(secret1).to.not.equal(secret2);
      expect(secret1).to.not.equal(secret3);
      expect(secret1).to.not.equal(secret4);
      expect(secret2).to.not.equal(secret3);
      expect(secret2).to.not.equal(secret4);
      expect(secret3).to.not.equal(secret4);
    });

    it("AtomicSwap should be deployed with correct USDC address", async () => {
      expect(await atomicSwap.token()).to.equal(usdc.address);
    });
  });

  describe("- Atomic Swap - Initiate -", () => {
    it("Alice should not be able to initiate a swap with no redeemer", async () => {
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(
            ethers.constants.AddressZero,
            1000,
            ethers.utils.parseUnits("100", 6n),
            randomBytes(32)
          )
      ).to.be.revertedWith("AtomicSwap: invalid redeemer address");
    });

    it("Alice should not be able to initiate a swap with no amount", async () => {
      await expect(
        atomicSwap.connect(alice).initiate(bob.address, 1000, ethers.constants.Zero, randomBytes(32))
      ).to.be.revertedWith("AtomicSwap: amount cannot be zero");
    });

    it("Alice should not be able to initiate a swap with self as redeemer", async () => {
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(alice.address,1000, ethers.utils.parseUnits("100", 6n), randomBytes(32))
      ).to.be.revertedWith("AtomicSwap: redeemer and initiator cannot be the same");
    });

    it("Alice should not be able to initiate a swap with a 0 expiry", async () => {
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address, 0, ethers.utils.parseUnits("100", 6n), randomBytes(32))
      ).to.be.revertedWith("AtomicSwap: expiry cannot be lower than current block");
    });

    it("Alice should not be able to initiate a swap with amount greater than her allowance", async () => {
      await usdc.connect(alice).approve(atomicSwap.address, ethers.utils.parseUnits("100", 6n));
      expect(await usdc.allowance(alice.address, atomicSwap.address)).to.equal(ethers.utils.parseUnits("100", 6n));

      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address, 1000, ethers.utils.parseUnits("200", 6n), randomBytes(32))
      ).to.be.revertedWith("ERC20: insufficient allowance");
    });

    it("Alice should not be able to initiate a swap with amount greater than her balance", async () => {
      await usdc.connect(owner).transfer(alice.address, ethers.utils.parseUnits("100", 6n));
      expect(await usdc.balanceOf(alice.address)).to.equal(ethers.utils.parseUnits("100", 6n));

      await usdc.connect(alice).approve(atomicSwap.address, ethers.utils.parseUnits("1000", 6n));
      expect(await usdc.allowance(alice.address, atomicSwap.address)).to.equal(ethers.utils.parseUnits("1000", 6n));

      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address, 1000, ethers.utils.parseUnits("200", 6n), randomBytes(32))
      ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
    });

    it("Alice should be able to initiate a swap", async () => {
      const currentBlock = await ethers.provider.getBlockNumber()
      orderId1 = ethers.utils.sha256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address", "uint256"],
            [
                ethers.utils.sha256(secret1),
                alice.address,
                currentBlock + 1,
            ]
        )
    );
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address, 1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret1))
      )
        .to.emit(atomicSwap, "Initiated")
        .withArgs(orderId1,ethers.utils.sha256(secret1),currentBlock+1, ethers.utils.parseUnits("100", 6n));
    });

    // TODO: use multicall to test
    // it("Alice should not be able to initiate a swap which generates same orderId", async () => {
    //   await ethers.provider.send("evm_setAutomine", [false]);
    //   const secret = randomBytes(32)
    //   atomicSwap
    //   .connect(alice)
    //   .initiate(bob.address, 1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret))
    //   const tx =
    //     await atomicSwap
    //       .connect(alice)
    //       .initiate(bob.address, 1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret))
      
    //   await ethers.provider.send("evm_mine", []);
    //   await ethers.provider.send("evm_setAutomine", [true]);
    //   expect(await tx.wait()).revertedWith("AtomicSwap: invalid secret")
    // });

    it("Alice should be able to initiate another swaps with different secret", async () => {
      await usdc.connect(owner).transfer(alice.address, ethers.utils.parseUnits("500", 6n));
      expect(await usdc.balanceOf(alice.address)).to.equal(ethers.utils.parseUnits("500", 6n));
      let currentBlock = await ethers.provider.getBlockNumber()
      orderId2 = ethers.utils.sha256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address", "uint256"],
            [
                ethers.utils.sha256(secret2),
                alice.address,
                currentBlock + 1,
            ]
        )
      )
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address, 1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret2))
      )
        .to.emit(atomicSwap, "Initiated")
        .withArgs(orderId2,ethers.utils.sha256(secret2),currentBlock+1, ethers.utils.parseUnits("100", 6n));

      currentBlock = await ethers.provider.getBlockNumber()
      orderId3 = ethers.utils.sha256(
        ethers.utils.defaultAbiCoder.encode(
            ["bytes32", "address", "uint256"],
            [
                ethers.utils.sha256(secret3),
                alice.address,
                currentBlock + 1,
            ]
        )
      )
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address,1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret3))
      )
        .to.emit(atomicSwap, "Initiated")
        .withArgs(orderId3,ethers.utils.sha256(secret3),currentBlock+1, ethers.utils.parseUnits("100", 6n));

        currentBlock = await ethers.provider.getBlockNumber()
        orderId4 = ethers.utils.sha256(
          ethers.utils.defaultAbiCoder.encode(
              ["bytes32", "address", "uint256"],
              [
                  ethers.utils.sha256(secret4),
                  alice.address,
                  currentBlock + 1,
              ]
          )
        )
      await expect(
        atomicSwap
          .connect(alice)
          .initiate(bob.address,  1000, ethers.utils.parseUnits("100", 6n), ethers.utils.sha256(secret4))
      )
        .to.emit(atomicSwap, "Initiated")
        .withArgs(orderId4,ethers.utils.sha256(secret4),currentBlock+1, ethers.utils.parseUnits("100", 6n));
    });
  });

  describe("- Atomic Swap - Redeem -", () => {
    it("Bob should not be able to redeem a swap with no initiator", async () => {
      await expect(atomicSwap.connect(bob).redeem(randomBytes(32),randomBytes(32))).to.be.revertedWith(
        "AtomicSwap: order not initated"
      );
    });

    it("Bob should not be able to redeem a swap with invalid orderId", async () => {
      await expect(atomicSwap.connect(bob).redeem(randomBytes(32),randomBytes(32))).to.be.revertedWith(
        "AtomicSwap: order not initated"
      );
    });

    it("Bob should not be able to redeem a swap with invalid secret", async () => {
      await expect(atomicSwap.connect(bob).redeem(orderId1,randomBytes(32))).to.be.revertedWith(
        "AtomicSwap: invalid secret"
      );
    });

    it("Bob should be able to redeem a swap with valid secret", async () => {
      await expect(atomicSwap.connect(bob).redeem(orderId1,secret1))
        .to.emit(atomicSwap, "Redeemed")
        .withArgs(ethers.utils.sha256(secret1), ethers.utils.hexlify(secret1));

      expect(await usdc.balanceOf(bob.address)).to.equal(ethers.utils.parseUnits("100", 6n));
    });

    it("Bob should not be able to redeem a swap with the same secret", async () => {
      await expect(atomicSwap.connect(bob).redeem(orderId1,secret1)).to.be.revertedWith("AtomicSwap: order already fulfilled");
    });

    it("Bob should receive the correct amount even if Charlie redeems with valid secret", async () => {
      await expect(atomicSwap.connect(charlie).redeem(orderId2,secret2))
        .to.emit(atomicSwap, "Redeemed")
        .withArgs(ethers.utils.sha256(secret2), ethers.utils.hexlify(secret2));

      expect(await usdc.balanceOf(bob.address)).to.equal(ethers.utils.parseUnits("200", 6n));
      expect(await usdc.balanceOf(charlie.address)).to.equal(ethers.utils.parseUnits("0", 6n));
    });
  });

  describe("- Atomic Swap - Refund -", () => {
    it("Alice should not be able to refund a swap with no initiator", async () => {
      await expect(atomicSwap.connect(alice).refund(randomBytes(32))).to.be.revertedWith("AtomicSwap: order not initated");
    });

    it("Alice should not be able to refund a swap that is already redeemed", async () => {
      await expect(atomicSwap.connect(alice).refund(orderId1)).to.be.revertedWith(
        "AtomicSwap: order already fulfilled"
      );
    });

    it("Alice should not be able to refund a swap earlier than the locktime", async () => {
      await expect(atomicSwap.connect(alice).refund(orderId3)).to.be.revertedWith(
        "AtomicSwap: order not expired"
      );
    });

    it("Alice should be able to refund a swap after the locktime", async () => {
      mine((await ethers.provider.getBlockNumber()) + 1000);

      await expect(atomicSwap.connect(alice).refund(orderId3))
        .to.emit(atomicSwap, "Refunded")
        .withArgs(orderId3);

      expect(await usdc.balanceOf(alice.address)).to.equal(ethers.utils.parseUnits("300", 6n));
    });

    it("Alice should not be able to refund a swap that is already refunded", async () => {
      await expect(atomicSwap.connect(alice).refund(orderId3)).to.be.revertedWith(
        "AtomicSwap: order already fulfilled"
      );
    });

    it("Alice should receive the correct amount even if Charlie refunds after the locktime", async () => {
      await expect(atomicSwap.connect(charlie).refund(orderId4))
        .to.emit(atomicSwap, "Refunded")
        .withArgs(orderId4);

      expect(await usdc.balanceOf(alice.address)).to.equal(ethers.utils.parseUnits("400", 6n));
      expect(await usdc.balanceOf(charlie.address)).to.equal(ethers.utils.parseUnits("0", 6n));
    });
  });
});
