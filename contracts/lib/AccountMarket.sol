// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { PerpFixedPoint96 } from "./PerpFixedPoint96.sol";

library AccountMarket {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;

    struct Info {
        int256 baseBalance;
        int256 quoteBalance;
        // the last time weighted PremiumGrowthGlobalX96
        int256 lastTwPremiumGrowthGlobalX96;
    }

    /// @dev this is the non-view version of getPendingFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & balance coefficients
    function updateFundingGrowthAngFundingPayment(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal returns (int256 fundingPayment) {
        // funding of balance coefficient
        int256 balanceCoefficientInFundingPayment =
            getBalanceCoefficientInFundingPayment(
                self.baseBalance,
                updatedGlobalFundingGrowthTwPremiumX96,
                self.lastTwPremiumGrowthGlobalX96
            );

        // update fundingGrowth of funding payment coefficient of balance
        self.lastTwPremiumGrowthGlobalX96 = updatedGlobalFundingGrowthTwPremiumX96;

        return liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(1 days);
    }

    //
    // VIEW
    //

    /// @dev this is the view version of updateFundingGrowthAngFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & balance coefficients
    function getPendingFundingPayment(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal view returns (int256 fundingPayment) {
        // funding of balance coefficient
        int256 balanceCoefficientInFundingPayment =
            getBalanceCoefficientInFundingPayment(
                self.baseBalance,
                updatedGlobalFundingGrowthTwPremiumX96,
                self.lastTwPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(balanceCoefficientInFundingPayment).div(1 days);
    }

    function getBalanceCoefficientInFundingPayment(
        int256 baseBalance,
        int256 twPremiumGrowthGlobalX96,
        int256 lastTwPremiumGrowthGlobalX96
    ) internal pure returns (int256 balanceCoefficientInFundingPayment) {
        return baseBalance.mul(twPremiumGrowthGlobalX96.sub(lastTwPremiumGrowthGlobalX96)).div(PerpFixedPoint96.IQ96);
    }
}
