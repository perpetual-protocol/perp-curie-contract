// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change ClearingHouseConfigStorageV1. Create a new
/// contract which implements ClearingHouseConfigStorageV1 and following the naming convention
/// ClearingHouseConfigStorageVX.
abstract contract ClearingHouseConfigStorageV1 {
    uint8 internal _maxMarketsPerAccount;
    uint24 internal _imRatio;
    uint24 internal _mmRatio;
    uint24 internal _liquidationPenaltyRatio;

    // _partialCloseRatio is deprecated
    uint24 internal _partialCloseRatio;

    uint24 internal _maxFundingRate;
    uint32 internal _twapInterval;
    uint256 internal _settlementTokenBalanceCap;
}

abstract contract ClearingHouseConfigStorageV2 is ClearingHouseConfigStorageV1 {
    // _backstopLiquidityProviderMap is deprecated
    mapping(address => bool) internal _backstopLiquidityProviderMap;
}

abstract contract ClearingHouseConfigStorageV3 is ClearingHouseConfigStorageV2 {
    uint32 internal _markPriceMarketTwapInterval;
    uint32 internal _markPricePremiumInterval;
}
