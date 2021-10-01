// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { SafeOwnable } from "../base/SafeOwnable.sol";
import { IClearingHouseConfigState } from "../interface/IClearingHouseConfigState.sol";

abstract contract ClearingHouseConfigStorageV1 is SafeOwnable, IClearingHouseConfigState {
    uint8 public override maxMarketsPerAccount;
    uint24 public override imRatio;
    uint24 public override mmRatio;
    uint24 public override liquidationPenaltyRatio;
    uint24 public override partialCloseRatio;
    uint32 public override twapInterval;
}
