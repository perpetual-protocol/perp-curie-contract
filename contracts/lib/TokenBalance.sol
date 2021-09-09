// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { Math } from "@openzeppelin/contracts/math/Math.sol";

library TokenBalance {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using SignedSafeMath for int256;
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
