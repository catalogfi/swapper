import { expect, use } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { AtomicSwap, TestERC20 } from "../typechain-types/";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { solidity } from "ethereum-waffle";

use(solidity);

describe("AtomicSwap", function () {
    let TestERC20: TestERC20;
    let OWNER: HardhatEthersSigner;
    let ALICE: HardhatEthersSigner;
    let BOB: HardhatEthersSigner;
    let AtomicSwap: AtomicSwap;

    before(async () => {
        [OWNER, ALICE, BOB] = await ethers.getSigners();
        const AtomicSwapFactory = await ethers.getContractFactory("AtomicSwap");

        const TestERC20Factory = await ethers.getContractFactory("TestERC20");
        TestERC20 = await TestERC20Factory.deploy();
        (
            await TestERC20.transfer(ALICE.address, "10000000000000000000")
        ).wait();
        (await TestERC20.transfer(BOB.address, "10000000000000000000")).wait();
        AtomicSwap = await AtomicSwapFactory.deploy(TestERC20.address);
    });
    it("ALICE should be able to redeem", async () => {
        const secret = ethers.utils.randomBytes(32);
        const hash = ethers.utils.sha256(secret);
        const amount = 1000;
        const expiryDurtion = 100;

        const AliceBalanceBefore = await TestERC20.balanceOf(ALICE.address);

        const apptx = await TestERC20.connect(BOB).approve(
            AtomicSwap.address,
            amount
        );
        await apptx.wait();
        const tx1 = await AtomicSwap.connect(BOB).initiate(
            ALICE.address,
            expiryDurtion,
            amount,
            hash
        );
        await tx1.wait();
        console.log(tx1.hash);
        const tx2 = await AtomicSwap.connect(ALICE).redeem(secret);
        await tx2.wait();

        const AliceBalanceAfter = await TestERC20.balanceOf(ALICE.address);
        console.log("addr", AliceBalanceAfter, AliceBalanceBefore);

        expect(
            BigInt(AliceBalanceAfter) - BigInt(AliceBalanceBefore)
        ).to.be.equal(BigInt(amount));
    });
    it("ALICE should not be able to redeem with wrong secret", async () => {
        const secret = ethers.utils.randomBytes(32);
        const wrongSecret = ethers.utils.randomBytes(32);
        const hash = ethers.utils.sha256(secret);
        const amount = 1000;
        const expiryDurtion = 100;

        const apptx = await TestERC20.connect(BOB).approve(
            AtomicSwap.address,
            amount
        );
        await apptx.wait();
        const tx1 = await AtomicSwap.connect(BOB).initiate(
            ALICE.address,
            expiryDurtion,
            amount,
            hash
        );
        await tx1.wait();
        await expect(
            AtomicSwap.connect(ALICE).redeem(wrongSecret)
        ).revertedWith("AtomicSwap: invalid secret or order not initiated");
    });
    it("ALICE should not be able to reuse secret", async () => {
        const secret = ethers.utils.randomBytes(32);
        const hash = ethers.utils.sha256(secret);
        const amount = 1000;
        const expiryDurtion = 100;

        const apptx = await TestERC20.connect(BOB).approve(
            AtomicSwap.address,
            amount
        );
        await apptx.wait();
        const tx1 = await AtomicSwap.connect(BOB).initiate(
            ALICE.address,
            expiryDurtion,
            amount,
            hash
        );
        await tx1.wait();
        const tx2 = await AtomicSwap.connect(ALICE).redeem(secret);
        await tx2.wait();
        const apptx1 = await TestERC20.connect(BOB).approve(
            AtomicSwap.address,
            amount
        );
        await apptx1.wait();
        await expect(
            AtomicSwap.connect(BOB).initiate(
                BOB.address,
                expiryDurtion,
                amount,
                hash
            )
        ).revertedWith("AtomicSwap: insecure secret hash");
    });
    it("BOB should be able to refund", async () => {
        const secret = ethers.utils.randomBytes(32);
        const hash = ethers.utils.sha256(secret);
        const amount = 1000;
        const expiryDurtion = 100;

        const AliceBalanceBefore = await TestERC20.balanceOf(ALICE.address);
        const BobBalanceBefore = await TestERC20.balanceOf(BOB.address);

        const apptx = await TestERC20.connect(BOB).approve(
            AtomicSwap.address,
            amount
        );
        await apptx.wait();
        const tx1 = await AtomicSwap.connect(BOB).initiate(
            ALICE.address,
            (await ethers.provider.getBlockNumber()) + expiryDurtion,
            amount,
            hash
        );
        await tx1.wait();
        await mine(expiryDurtion - 1);
        const tx2 = await AtomicSwap.connect(BOB).refund(hash);
        await tx2.wait();

        const AliceBalanceAfter = await TestERC20.balanceOf(ALICE.address);
        const BobBalanceAfter = await TestERC20.balanceOf(BOB.address);

        expect(AliceBalanceAfter).to.be.equal(AliceBalanceBefore);
        expect(BobBalanceAfter).to.be.equal(BobBalanceBefore);
    });
});
