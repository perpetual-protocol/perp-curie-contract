// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change BaseTokenStorageV1. Create a new
/// contract which implements BaseTokenStorageV1 and following the naming convention
/// BaseTokenStorageVX.
abstract contract BaseTokenStorageV1 {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    address internal _priceFeed;
}
