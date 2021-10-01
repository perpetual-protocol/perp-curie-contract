// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IClearingHouseConfigStorageV1 } from "../interface/IClearingHouseConfigStorage.sol";

/// @notice For future upgrades, do not change ClearingHouseConfigStorageV1. Create a new
/// contract which implements ClearingHouseConfigStorageV1 and following the naming convention
/// ClearingHouseConfigStorageVX.
abstract contract ClearingHouseConfigStorageV1 is IClearingHouseConfigStorageV1 {
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint8 public override maxMarketsPerAccount;
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint24 public override imRatio;
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint24 public override mmRatio;
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint24 public override liquidationPenaltyRatio;
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint24 public override partialCloseRatio;
    /// @inheritdoc IClearingHouseConfigStorageV1
    uint32 public override twapInterval;
}
