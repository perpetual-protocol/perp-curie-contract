// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/MathUpgradeable.sol";

library TokenBalance {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for int256;

    struct Info {
        int256 balance;
    }

    function addBalance(TokenBalance.Info storage self, uint256 delta) internal {
        self.balance = self.balance.add(delta.toInt256());
    }

    function addBalance(TokenBalance.Info storage self, int256 delta) internal {
        self.balance = self.balance.add(delta);
    }

    //
    // VIEW
    //

    // TODO : not sure remove or not
    // function getBurnable(TokenBalance.Info memory self) internal pure returns (uint256) {
    //     return Math.min(self.debt, self.available);
    // }
}
