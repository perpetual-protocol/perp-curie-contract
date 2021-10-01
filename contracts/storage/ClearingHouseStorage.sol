// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change ClearingHouseStorageV1. Create a new
/// contract which implements ClearingHouseStorageV1 and following the naming convention
/// ClearingHouseStorageVX.
abstract contract ClearingHouseStorageV1 {
    // --------- IMMUTABLE ---------
    address public quoteToken;
    address public uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;
    // --------- ^^^^^^^^^ ---------

    address public clearingHouseConfig;
    address public vault;
    address public exchange;
    address public orderBook;
    address public accountBalance;
}
