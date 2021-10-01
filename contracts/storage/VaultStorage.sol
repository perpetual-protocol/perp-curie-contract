// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IVaultStorageV1 } from "../interface/IVaultStorage.sol";

/// @notice For future upgrades, do not change VaultStorageV1. Create a new
/// contract which implements VaultStorageV1 and following the naming convention
/// VaultStorageVX.
abstract contract VaultStorageV1 is IVaultStorageV1 {
    // --------- IMMUTABLE ---------

    /// @inheritdoc IVaultStorageV1
    uint8 public override decimals;

    /// @inheritdoc IVaultStorageV1
    address public override settlementToken;

    // --------- ^^^^^^^^^ ---------

    /// @inheritdoc IVaultStorageV1
    address public override clearingHouseConfig;
    /// @inheritdoc IVaultStorageV1
    address public override accountBalance;
    /// @inheritdoc IVaultStorageV1
    address public override insuranceFund;
    /// @inheritdoc IVaultStorageV1
    address public override exchange;
    /// @inheritdoc IVaultStorageV1
    uint256 public override totalDebt;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;
}
