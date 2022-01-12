// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../Exchange.sol";

contract TestExchange is Exchange {
    using AddressUpgradeable for address;

    uint256 private _testBlockTimestamp;

    // @dev copy from Exchange to bypass the constant
    function setMaxTickCrossedWithinBlock(address baseToken, uint24 maxTickCrossedWithinBlock)
        public
        override
        onlyOwner
    {
        // EX_BNC: baseToken is not contract
        require(baseToken.isContract(), "EX_BNC");
        // EX_BTNE: base token does not exists
        require(IMarketRegistry(_marketRegistry).hasPool(baseToken), "EX_BTNE");

        // tick range is [MIN_TICK, MAX_TICK], maxTickCrossedWithinBlock should be in [0, MAX_TICK - MIN_TICK]
        // EX_MTCLOOR: max tick crossed limit out of range
        require(maxTickCrossedWithinBlock <= 1774544, "EX_MTCLOOR");

        _maxTickCrossedWithinBlockMap[baseToken] = maxTickCrossedWithinBlock;
        emit MaxTickCrossedWithinBlockChanged(baseToken, maxTickCrossedWithinBlock);
    }

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
}
