// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { Funding } from "../lib/Funding.sol";

/// @notice For future upgrades, do not change ExchangeStorageV1. Create a new
/// contract which implements ExchangeStorageV1 and following the naming convention
/// ExchangeStorageVX.
abstract contract ExchangeStorageV1 {
    address internal _orderBook;
    address internal _accountBalance;
    address internal _clearingHouseConfig;

    mapping(address => int24) internal _lastUpdatedTickMap;
    mapping(address => uint256) internal _firstTradedTimestampMap;
    // the last timestamp when funding is settled
    mapping(address => uint256) internal _lastSettledTimestampMap;
    mapping(address => Funding.Growth) internal _globalFundingGrowthX96Map;

    // key: base token
    // value: a threshold to limit the price impact per block when reducing or closing the position
    mapping(address => uint24) internal _maxTickCrossedWithinBlockMap;

    // _lastOverPriceLimitTimestampMap is deprecated
    // first key: trader, second key: baseToken
    // value: the last timestamp when a trader exceeds price limit when closing a position/being liquidated
    mapping(address => mapping(address => uint256)) internal _lastOverPriceLimitTimestampMap;
}

abstract contract ExchangeStorageV2 is ExchangeStorageV1 {
    // the last timestamp when tick is updated; for price limit check
    // key: base token
    // value: the last timestamp to update the tick
    mapping(address => uint256) internal _lastTickUpdatedTimestampMap;
}
