// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Vault } from "./Vault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";

contract InsuranceFund is ReentrancyGuardUpgradeable, OwnerPausable {
    using AddressUpgradeable for address;

    // ------ immutable states ------
    address public vault;
    address private _token;

    // ------ ^^^^^^^^^^^^^^^^ ------

    function initialize(address vaultArg) external initializer {
        // IF_ANC: vault address is not contract
        require(vaultArg.isContract(), "IF_ANC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        vault = vaultArg;
        _token = Vault(vaultArg).settlementToken();
    }
}
