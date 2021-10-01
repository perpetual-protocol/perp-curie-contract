// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { BaseRelayRecipient, IRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

abstract contract ClearingHouseStorageV1 is BaseRelayRecipient {
    // --------- IMMUTABLE ---------
    address internal quoteToken;
    address internal uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;
    // --------- ^^^^^^^^^ ---------

    /// @inheritdoc IRelayRecipient
    string public override versionRecipient;

    address internal clearingHouseConfig;
    address internal vault;
    address internal exchange;
    address internal orderBook;
    address internal accountBalance;
}
