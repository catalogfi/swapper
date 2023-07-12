use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount, Transfer};
use solana_program::clock::Clock;
use solana_program::hash::hash;

declare_id!("4NJ18xSDkkU9Pt8rAB9zwfYzgP7nmW4Wat9ZfuVT8mrU");

#[program]
mod atomic_swap_spl {

    use super::*;
    pub fn initialize(
        ctx: Context<Initialize>,
        redeemer: Pubkey,
        secret_hash: [u8; 32],
        amount: u64,
        expiry: i64,
    ) -> Result<()> {
        ctx.accounts.atomic_swap.bump = *ctx.bumps.get("atomic_swap").unwrap();
        ctx.accounts.atomic_swap.redeemer = redeemer;
        ctx.accounts.atomic_swap.refunder = ctx.accounts.signer.key();
        ctx.accounts.atomic_swap.secret_hash = secret_hash;
        ctx.accounts.atomic_swap.secret = secret_hash;
        ctx.accounts.atomic_swap.amount = amount;
        ctx.accounts.atomic_swap.expiry = expiry;
        ctx.accounts.atomic_swap.status = 1;
        
        let transfer_instruction = Transfer {
            from: ctx.accounts.signer_wallet.to_account_info(),
            to: ctx.accounts.atomic_swap_wallet.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };

        //CPI context to send into the transfer instruction
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
        );
        anchor_spl::token::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    pub fn redeem(ctx: Context<Redeem>, secret: [u8; 32]) -> Result<()> {
        require!(
            hash(&secret).to_bytes() == ctx.accounts.atomic_swap.secret_hash,
            AtomicSwapError::SecretMismatch
        );
        require!(
            ctx.accounts.atomic_swap.status == 1,
            AtomicSwapError::RedeemWithoutInitiation
        );

        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.atomic_swap_wallet.to_account_info(),
                    to: ctx.accounts.redeemer_wallet.to_account_info(),
                    authority: ctx.accounts.atomic_swap.to_account_info(),
                },
                &[&["atomic_swap".as_bytes(), ctx.accounts.atomic_swap.refunder.as_ref(), &[ctx.accounts.atomic_swap.bump]]],
            ),
            ctx.accounts.atomic_swap.amount,
        )?;

        ctx.accounts.atomic_swap.secret = secret;
        ctx.accounts.atomic_swap.status = 2;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        require!(
            ctx.accounts.clock.unix_timestamp > ctx.accounts.atomic_swap.expiry,
            AtomicSwapError::HasNotExpired
        );
        require!(
            ctx.accounts.atomic_swap.status == 1,
            AtomicSwapError::RefundWithoutInitiation
        );
        msg!(
            "AtomicSwap expired secret {:X?}!",
            ctx.accounts.atomic_swap.secret_hash
        );
        
        anchor_spl::token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.atomic_swap_wallet.to_account_info(),
                    to: ctx.accounts.refunder_wallet.to_account_info(),
                    authority: ctx.accounts.atomic_swap.to_account_info(),
                },
                &[&["atomic_swap".as_bytes(), ctx.accounts.atomic_swap.refunder.as_ref(), &[ctx.accounts.atomic_swap.bump]]],
            ),
            ctx.accounts.atomic_swap.amount,
        )?;
        
        ctx.accounts.atomic_swap.status = 3;
        Ok(())
    } 
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = fee_payer, 
        seeds = [b"atomic_swap".as_ref(), signer.key().as_ref()],
        bump,
        space = 8 + 1 + 32 + 32 + 32 + 32 + 8 + 8 + 1)]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(
        // Initializing the associated token account only if required
        // Have to read the security aspect of this and remove
        init_if_needed,
        payer = fee_payer,
        // Check if the associated token mint is same as the token mint sent.
        associated_token::mint = token_mint,
        // Check if the authority is user
        associated_token::authority = atomic_swap,
    )]
    pub atomic_swap_wallet: Account<'info, TokenAccount>,
    #[account(mut)]
    pub fee_payer: Signer<'info>,
    #[account(mut)]
    pub signer_wallet: Account<'info, TokenAccount>,
    #[account(mut)]
    pub signer: Signer<'info>,
    pub token_mint: Account<'info, Mint>, //let's say USDC
    pub token_program:Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(mut)]
    pub atomic_swap_wallet: Account<'info, TokenAccount>,
    #[account(mut, constraint = redeemer_wallet.owner == atomic_swap.redeemer @ AtomicSwapError::InvalidRedeemer)]
    pub redeemer_wallet: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub atomic_swap: Account<'info, AtomicSwap>,
    #[account(mut)]
    pub atomic_swap_wallet: Account<'info, TokenAccount>,
    #[account(mut, constraint = refunder_wallet.owner == atomic_swap.refunder @ AtomicSwapError::InvalidRefunder)]
    pub refunder_wallet: Account<'info, TokenAccount>,
    pub token_program:Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct AtomicSwap {
    bump: u8,
    refunder: Pubkey,
    redeemer: Pubkey,
    secret_hash: [u8; 32],
    secret: [u8; 32],
    expiry: i64,
    amount: u64,
    status: u8,
}

#[error_code]
pub enum AtomicSwapError {
    RedeemWithoutInitiation,
    RefundWithoutInitiation,
    InvalidRedeemer,
    InvalidRefunder,
    SecretMismatch,
    HasNotExpired,
}