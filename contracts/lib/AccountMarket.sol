// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { SafeMath } from "@openzeppelin/contracts/math/SafeMath.sol";
import { SignedSafeMath } from "@openzeppelin/contracts/math/SignedSafeMath.sol";
import { PerpSafeCast } from "./PerpSafeCast.sol";
import { PerpFixedPoint96 } from "./PerpFixedPoint96.sol";
import { TokenBalance } from "./TokenBalance.sol";
import { Funding } from "./Funding.sol";

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

    function clear(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token
    ) internal {
        delete self[trader][token];
    }

    function addAvailable(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token,
        int256 delta
    ) internal {
        AccountMarket.Info storage accountMarket = self[trader][token];
        accountMarket.tokenInfo.addAvailable(delta);
    }

    function addDebt(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token,
        int256 delta
    ) internal {
        AccountMarket.Info storage accountMarket = self[trader][token];
        accountMarket.tokenInfo.addDebt(delta);
    }

    function addOpenNotionalFraction(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token,
        int256 delta
    ) internal {
        AccountMarket.Info storage accountMarket = self[trader][token];
        accountMarket.openNotionalFraction = accountMarket.openNotionalFraction.add(delta);
    }

    function updateLastFundingGrowth(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal returns (int256 fundingPayment) {
        AccountMarket.Info storage accountMarket = self[trader][token];
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                accountMarket.tokenInfo,
                updatedGlobalFundingGrowthTwPremiumX96,
                accountMarket.lastTwPremiumGrowthGlobalX96
            );
        int256 fundingPayment =
            liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(1 days);

        // update fundingGrowth of funding payment coefficient from available and debt
        accountMarket.lastTwPremiumGrowthGlobalX96 = updatedGlobalFundingGrowthTwPremiumX96;
        return fundingPayment;
    }

    function getPendingFundingPayment(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) internal view returns (int256 fundingPayment) {
        AccountMarket.Info memory accountMarket = self[trader][token];

        // funding of liquidity
        int256 availableAndDebtCoefficientInFundingPayment =
            getAvailableAndDebtCoefficientInFundingPayment(
                accountMarket.tokenInfo,
                updatedGlobalFundingGrowthTwPremiumX96,
                accountMarket.lastTwPremiumGrowthGlobalX96
            );

        return liquidityCoefficientInFundingPayment.add(availableAndDebtCoefficientInFundingPayment).div(1 days);
    }

    function getAvailable(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token
    ) internal view returns (uint256) {
        return self[trader][token].tokenInfo.available;
    }

    function getDebt(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token
    ) internal view returns (uint256) {
        return self[trader][token].tokenInfo.debt;
    }

    function getTokenInfo(
        mapping(address => mapping(address => AccountMarket.Info)) storage self,
        address trader,
        address token
    ) internal view returns (TokenBalance.Info memory) {
        return self[trader][token].tokenInfo;
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
