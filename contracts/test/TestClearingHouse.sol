// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { ClearingHouse } from "../ClearingHouse.sol";

contract TestClearingHouse is ClearingHouse {
    uint256 private _testBlockTimestamp = 1;

    constructor(
        address vaultArg,
        address quoteTokenArg,
        address uniV3FactoryArg
    ) ClearingHouse(vaultArg, quoteTokenArg, uniV3FactoryArg) {}

    function setBlockTimestamp(uint256 blockTimestamp) external {
        _testBlockTimestamp = blockTimestamp;
    }

    function _blockTimestamp() internal view override returns (uint256) {
        return _testBlockTimestamp;
    }
}
