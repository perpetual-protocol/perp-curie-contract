// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change VaultStorageV1. Create a new
/// contract which implements VaultStorageV1 and following the naming convention
/// VaultStorageVX.
abstract contract VaultStorageV1 {
    // --------- IMMUTABLE ---------

    uint8 internal _decimals;

    address internal _settlementToken;

    // --------- ^^^^^^^^^ ---------

    address internal _clearingHouseConfig;
    address internal _accountBalance;
    address internal _insuranceFund;
    address internal _exchange;
    address internal _clearingHouse;
    uint256 internal _totalDebt;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;
}
