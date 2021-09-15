// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { SafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SafeMathUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { AccountMarket } from "./lib/AccountMarket.sol";
import { IIndexPrice } from "./interface/IIndexPrice.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { ClearingHouseCallee } from "./base/ClearingHouseCallee.sol";

contract AccountBalance is ClearingHouseCallee {
    using SafeMathUpgradeable for uint256;
    using SignedSafeMathUpgradeable for int256;
    using PerpSafeCast for uint256;
    using PerpSafeCast for int256;
    using PerpMath for uint256;
    using PerpMath for int256;
    using AccountMarket for AccountMarket.Info;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;

    function initialize(address marketRegistryArg) public initializer {
        __ClearingHouseCallee_init(marketRegistryArg);
    }

    function addBase(
        address trader,
        address baseToken,
        int256 delta
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.baseBalance = accountInfo.baseBalance.add(delta);
    }

    function addQuote(
        address trader,
        address baseToken,
        int256 delta
    ) external onlyClearingHouse {
        AccountMarket.Info storage accountInfo = _accountMarketMap[trader][baseToken];
        accountInfo.quoteBalance = accountInfo.quoteBalance.add(delta);
    }

    function updateFundingGrowthAngFundingPayment(
        address trader,
        address baseToken,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) external onlyClearingHouse returns (int256) {
        return
            _accountMarketMap[trader][baseToken].updateFundingGrowthAngFundingPayment(
                liquidityCoefficientInFundingPayment,
                updatedGlobalFundingGrowthTwPremiumX96
            );
    }

    function clearBalance(address trader, address baseToken) external onlyClearingHouse {
        delete _accountMarketMap[trader][baseToken];
    }

    function getPendingFundingPayment(
        address trader,
        address baseToken,
        int256 liquidityCoefficientInFundingPayment,
        int256 updatedGlobalFundingGrowthTwPremiumX96
    ) external view returns (int256 pendingFundingPayment) {
        return
            _accountMarketMap[trader][baseToken].getPendingFundingPayment(
                liquidityCoefficientInFundingPayment,
                updatedGlobalFundingGrowthTwPremiumX96
            );
    }

    function getBase(address trader, address baseToken) external view returns (int256) {
        return _accountMarketMap[trader][baseToken].baseBalance;
    }

    function getQuote(address trader, address baseToken) external view returns (int256) {
        return _accountMarketMap[trader][baseToken].quoteBalance;
    }
}
