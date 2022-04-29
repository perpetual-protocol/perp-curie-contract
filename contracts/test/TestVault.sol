// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../Vault.sol";

contract TestVault is Vault {
    function testGetMaxRepaidSettlement(address trader) external view returns (uint256) {
        return _getMaxRepaidSettlement(trader);
    }
}
