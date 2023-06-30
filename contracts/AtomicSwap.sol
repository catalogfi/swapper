// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract AtomicSwap {
    using SafeERC20 for IERC20;
    IERC20 immutable token;

    struct Order {
        address redeemer;
        address initiator;
        uint256 expiry;
        uint256 amount;
        bool isFulfilled;
    }
    mapping(bytes32 => Order) atomicSwapOrders;

    event Redeemed(bytes32 indexed secrectHash, bytes _secret);
    event Initiated(bytes32 indexed secrectHash, uint256 amount);
    event Refunded(bytes32 indexed secrectHash);

    modifier checkSafe(
        address redeemer,
        address intiator,
        uint256 expiry
    ) {
        _;
        require(
            redeemer != address(0),
            "AtomicSwap: redeemer cannot be null address"
        );
        require(
            intiator != redeemer,
            "AtomicSwap: initiator cannot be equal to redeemer"
        );
        require(
            expiry > block.number,
            "AtomicSwap: expiry cannot be lower than current block"
        );
    }

    constructor(address _token) {
        token = IERC20(_token);
    }

    function initiate(
        address _redeemer,
        uint256 _expiry,
        uint256 _amount,
        bytes32 _secretHash
    ) external checkSafe(_redeemer, msg.sender, _expiry) {
        Order memory order = AtomicSwapOrders[_secretHash];
        require(
            order.redeemer == address(0x0),
            "AtomicSwap: insecure secret hash"
        );
        Order memory newOrder = Order({
            redeemer: _redeemer,
            initiator: msg.sender,
            expiry: _expiry,
            amount: _amount,
            isFulfilled: false
        });
        AtomicSwapOrders[_secretHash] = newOrder;
        emit Initiated(_secretHash, newOrder.amount);
        token.safeTransferFrom(msg.sender, address(this), newOrder.amount);
    }

    function redeem(bytes calldata _secret) external {
        bytes32 secretHash = sha256(_secret);
        Order storage order = AtomicSwapOrders[secretHash];
        require(
            order.redeemer != address(0x0),
            "AtomicSwap: invalid secret or order not initiated"
        );
        require(!order.isFulfilled, "AtomicSwap: order already fullfilled");
        order.isFulfilled = true;
        emit Redeemed(secretHash, _secret);
        token.safeTransfer(order.redeemer, order.amount);
    }

    function refund(bytes32 _secretHash) external {
        Order storage order = AtomicSwapOrders[_secretHash];
        require(
            order.redeemer != address(0x0),
            "AtomicSwap: order not initated"
        );
        require(!order.isFulfilled, "AtomicSwap: order already fullfilled");
        require(block.number > order.expiry, "AtomicSwap: lock not expired");
        order.isFulfilled = true;
        emit Refunded(_secretHash);
        token.safeTransfer(order.initiator, order.amount);
    }
}
