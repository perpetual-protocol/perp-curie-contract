// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { VirtualToken } from "../VirtualToken.sol";

abstract contract BaseTokenStorageV1 is VirtualToken {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    address public priceFeed;
}
