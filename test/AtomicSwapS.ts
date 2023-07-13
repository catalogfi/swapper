import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AtomicSwapSpl } from "../target/types/atomic_swap_spl";
import * as ethers from "ethers";
import { expect } from "chai";
import * as spl from "@solana/spl-token";

describe("atomic_swap_spl_test_suite", () => {
  // Configure the client to use the local cluster.

  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);
  const program = anchor.workspace.AtomicSwapSpl as Program<AtomicSwapSpl>;
  let alice: anchor.web3.Keypair;
  let bob: anchor.web3.Keypair;
  let hacker: anchor.web3.Keypair;
  let payer: anchor.web3.Keypair;
  let redeemAccounts: Partial<RedeemAccounts>;
  let refundAccounts: Partial<RefundAccounts>;
  let atomicSwapTokenWallet: anchor.web3.PublicKey;
  let amount = new anchor.BN(100000);

  let expiry: anchor.BN;
  const expiryDelta: number = 2;
  let secretBytes: Array<number>;
  let secretHashBytes: Array<number>;
  let tokenMint: anchor.web3.PublicKey;
  let atomicSwapPK: anchor.web3.PublicKey;
  let aliceTokenAccount: anchor.web3.PublicKey;
  let bobTokenAccount: anchor.web3.PublicKey;
  let payerTokenAccount: anchor.web3.PublicKey;

  type RefundAccounts = {
    atomicSwap: anchor.web3.PublicKey;
    atomicSwapWallet: anchor.web3.PublicKey;
    refunder: anchor.web3.PublicKey;
    refunderWallet: anchor.web3.PublicKey;
    tokenProgram: anchor.web3.PublicKey;
    clock: anchor.web3.PublicKey;
    systemProgram: anchor.web3.PublicKey;
  };
  type RedeemAccounts = {
    atomicSwap: anchor.web3.PublicKey;
    atomicSwapWallet: anchor.web3.PublicKey;
    redeemer: anchor.web3.PublicKey;
    signer: anchor.web3.PublicKey;
    redeemerWallet: anchor.web3.PublicKey;
    tokenProgram: anchor.web3.PublicKey;
    systemProgram: anchor.web3.PublicKey;
  };

  const getPdaParams = async (): Promise<[anchor.web3.PublicKey, number]> => {
    return anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("atomic_swap"), alice.publicKey.toBuffer()],
      program.programId
    );
  };

  const createMint = async (): Promise<anchor.web3.PublicKey> => {
    const tokenMint = new anchor.web3.Keypair();
    const lamportsForMint =
      await provider.connection.getMinimumBalanceForRentExemption(
        spl.MintLayout.span
      );
    let tx = new anchor.web3.Transaction();

    // Allocate mint
    tx.add(
      anchor.web3.SystemProgram.createAccount({
        programId: spl.TOKEN_PROGRAM_ID,
        space: spl.MintLayout.span,
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: tokenMint.publicKey,
        lamports: lamportsForMint,
      })
    );
    // Allocate wallet account
    tx.add(
      spl.createInitializeMintInstruction(
        tokenMint.publicKey,
        6,
        provider.wallet.publicKey,
        provider.wallet.publicKey
      )
    );
    await provider.sendAndConfirm(tx, [tokenMint]);
    return tokenMint.publicKey;
  };

  const getFundedAssociatedTokenAccount = async (
    user: anchor.web3.Keypair,
    mint?: anchor.web3.PublicKey
  ): Promise<anchor.web3.PublicKey | undefined> => {
    let userAssociatedTokenAccount: anchor.web3.PublicKey | undefined =
      undefined;

    if (mint) {
      // Create a token account for the user and mint some tokens
      userAssociatedTokenAccount = await spl.getAssociatedTokenAddress(
        mint,
        user.publicKey,
        true,
        spl.TOKEN_PROGRAM_ID
      );

      const txFundTokenAccount = new anchor.web3.Transaction();
      txFundTokenAccount.add(
        spl.createAssociatedTokenAccountInstruction(
          user.publicKey,
          userAssociatedTokenAccount,
          user.publicKey,
          mint,
          spl.TOKEN_PROGRAM_ID
        )
      );
      txFundTokenAccount.add(
        spl.createMintToInstruction(
          mint,
          userAssociatedTokenAccount,
          provider.wallet.publicKey,
          1000000000,
          []
        )
      );
      await provider.sendAndConfirm(txFundTokenAccount, [user]);
    }
    return userAssociatedTokenAccount;
  };

  const readAccount = async (
    accountPublicKey: anchor.web3.PublicKey,
    provider: anchor.Provider
  ): Promise<[spl.RawAccount, string]> => {
    const tokenInfoLol = await provider.connection.getAccountInfo(
      accountPublicKey
    );
    const data = Buffer.from(tokenInfoLol!.data);
    const accountInfo: spl.RawAccount = spl.AccountLayout.decode(data);

    const amount = accountInfo.amount;
    return [accountInfo, amount.toString()];
  };

  beforeEach(async () => {
    // await provider.connection.confirmTransaction(await provider.connection.requestAirdrop(provider.wallet.publicKey, 10000000000000));
    alice = new anchor.web3.Keypair();
    bob = new anchor.web3.Keypair();
    hacker = new anchor.web3.Keypair();
    payer = new anchor.web3.Keypair();
    [atomicSwapPK] = await getPdaParams();
    tokenMint = await createMint();
    atomicSwapTokenWallet = spl.getAssociatedTokenAddressSync(
      tokenMint,
      atomicSwapPK,
      true
    );
    const secret = ethers.utils.randomBytes(32);
    secretBytes = [];
    secretBytes.push(...secret);
    expiry = new anchor.BN(Math.floor(Date.now() / 1000) + expiryDelta);

    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(alice.publicKey, 10000000000000)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(bob.publicKey, 10000000000000)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(hacker.publicKey, 10000000000000)
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 10000000000000)
    );

    const secretHash = ethers.utils.sha256(secret);
    secretHashBytes = [];
    secretHashBytes.push(...anchor.utils.bytes.hex.decode(secretHash));

    aliceTokenAccount =
      (await getFundedAssociatedTokenAccount(alice, tokenMint)) ??
      new anchor.web3.PublicKey("");

    bobTokenAccount =
      (await getFundedAssociatedTokenAccount(bob, tokenMint)) ??
      new anchor.web3.PublicKey("");
    payerTokenAccount =
      (await getFundedAssociatedTokenAccount(payer, tokenMint)) ??
      new anchor.web3.PublicKey("");
    redeemAccounts = {
      atomicSwap: atomicSwapPK,
      atomicSwapWallet: atomicSwapTokenWallet,
      redeemerWallet: bobTokenAccount,
    };

    refundAccounts = {
      atomicSwap: atomicSwapPK,
      atomicSwapWallet: atomicSwapTokenWallet,
      refunderWallet: aliceTokenAccount,
    };
  });

  it("Alice should Initiate atomic swap", async () => {
    const sig = await program.methods
      .initialize(bob.publicKey, secretHashBytes, amount, expiry)
      .accounts({
        atomicSwap: atomicSwapPK,
        atomicSwapWallet: atomicSwapTokenWallet,
        feePayer: payer.publicKey,
        signerWallet: aliceTokenAccount,
        signer: alice.publicKey,
        tokenMint: tokenMint,
      })
      .signers([payer, alice])
      .rpc();
    expect(sig).to.be.not.null;
  });

  it("Bob can redeem SPL token with the secret", async () => {
    await program.methods
      .initialize(bob.publicKey, secretHashBytes, amount, expiry)
      .accounts({
        atomicSwap: atomicSwapPK,
        atomicSwapWallet: atomicSwapTokenWallet,
        feePayer: payer.publicKey,
        signerWallet: aliceTokenAccount,
        signer: alice.publicKey,
        tokenMint: tokenMint,
      })
      .signers([payer, alice])
      .rpc();

    const [, atomicWalletBalanceBefore] = await readAccount(
      atomicSwapTokenWallet,
      provider
    );
    expect(atomicWalletBalanceBefore).to.equal(amount.toString());

    await program.methods.redeem(secretBytes).accounts(redeemAccounts).rpc();
    const [, atomicWalletBalanceAfter] = await readAccount(
      atomicSwapTokenWallet,
      provider
    );
    expect(+atomicWalletBalanceBefore - +atomicWalletBalanceAfter).to.equal(
      amount.toNumber()
    );
  });

  it("Bob cannot redeem SPL token with an invalid secret", async () => {
    await program.methods
      .initialize(bob.publicKey, secretHashBytes, amount, expiry)
      .accounts({
        atomicSwap: atomicSwapPK,
        atomicSwapWallet: atomicSwapTokenWallet,
        feePayer: payer.publicKey,
        signerWallet: aliceTokenAccount,
        signer: alice.publicKey,
        tokenMint: tokenMint,
      })
      .signers([payer, alice])
      .rpc();
    let invalidSecret: Array<number> = [];
    invalidSecret.push(...ethers.utils.randomBytes(32));
    expect(program.methods.redeem(invalidSecret).accounts(redeemAccounts).rpc())
      .throws;
  });

  it("Alice can not refund SPL token before expiry", async () => {
    await program.methods
      .initialize(bob.publicKey, secretHashBytes, amount, expiry)
      .accounts({
        atomicSwap: atomicSwapPK,
        atomicSwapWallet: atomicSwapTokenWallet,
        feePayer: payer.publicKey,
        signerWallet: aliceTokenAccount,
        signer: alice.publicKey,
        tokenMint: tokenMint,
      })
      .signers([payer, alice])
      .rpc();
    expect(program.methods.refund().accounts(refundAccounts).rpc()).throws;
  });

  it("Alice can refund SPL token after expiry", async () => {
    await program.methods
      .initialize(bob.publicKey, secretHashBytes, amount, expiry)
      .accounts({
        atomicSwap: atomicSwapPK,
        atomicSwapWallet: atomicSwapTokenWallet,
        feePayer: payer.publicKey,
        signerWallet: aliceTokenAccount,
        signer: alice.publicKey,
        tokenMint: tokenMint,
      })
      .signers([payer, alice])
      .rpc();
    const [, atomicWalletBalanceBefore] = await readAccount(
      atomicSwapTokenWallet,
      provider
    );
    expect(atomicWalletBalanceBefore).to.equal(amount.toString());
    const acc = await spl.getAssociatedTokenAddress(tokenMint, alice.publicKey);
    const aliceBalanceBefore = (await spl.getAccount(provider.connection, acc))
      .amount;
    await new Promise((f) => setTimeout(f, expiryDelta * 1000));
    await program.methods.refund().accounts(refundAccounts).rpc();

    const [, atomicWalletBalanceAfter] = await readAccount(
      atomicSwapTokenWallet,
      provider
    );
    const aliceBalanceAfter = (await spl.getAccount(provider.connection, acc))
      .amount;
    expect(+atomicWalletBalanceBefore - +atomicWalletBalanceAfter).to.equal(
      +aliceBalanceAfter.toString() - +aliceBalanceBefore.toString()
    );
  });
});
