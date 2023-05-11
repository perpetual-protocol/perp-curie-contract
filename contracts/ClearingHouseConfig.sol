// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { SafeOwnable } from "./base/SafeOwnable.sol";
import { ClearingHouseConfigStorageV3 } from "./storage/ClearingHouseConfigStorage.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract ClearingHouseConfig is IClearingHouseConfig, SafeOwnable, ClearingHouseConfigStorageV3 {
    //
    // MODIFIER
    //

    modifier checkRatio(uint24 ratio) {
        // CHC_RO: ratio overflow
        require(ratio <= 1e6, "CHC_RO");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize() external initializer {
        __SafeOwnable_init();

        _maxMarketsPerAccount = type(uint8).max;
        _imRatio = 0.1e6; // initial-margin ratio, 10% in decimal 6
        _mmRatio = 0.0625e6; // minimum-margin ratio, 6.25% in decimal 6
        _liquidationPenaltyRatio = 0.025e6; // initial penalty ratio, 2.5% in decimal 6
        _maxFundingRate = 0.1e6; // max funding rate, 10% in decimal 6
        _twapInterval = 15 minutes;
        _settlementTokenBalanceCap = 0;
        _markPriceMarketTwapInterval = 30 minutes;
        _markPricePremiumInterval = 15 minutes;
    }

    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        _liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        _twapInterval = twapIntervalArg;
        emit TwapIntervalChanged(twapIntervalArg);
    }

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external onlyOwner {
        _maxMarketsPerAccount = maxMarketsPerAccountArg;
        emit MaxMarketsPerAccountChanged(maxMarketsPerAccountArg);
    }

    function setSettlementTokenBalanceCap(uint256 cap) external onlyOwner {
        _settlementTokenBalanceCap = cap;
        emit SettlementTokenBalanceCapChanged(cap);
    }

    function setMaxFundingRate(uint24 rate) external onlyOwner {
        _maxFundingRate = rate;
        emit MaxFundingRateChanged(rate);
    }

    function setMarkPriceMarketTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        // CHC_IMPMTI: invalid mark price market twap interval
        require(twapIntervalArg != 0, "CHC_IMPMTI");

        _markPriceMarketTwapInterval = twapIntervalArg;
        emit MarkPriceMarketTwapIntervalChanged(twapIntervalArg);
    }

    function setMarkPricePremiumInterval(uint32 premiumIntervalArg) external onlyOwner {
        // CHC_IMPPI: invalid mark price premium interval
        require(premiumIntervalArg != 0, "CHC_IMPPI");

        _markPricePremiumInterval = premiumIntervalArg;
        emit MarkPricePremiumIntervalChanged(premiumIntervalArg);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IClearingHouseConfig
    function getMaxMarketsPerAccount() external view override returns (uint8) {
        return _maxMarketsPerAccount;
    }

    /// @inheritdoc IClearingHouseConfig
    function getImRatio() external view override returns (uint24) {
        return _imRatio;
    }

    /// @inheritdoc IClearingHouseConfig
    function getMmRatio() external view override returns (uint24) {
        return _mmRatio;
    }

    /// @inheritdoc IClearingHouseConfig
    function getLiquidationPenaltyRatio() external view override returns (uint24) {
        return _liquidationPenaltyRatio;
    }

    /// @inheritdoc IClearingHouseConfig
    function getPartialCloseRatio() external view override returns (uint24) {
        return _partialCloseRatio;
    }

    /// @inheritdoc IClearingHouseConfig
    function getTwapInterval() external view override returns (uint32) {
        return _twapInterval;
    }

    /// @inheritdoc IClearingHouseConfig
    function getSettlementTokenBalanceCap() external view override returns (uint256) {
        return _settlementTokenBalanceCap;
    }

    /// @inheritdoc IClearingHouseConfig
    function getMaxFundingRate() external view override returns (uint24) {
        return _maxFundingRate;
    }

    /// @inheritdoc IClearingHouseConfig
    function getMarkPriceConfig() external view override returns (uint32, uint32) {
        return (_markPriceMarketTwapInterval, _markPricePremiumInterval);
    }
}
