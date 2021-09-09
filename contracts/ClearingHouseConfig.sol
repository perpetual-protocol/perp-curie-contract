// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeOwnable } from "./base/SafeOwnable.sol";

// TODO can be immutable
contract ClearingHouseConfig is SafeOwnable {
    uint24 public imRatio;
    uint24 public mmRatio;

    uint24 public liquidationPenaltyRatio;
    uint24 public partialCloseRatio;
    uint8 public maxMarketsPerAccount;

    uint32 public twapInterval;

    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);

    function initialize() public initializer {
        imRatio = 10e4; // initial-margin ratio, 10%
        mmRatio = 6.25e4; // minimum-margin ratio, 6.25%
        liquidationPenaltyRatio = 2.5e4; // initial penalty ratio, 2.5%
        partialCloseRatio = 25e4; // partial close ratio, 25%
        twapInterval = 15 minutes;
    }

    //
    // MODIFIER
    //
    modifier checkRatio(uint24 ratio) {
        // CH_RL1: ratio overflow
        require(ratio <= 1e6, "CH_RO");
        _;
    }

    //
    // EXTERNAL
    //
    function setTwapInterval(uint32 twapIntervalArg) external onlyOwner {
        // CH_ITI: invalid twapInterval
        require(twapIntervalArg != 0, "CH_ITI");

        twapInterval = twapIntervalArg;
        emit TwapIntervalChanged(twapIntervalArg);
    }

    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg)
        external
        checkRatio(liquidationPenaltyRatioArg)
        onlyOwner
    {
        liquidationPenaltyRatio = liquidationPenaltyRatioArg;
        emit LiquidationPenaltyRatioChanged(liquidationPenaltyRatioArg);
    }

    function setPartialCloseRatio(uint24 partialCloseRatioArg) external checkRatio(partialCloseRatioArg) onlyOwner {
        partialCloseRatio = partialCloseRatioArg;
        emit PartialCloseRatioChanged(partialCloseRatioArg);
    }

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external onlyOwner {
        maxMarketsPerAccount = maxMarketsPerAccountArg;
        emit MaxMarketsPerAccountChanged(maxMarketsPerAccountArg);
    }
}
