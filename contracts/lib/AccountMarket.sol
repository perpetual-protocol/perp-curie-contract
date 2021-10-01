// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { PerpFixedPoint96 } from "./PerpFixedPoint96.sol";

library AccountMarket {
    using SignedSafeMathUpgradeable for int256;

    /// @param lastTwPremiumGrowthGlobalX96 the last time weighted premiumGrowthGlobalX96
    struct Info {
        int256 baseBalance;
        int256 quoteBalance;
        int256 lastTwPremiumGrowthGlobalX96;
    }

    function getBalanceCoefficientInFundingPayment(
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        int256 lastTwPremiumGrowthGlobalX96
    ) internal pure returns (int256 balanceCoefficientInFundingPayment) {
        return baseBalance.mul(twPremiumGrowthGlobalX96.sub(lastTwPremiumGrowthGlobalX96)).div(PerpFixedPoint96.IQ96);
    }
}
