// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeOwnable } from "./base/SafeOwnable.sol";
import { ClearingHouseConfigStorageV1 } from "./storage/ClearingHouseConfigStorage.sol";
import { IClearingHouseConfig } from "./interface/IClearingHouseConfig.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract ClearingHouseConfig is IClearingHouseConfig, SafeOwnable, ClearingHouseConfigStorageV1 {
    //
    // EVENT
    //
    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);
    event SettlementTokenBalanceCapChanged(uint256 cap);

    //
    // MODIFIER
    //
    modifier checkRatio(uint24 ratio) {
        // CHC_RO: ratio overflow
        require(ratio <= 1e6, "CHC_RO");
        _;
    }

    //
    // CONSTRUCTOR
    //
    function initialize() external initializer {
        __SafeOwnable_init();

        _imRatio = 10e4; // initial-margin ratio, 10%
        _mmRatio = 6.25e4; // minimum-margin ratio, 6.25%
        _liquidationPenaltyRatio = 2.5e4; // initial penalty ratio, 2.5%
        _partialCloseRatio = 25e4; // partial close ratio, 25%
        _twapInterval = 15 minutes;
    }

    //
    // EXTERNAL
    //
    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        _liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setPartialCloseRatio(uint24 partialCloseRatioArg) external checkRatio(partialCloseRatioArg) onlyOwner {
        // CHC_IPCR: invalid partialCloseRatio
        require(partialCloseRatioArg > 0, "CHC_IPCR");

        _partialCloseRatio = partialCloseRatioArg;
        emit PartialCloseRatioChanged(partialCloseRatioArg);
    }

    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        // CHC_ITI: invalid twapInterval
        require(twapIntervalArg != 0, "CHC_ITI");

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
}
