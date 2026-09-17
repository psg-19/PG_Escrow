// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockINRC — a demo INR-denominated stablecoin.
/// @notice 2 decimals, so the smallest unit is one paisa and on-screen amounts
///         read as rupees (4500000 == Rs 45,000.00) instead of ETH fractions.
///         Freely mintable: this exists only to make the demo legible.
contract MockINRC is ERC20 {
    constructor() ERC20("Mock INR Coin", "INRC") {}

    function decimals() public pure override returns (uint8) {
        return 2;
    }

    /// @dev Open mint. Demo-only — never ship this.
    function mint(address to, uint256 amountPaise) external {
        _mint(to, amountPaise);
    }
}
