// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { OwnerPausable } from "../base/OwnerPausable.sol";
import { BaseRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

abstract contract ClearingHouseStorageV1 is ReentrancyGuardUpgradeable, OwnerPausable, BaseRelayRecipient {
    // --------- IMMUTABLE ---------
    address internal quoteToken;
    address internal uniswapV3Factory;

    // cache the settlement token's decimals for gas optimization
    uint8 internal _settlementTokenDecimals;
    // --------- ^^^^^^^^^ ---------

    // not used in CH, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    address internal clearingHouseConfig;
    address internal vault;
    address internal exchange;
    address internal orderBook;
    address internal accountBalance;

    //
    // INTERNAL VIEW
    //

    /// @inheritdoc BaseRelayRecipient
    function _msgSender() internal view override(BaseRelayRecipient, OwnerPausable) returns (address payable) {
        return super._msgSender();
    }

    /// @inheritdoc BaseRelayRecipient
    function _msgData() internal view override(BaseRelayRecipient, OwnerPausable) returns (bytes memory) {
        return super._msgData();
    }
}
