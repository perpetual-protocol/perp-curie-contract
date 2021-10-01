// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

abstract contract BaseTokenStorageV1 {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    address public priceFeed;
}
