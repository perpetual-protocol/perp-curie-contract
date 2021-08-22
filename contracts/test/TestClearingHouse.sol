// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { ClearingHouse } from "../ClearingHouse.sol";

contract TestClearingHouse is ClearingHouse {
    uint256 private _testBlockTimestamp = 1;

    constructor(
        address vaultArg,
        address insuranceFundArg,
        address quoteTokenArg,
        address uniV3FactoryArg,
        uint8 maxOrdersPerMarketArg,
        uint8 maxMarketsPerAccountArg
    )
        ClearingHouse(
            vaultArg,
            insuranceFundArg,
            quoteTokenArg,
            uniV3FactoryArg,
            maxOrdersPerMarketArg,
            maxMarketsPerAccountArg
        )
    {
        _testBlockTimestamp = block.timestamp;
    }

    function setBlockTimestamp(uint256 blockTimestamp) external {
        _testBlockTimestamp = blockTimestamp;
    }

    function _blockTimestamp() internal view override returns (uint256) {
        return _testBlockTimestamp;
    }
}
