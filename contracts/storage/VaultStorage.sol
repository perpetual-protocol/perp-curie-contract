// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IVault } from "../interface/IVault.sol";
import { BaseRelayRecipient } from "../gsn/BaseRelayRecipient.sol";

abstract contract VaultStorageV1 is BaseRelayRecipient, IVault {
    // --------- IMMUTABLE ---------

    // cached the settlement token's decimal for gas optimization
    uint8 public override decimals;

    address public settlementToken;

    // --------- ^^^^^^^^^ ---------

    address public clearingHouseConfig;
    address public accountBalance;
    address public insuranceFund;
    address public exchange;

    uint256 public totalDebt;

    // not used here, due to inherit from BaseRelayRecipient
    string public override versionRecipient;

    // key: trader, token address
    mapping(address => mapping(address => int256)) internal _balance;
}
