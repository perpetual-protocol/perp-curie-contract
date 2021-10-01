// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import "../AccountBalance.sol";
import "../lib/Funding.sol";

contract TestAccountBalance is AccountBalance {
    using AddressUpgradeable for address;

    uint256 private _testBlockTimestamp;

    // copy paste from AccountBalance.initialize to avoid it to be public
    function __TestAccountBalance_init(address clearingHouseConfigArg, address exchangeArg) external initializer {
        // ClearingHouseConfig address is not contract
        require(clearingHouseConfigArg.isContract(), "AB_ENC");
        // Exchange is not contract
        require(exchangeArg.isContract(), "AB_EXNC");

        address orderBookArg = IExchange(exchangeArg).orderBook();
        // OrderBook is not contarct
        require(orderBookArg.isContract(), "AB_OBNC");

        __ClearingHouseCallee_init();

        clearingHouseConfig = clearingHouseConfigArg;
        exchange = exchangeArg;
        orderBook = orderBookArg;
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

    function getFundingGrowthGlobalAndTwaps(address baseToken)
        external
        view
        returns (
            Funding.Growth memory fundingGrowthGlobal,
            uint256 markTwap,
            uint256 indexTwap
        )
    {
        return IExchange(exchange).getFundingGrowthGlobalAndTwaps(baseToken);
    }
}
