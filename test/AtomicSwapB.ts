import { expect } from "chai";
import { randomBytes } from "crypto";
import { sha256 } from "ethers/lib/utils";
import { BitcoinProviderAS } from "../bitcoin/btc-compat";
import { BTCAtomicSwap, executeAliceAtomicSwap, executeBobAtomicSwap } from "../bitcoin";

require("dotenv").config();

describe("--- ATOMIC SWAP - BITCOIN ---", () => {
  const alicePK = process.env.BITCOIN_TESTNET_PRIVATE_KEY_1;
  const bobPK = process.env.BITCOIN_TESTNET_PRIVATE_KEY_2;
  const charliePK = process.env.BITCOIN_TESTNET_PRIVATE_KEY_3;

  let alice: BitcoinProviderAS;
  let bob: BitcoinProviderAS;
  let charlie: BitcoinProviderAS;

  let secret1: Buffer;
  let secret2: Buffer;
  let secret3: Buffer;
  let secret4: Buffer;

  before(() => {
    if (!alicePK || !bobPK || !charliePK) {
      throw new Error("Missing private keys");
    }
    alice = new BitcoinProviderAS(alicePK);
    bob = new BitcoinProviderAS(bobPK);
    charlie = new BitcoinProviderAS(charliePK);

    secret1 = randomBytes(32);
    secret2 = randomBytes(32);
    secret3 = randomBytes(32);
    secret4 = randomBytes(32);
  });

  describe("- Pre-conditions -", () => {
    it("Users should have different private keys", () => {
      expect(alicePK).to.not.equal(bobPK);
      expect(alicePK).to.not.equal(charliePK);
      expect(bobPK).to.not.equal(charliePK);
    });

    it("Users should have different addresses", async () => {
      const aliceAddress = await alice.getAddress();
      const bobAddress = await bob.getAddress();
      const charlieAddress = await charlie.getAddress();
      expect(aliceAddress).to.not.equal(bobAddress);
      expect(aliceAddress).to.not.equal(charlieAddress);
      expect(bobAddress).to.not.equal(charlieAddress);
    });

    it("Users should have balance", async () => {
      const aliceBalance = await alice.getBalance(alice.getAddress());
      const bobBalance = await bob.getBalance(bob.getAddress());
      const charlieBalance = await charlie.getBalance(charlie.getAddress());
      expect(aliceBalance).to.be.greaterThan(0);
      expect(bobBalance).to.be.greaterThan(0);
      expect(charlieBalance).to.be.greaterThan(0);
    });

    it("Secrets should be different", () => {
      expect(secret1).to.not.equal(secret2);
      expect(secret1).to.not.equal(secret3);
      expect(secret1).to.not.equal(secret4);
      expect(secret2).to.not.equal(secret3);
      expect(secret2).to.not.equal(secret4);
      expect(secret3).to.not.equal(secret4);
    });
  });

  describe("- Atomic Swap - Initiate -", () => {
    it("Alice should not be able to initiate a swap with no redeemer", async () => {});

    it("Alice should not be able to initiate a swap with no amount", async () => {});

    it("Alice should not be able to initiate a swap with self as redeemer", async () => {});

    it("Alice should not be able to initiate a swap with a past block number", async () => {});

    it("Alice should not be able to initiate a swap with amount greater than her balance", async () => {});

    it("Alice should be able to initiate a swap", async () => {});

    it("Alice should not be able to initiate a swap with the same secret hash", async () => {});

    it("Alice should be able to initiate another swaps with different secret", async () => {});
  });

  describe("- Atomic Swap - Redeem -", () => {
    it("Bob should not be able to redeem a swap with no initiator", async () => {});

    it("Bob should not be able to redeem a swap with invalid secret", async () => {});

    it("Bob should be able to redeem a swap with valid secret", async () => {});

    it("Bob should not be able to redeem a swap with the same secret", async () => {});

    it("Bob should receive the correct amount even if Charlie redeems with valid secret", async () => {});
  });

  describe("- Atomic Swap - Refund -", () => {
    it("Alice should not be able to refund a swap with no initiator", async () => {});

    it("Alice should not be able to refund a swap that is already redeemed", async () => {});

    it("Alice should not be able to refund a swap earlier than the locktime", async () => {});

    it("Alice should be able to refund a swap after the locktime", async () => {});

    it("Alice should not be able to refund a swap that is already refunded", async () => {});

    it("Alice should receive the correct amount even if Charlie refunds after the locktime", async () => {});
  });
});
