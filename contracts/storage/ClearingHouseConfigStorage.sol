// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

abstract contract ClearingHouseConfigStorageV1 {
    uint8 public maxMarketsPerAccount;
    uint24 public imRatio;
    uint24 public mmRatio;
    uint24 public liquidationPenaltyRatio;
    uint24 public partialCloseRatio;
    uint32 public twapInterval;
}
