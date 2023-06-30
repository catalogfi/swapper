// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.18;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract AtomicSwap {
    IERC20 immutable token;

    struct Order {
        address redeemer;
        address initiator;
        uint256 expiry;
        uint256 amount;
        bool isFullfilled;
    }
    mapping(bytes32 => Order) AtomicSwapOrders;

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
        require(!order.isFullfilled, "AtomicSwap: cannot reuse secret");
        require(
            order.redeemer == address(0x0),
            "AtomicSwap: order already exists"
        );
        Order memory newOrder = Order({
            redeemer: _redeemer,
            initiator: msg.sender,
            expiry: _expiry,
            amount: _amount,
            isFullfilled: false
        });
        token.transferFrom(msg.sender, address(this), newOrder.amount);
        AtomicSwapOrders[_secretHash] = newOrder;
        emit Initiated(_secretHash, newOrder.amount);
    }

    function redeem(bytes calldata _secret) external {
        bytes32 secretHash = sha256(_secret);
        Order storage order = AtomicSwapOrders[secretHash];
        require(
            order.redeemer != address(0x0),
            "AtomicSwap: invalid secret or order not initiated"
        );
        require(!order.isFullfilled, "AtomicSwap: order already fullfilled");
        order.isFullfilled = true;
        token.transfer(order.redeemer, order.amount);
        emit Redeemed(secretHash, _secret);
    }

    function refund(bytes32 _secretHash) external {
        Order storage order = AtomicSwapOrders[_secretHash];
        require(
            order.redeemer != address(0x0),
            "AtomicSwap: order not initated"
        );
        require(!order.isFullfilled, "AtomicSwap: order already fullfilled");
        require(block.number > order.expiry, "AtomicSwap: lock not expired");
        order.isFullfilled = true;
        token.transfer(order.initiator, order.amount);
        emit Refunded(_secretHash);
    }
}
