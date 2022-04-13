// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { IBaseToken } from "../interface/IBaseToken.sol";

/// @notice For future upgrades, do not change BaseTokenStorageV1. Create a new
/// contract which implements BaseTokenStorageV1 and following the naming convention
/// BaseTokenStorageVX.
abstract contract BaseTokenStorageV1 {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    address internal _priceFeed;
}

abstract contract BaseTokenStorageV2 is BaseTokenStorageV1 {
    IBaseToken.Status internal _status;

    uint256 internal _pausedIndexPrice;

    uint256 internal _pausedTimestamp;

    uint256 internal _closedPrice;
}
