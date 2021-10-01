// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IBaseTokenStorageV1 } from "../interface/IBaseTokenStorage.sol";

abstract contract BaseTokenStorageV1 is IBaseTokenStorageV1 {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    /// @inheritdoc IBaseTokenStorageV1
    address public override priceFeed;
}
