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
        uint256 available;
        uint256 debt;
    }

    function addAvailable(TokenBalance.Info storage self, uint256 delta) internal {
        self.available = self.available.add(delta);
    }

    function addAvailable(TokenBalance.Info storage self, int256 delta) internal {
        self.available = self.available.toInt256().add(delta).toUint256();
    }

    function addDebt(TokenBalance.Info storage self, uint256 delta) internal {
        self.debt = self.debt.add(delta);
    }

    function addDebt(TokenBalance.Info storage self, int256 delta) internal {
        self.debt = self.debt.toInt256().add(delta).toUint256();
    }

    //
    // VIEW
    //
    function getNet(TokenBalance.Info memory self) internal pure returns (int256) {
        return self.available.toInt256().sub(self.debt.toInt256());
    }

    function getBurnable(TokenBalance.Info memory self) internal pure returns (uint256) {
        return MathUpgradeable.min(self.debt, self.available);
    }

    function isZero(TokenBalance.Info memory self) internal pure returns (bool) {
        return self.available == 0 && self.debt == 0;
    }
}
