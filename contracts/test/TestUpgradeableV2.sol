// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

// insert a new variable to origin contract
contract TestUpgradeableV2 is ERC20Upgradeable {
    struct struct1 {
        uint256 structNum;
    }
    struct1 structTest;
    uint256 num1;
    string str1; // insert string
    uint256 num2;

    function initialize(string memory name, string memory symbol) external initializer {
        __ERC20_init(name, symbol);
        num1 = 1;
        num2 = 2;
    }
}
