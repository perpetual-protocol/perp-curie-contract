// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IClearingHouseConfig {
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
