// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeOwnable } from "./base/SafeOwnable.sol";
import { ClearingHouseConfigStorageV1 } from "./storage/ClearingHouseConfigStorage.sol";

contract ClearingHouseConfig is SafeOwnable, ClearingHouseConfigStorageV1 {
    //
    // EVENT
    //
    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);

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
    function initialize() public initializer {
        __SafeOwnable_init();

        imRatio = 10e4; // initial-margin ratio, 10%
        mmRatio = 6.25e4; // minimum-margin ratio, 6.25%
        liquidationPenaltyRatio = 2.5e4; // initial penalty ratio, 2.5%
        partialCloseRatio = 25e4; // partial close ratio, 25%
        twapInterval = 15 minutes;
    }

    //
    // EXTERNAL
    //
    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setPartialCloseRatio(uint24 partialCloseRatioArg) external checkRatio(partialCloseRatioArg) onlyOwner {
        // CHC_IPCR: invalid partialCloseRatio
        require(partialCloseRatioArg > 0, "CHC_IPCR");

        partialCloseRatio = partialCloseRatioArg;
        emit PartialCloseRatioChanged(partialCloseRatioArg);
    }

    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        // CHC_ITI: invalid twapInterval
        require(twapIntervalArg != 0, "CHC_ITI");

        twapInterval = twapIntervalArg;
        emit TwapIntervalChanged(twapIntervalArg);
    }

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external onlyOwner {
        maxMarketsPerAccount = maxMarketsPerAccountArg;
        emit MaxMarketsPerAccountChanged(maxMarketsPerAccountArg);
    }
}
