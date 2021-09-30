// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { BaseRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

abstract contract ClearingHouseStorageV1 is BaseRelayRecipient {
    // --------- IMMUTABLE ---------

    address public quoteToken;
    address public uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;

    // --------- ^^^^^^^^^ ---------

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address public clearingHouseConfig;
    address public vault;
    address public exchange;
    address public orderBook;
    address public accountBalance;
}
