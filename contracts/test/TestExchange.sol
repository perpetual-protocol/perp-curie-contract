// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../Exchange.sol";

contract TestExchange is Exchange {
    using AddressUpgradeable for address;

    uint256 private _testBlockTimestamp;

    // copy paste from AccountBalance.initialize to avoid it to be public

    function setBlockTimestamp(uint256 blockTimestamp) external {
        _testBlockTimestamp = blockTimestamp;
    }

    function getBlockTimestamp() external view returns (uint256) {
        return _testBlockTimestamp;
    }

    function _blockTimestamp() internal view override returns (uint256) {
        return _testBlockTimestamp;
    }

    // @dev max tick range = 887272 * 2
    // @dev ref : https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol#L25
    function _getMaxTickCrossedWithinBlockCap() internal pure override returns (uint24) {
        return 1774544;
    }
}
