// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { AccountMarket } from "../lib/AccountMarket.sol";

/// @notice For future upgrades, do not change AccountBalanceStorageV1. Create a new
/// contract which implements AccountBalanceStorageV1 and following the naming convention
/// AccountBalanceStorageVX.
abstract contract AccountBalanceStorageV1 {
    address internal _clearingHouseConfig;
    address internal _orderBook;
    address internal _vault;

    // trader => owedRealizedPnl
    mapping(address => int256) internal _owedRealizedPnlMap;

    // trader => baseTokens
    // base token registry of each trader
    mapping(address => address[]) internal _baseTokensMap;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;
}
