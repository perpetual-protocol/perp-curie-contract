// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

// replace variable type of origin contract
contract TestUpgradeableV3 is ERC20Upgradeable {
    struct struct1 {
        uint256 structNum;
    }
    int256 num1; // uint256 -> int256
    uint256 num2;

    function initialize(string memory name, string memory symbol) external initializer {
        __ERC20_init(name, symbol);
        num1 = 1;
        num2 = 2;
    }
}
