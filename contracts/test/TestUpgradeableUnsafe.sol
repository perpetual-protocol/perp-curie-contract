// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

// unsafe example ref : https://docs.openzeppelin.com/upgrades-plugins/1.x/faq#how-can-i-disable-checks
contract TestUpgradeableUnsafe {
    uint256 num1;
    uint256 num2;
    // state-variable-assignment
    uint256 num3 = 10;

    // constructor
    constructor() {
        num1 = 1;
        num2 = 2;
    }

    function initialize(uint256 _num1, uint256 _num2) public {
        num1 = _num1;
        num2 = _num2;
    }

    // delegatecall
    fallback() external {
        address(0).delegatecall(abi.encode("arg"));
    }
}
