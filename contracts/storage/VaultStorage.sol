// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IVaultStorageV1 } from "../interface/IVaultStorage.sol";
import { BaseRelayRecipient, IRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

abstract contract VaultStorageV1 is BaseRelayRecipient, IVaultStorageV1 {
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

    /// @inheritdoc IRelayRecipient
    string public override versionRecipient;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;
}
