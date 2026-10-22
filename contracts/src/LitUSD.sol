// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title LitUSD — a test stablecoin for running dollar-denominated payroll on LitVM testnet
/// @notice Anyone can drip 50,000 LitUSD once an hour. Worthless by design.
contract LitUSD is ERC20 {
    uint256 public constant DRIP_AMOUNT = 50_000e18;
    uint256 public constant DRIP_COOLDOWN = 1 hours;

    mapping(address => uint256) public lastDrip;

    error DripCooldown(uint256 readyAt);

    constructor() ERC20("Lit USD (testnet)", "LitUSD") {}

    function drip() external {
        uint256 last = lastDrip[msg.sender];
        if (last != 0 && block.timestamp < last + DRIP_COOLDOWN) revert DripCooldown(last + DRIP_COOLDOWN);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, DRIP_AMOUNT);
    }
}
