// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { AggregatorV3Interface } from "@chainlink/contracts/src/v0.6/interfaces/AggregatorV3Interface.sol";

contract TestAggregatorV3 is AggregatorV3Interface {
    function decimals() external view override returns (uint8) {
        revert();
    }

    function description() external view override returns (string memory) {
        revert();
    }

    function version() external view override returns (uint256) {
        revert();
    }

    function getRoundData(uint80 _roundId)
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        revert();
    }

    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        revert();
    }
}
