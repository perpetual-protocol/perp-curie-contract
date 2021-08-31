// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";

library TokenBalance {
    using PerpSafeCast for uint256;
    using SignedSafeMath for int256;
    using PerpSafeCast for int256;

    struct Info {
        uint256 available;
        uint256 debt;
    }

    function addAvailable(TokenBalance.Info storage self, int256 delta) internal {
        self.available = self.available.toInt256().add(delta).toUint256();
    }

    function addDebt(TokenBalance.Info storage self, int256 delta) internal {
        self.debt = self.debt.toInt256().add(delta).toUint256();
    }
}
