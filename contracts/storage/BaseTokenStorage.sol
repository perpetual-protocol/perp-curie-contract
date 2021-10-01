// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IBaseTokenState } from "../interface/IBaseTokenState.sol";

abstract contract BaseTokenStorageV1 is IBaseTokenState {
    // --------- IMMUTABLE ---------

    uint8 internal _priceFeedDecimals;

    // --------- ^^^^^^^^^ ---------

    /// @inheritdoc IBaseTokenState
    address public override priceFeed;
}
