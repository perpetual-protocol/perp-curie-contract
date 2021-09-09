// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { PerpFixedPoint96 } from "./PerpFixedPoint96.sol";
import { TokenBalance } from "./TokenBalance.sol";

library AccountMarket {
    using SafeMathUpgradeable for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMathUpgradeable for int256;
    using TokenBalance for TokenBalance.Info;

    struct Info {
        // balance & debt info of each base token
        TokenBalance.Info tokenInfo;
        // the last time weighted PremiumGrowthGlobalX96
        int256 lastTwPremiumGrowthGlobalX96;
        // fraction of open notional that can unify the openNotional for both maker and taker
        int256 openNotionalFraction;
    }

    function addAvailable(Info storage self, uint256 delta) internal {
        self.tokenInfo.addAvailable(delta);
    }

    function addAvailable(Info storage self, int256 delta) internal {
        self.tokenInfo.addAvailable(delta);
    }

    function addDebt(Info storage self, uint256 delta) internal {
        self.tokenInfo.addDebt(delta);
    }

    function addDebt(Info storage self, int256 delta) internal {
        self.tokenInfo.addDebt(delta);
    }

    function addOpenNotionalFraction(Info storage self, int256 delta) internal {
        self.openNotionalFraction = self.openNotionalFraction.add(delta);
    }

    /// @dev this is the non-view version of getPendingFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & availableAndDebt coefficients
    function updateFundingGrowthAngFundingPayment(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 fundingGrowthGlobalTwPremiumX96
    ) internal returns (int256 fundingPayment) {
        // funding of available and debt coefficient
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                self.tokenInfo,
                fundingGrowthGlobalTwPremiumX96,
                self.lastTwPremiumGrowthGlobalX96
            );

        // update fundingGrowth of funding payment coefficient of available and debt
        self.lastTwPremiumGrowthGlobalX96 = fundingGrowthGlobalTwPremiumX96;

        return liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(1 days);
    }

    //
    // VIEW
    //

    /// @dev this is the view version of updateFundingGrowthAngFundingPayment()
    /// @return fundingPayment the funding payment of a market, including liquidity & availableAndDebt coefficients
    function getPendingFundingPayment(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 fundingGrowthGlobalTwPremiumX96
    ) internal view returns (int256 fundingPayment) {
        // funding of available and debt coefficient
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                self.tokenInfo,
                fundingGrowthGlobalTwPremiumX96,
                self.lastTwPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(1 days);
    }

    function getAvailable(Info storage self) internal view returns (uint256) {
        return self.tokenInfo.available;
    }

    function getDebt(Info storage self) internal view returns (uint256) {
        return self.tokenInfo.debt;
    }

    function getTokenBalance(Info storage self) internal view returns (TokenBalance.Info memory) {
        return self.tokenInfo;
    }

    function getAvailableAndDebtCoefficientInFundingPayment(
        TokenBalance.Info memory tokenInfo,
        int256 twPremiumGrowthGlobalX96,
        int256 lastTwPremiumGrowthGlobalX96
    ) internal pure returns (int256 availableAndDebtCoefficientInFundingPayment) {
        return
            tokenInfo
                .available
                .toInt256()
                .sub(tokenInfo.debt.toInt256())
                .mul(twPremiumGrowthGlobalX96.sub(lastTwPremiumGrowthGlobalX96))
                .div(PerpFixedPoint96.IQ96);
    }
}
