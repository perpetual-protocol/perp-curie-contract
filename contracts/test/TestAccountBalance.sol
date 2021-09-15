// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../AccountBalance.sol";

contract TestAccountBalance is AccountBalance {
    uint256 private _testBlockTimestamp;

    function __TestAccountBalance_init(
        address configArg,
        address marketRegistryArg,
        address exchangeArg
    ) external initializer {
        AccountBalance.initialize(configArg, marketRegistryArg, exchangeArg);
        _testBlockTimestamp = block.timestamp;
    }

    function setBlockTimestamp(uint256 blockTimestamp) external {
        _testBlockTimestamp = blockTimestamp;
    }

    function getBlockTimestamp() external view returns (uint256) {
        return _testBlockTimestamp;
    }

    function _blockTimestamp() internal view override returns (uint256) {
        return _testBlockTimestamp;
    }
}
