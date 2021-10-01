// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IClearingHouseConfigState } from "../interface/IClearingHouseConfigState.sol";

abstract contract ClearingHouseConfigStorageV1 is IClearingHouseConfigState {
    /// @inheritdoc IClearingHouseConfigState
    uint8 public override maxMarketsPerAccount;
    /// @inheritdoc IClearingHouseConfigState
    uint24 public override imRatio;
    /// @inheritdoc IClearingHouseConfigState
    uint24 public override mmRatio;
    /// @inheritdoc IClearingHouseConfigState
    uint24 public override liquidationPenaltyRatio;
    /// @inheritdoc IClearingHouseConfigState
    uint24 public override partialCloseRatio;
    /// @inheritdoc IClearingHouseConfigState
    uint32 public override twapInterval;
}
