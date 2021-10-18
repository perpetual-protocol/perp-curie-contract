// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IClearingHouseConfig {
    function getMaxMarketsPerAccount() external view returns (uint8);

    function getImRatio() external view returns (uint24);

    function getMmRatio() external view returns (uint24);

    function getLiquidationPenaltyRatio() external view returns (uint24);

    function getPartialCloseRatio() external view returns (uint24);

    function getTwapInterval() external view returns (uint32);

    function getSettlementTokenBalanceCap() external view returns (uint256);
}
