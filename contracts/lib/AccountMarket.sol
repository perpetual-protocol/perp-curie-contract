// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { PerpFixedPoint96 } from "./PerpFixedPoint96.sol";
import { TokenBalance } from "./TokenBalance.sol";

library AccountMarket {
    using SafeMath for uint256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using SignedSafeMath for int256;
    using TokenBalance for TokenBalance.Info;

    struct Info {
        // balance & debt info of each base token
        TokenBalance.Info tokenInfo;
        // the last time weighted PremiumGrowthGlobalX96
        int256 lastTwPremiumGrowthGlobalX96;
        // fraction of open notional that can unify the openNotional for both maker and taker
        int256 openNotionalFraction;
    }

    function clear(Info storage self) internal {
        // TODO find a better way to clear data
        self.tokenInfo = TokenBalance.Info(0, 0);
        self.lastTwPremiumGrowthGlobalX96 = 0;
        self.openNotionalFraction = 0;
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

    function updateLastFundingGrowth(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal returns (int256) {
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                self.tokenInfo,
                updatedGlobalFundingGrowthTwPremiumX96,
                self.lastTwPremiumGrowthGlobalX96
            );
        int256 fundingPayment =
            liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(1 days);

        // update fundingGrowth of funding payment coefficient from available and debt
        self.lastTwPremiumGrowthGlobalX96 = updatedGlobalFundingGrowthTwPremiumX96;
        return fundingPayment;
    }

    //
    // VIEW
    //
    function getPendingFundingPayment(
        Info storage self,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal view returns (int256 fundingPayment) {
        // funding of liquidity
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                self.tokenInfo,
                updatedGlobalFundingGrowthTwPremiumX96,
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
