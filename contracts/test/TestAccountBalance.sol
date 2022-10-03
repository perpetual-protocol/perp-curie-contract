// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../AccountBalance.sol";
import "../lib/Funding.sol";

contract TestAccountBalance is AccountBalance {
    using AddressUpgradeable for address;

    uint256 private _testBlockTimestamp;

    // copy paste from AccountBalance.initialize to avoid it to be public
    function __TestAccountBalance_init(address clearingHouseConfigArg, address orderBookArg) external initializer {
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_ENC");

        // OrderBook is not contarct
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init();

        _clearingHouseConfig = clearingHouseConfigArg;
        _orderBook = orderBookArg;
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

    function getNetQuoteBalanceAndPendingFee(address trader)
        external
        view
        returns (int256 netQuoteBalance, uint256 pendingFee)
    {
        return _getNetQuoteBalanceAndPendingFee(trader);
    }

    function testModifyOwedRealizedPnl(address trader, int256 owedRealizedPnlDelta) external {
        _modifyOwedRealizedPnl(trader, owedRealizedPnlDelta);
    }
}
