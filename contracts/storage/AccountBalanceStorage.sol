// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AccountMarket } from "../lib/AccountMarket.sol";

abstract contract AccountBalanceStorageV1 {
    address internal clearingHouseConfig;
    address internal exchange;
    address internal orderBook;
    address internal vault;

    // trader => owedRealizedPnl
    mapping(address => int256) internal _owedRealizedPnlMap;

    // trader => baseTokens
    // base token registry of each trader
    mapping(address => address[]) internal _baseTokensMap;

    // first key: trader, second key: baseToken
    mapping(address => mapping(address => AccountMarket.Info)) internal _accountMarketMap;
}
