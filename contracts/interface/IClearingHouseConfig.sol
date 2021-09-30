// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IClearingHouseConfig {
    //
    // EVENT
    //
    event TwapIntervalChanged(uint256 twapInterval);
    event LiquidationPenaltyRatioChanged(uint24 liquidationPenaltyRatio);
    event PartialCloseRatioChanged(uint24 partialCloseRatio);
    event MaxMarketsPerAccountChanged(uint8 maxMarketsPerAccount);

    //
    // FUNCTIONS
    //
    function setLiquidationPenaltyRatio(uint24 liquidationPenaltyRatioArg) external;

    function setPartialCloseRatio(uint24 partialCloseRatioArg) external;

    function setTwapInterval(uint32 twapIntervalArg) external;

    function setMaxMarketsPerAccount(uint8 maxMarketsPerAccountArg) external;

    //
    // VIEW
    //
    function maxMarketsPerAccount() external view returns (uint8);

    function imRatio() external view returns (uint24);

    function mmRatio() external view returns (uint24);

    function liquidationPenaltyRatio() external view returns (uint24);

    function partialCloseRatio() external view returns (uint24);

    function twapInterval() external view returns (uint32);
}
