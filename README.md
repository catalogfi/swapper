# Atomic Swap Contract

This is a Solidity smart contract that implements an HTLC (Hash Time Lock Contract) for atomic swaps. The contract allows signers to create orders that can be used for cross-chain atomic swaps.

## Overview

An atomic swap is a trustless and decentralized mechanism that enables the exchange of assets between different blockchains. It ensures that either both parties involved in the swap successfully complete the exchange, or the transaction is canceled and no assets are lost.

This contract provides the following functionalities for two types of users:

### Initiator Functions:
1. `initiate`: Initiators can create an order by providing the necessary order parameters. The order serves as one-half of the atomic swap commitment.
2. `refund`: Initiators can refund the locked assets after the expiry block number if the redemption has not occurred.

### Redeemer Functions:
1. `redeem`: Redeemers can use the correct secret to an order's secret hash to claim the locked tokens.

## Contract Details

- Solidity Version: ^0.8.18
- License: UNLICENSED (SPDX-License-Identifier)
- Dependencies: OpenZeppelin's SafeERC20 library for safe token transfers

## Usage

To use this contract, follow these steps:

1. Deploy the `AtomicSwap` contract on the Ethereum blockchain, passing the address of the ERC20 token contract as a constructor parameter.
2. Users can interact with the contract using the provided functions:
   - Initiators can call the `initiate` function to create an order by providing the redeemer's address, expiry block number, amount of tokens to trade, and the secret hash for redemption.
   - Redeemers can call the `redeem` function with the correct secret to claim the locked tokens.
   - If the redemption is not completed, either party can call the `refund` function after the expiry block number to retrieve their locked assets.

## Security Considerations

- The contract ensures that the redeemer's address is not the null address, the redeemer is not the same as the initiator, the expiry block number is greater than the current block number, and the amount of tokens to trade is not zero.
- Initiators cannot generate orders with the same secret hash or override an existing order.
- Redeemers cannot redeem an order with the wrong secret or redeem the same order multiple times.
- Refunds are only possible after the expiry block number and can't be performed multiple times.

It is important to carefully review and test the contract before deploying it to the Ethereum mainnet or any other production environment.

## Events

The contract emits the following events:

- `Redeemed(bytes32 indexed secretHash, bytes _secret)`: Triggered when an order is successfully redeemed, providing the secret hash and the secret used for redemption.
- `Initiated(bytes32 indexed secretHash, uint256 amount)`: Triggered when an order is successfully initiated, providing the secret hash and the amount of tokens involved.
- `Refunded(bytes32 indexed secretHash)`: Triggered when an order is refunded, providing the secret hash.