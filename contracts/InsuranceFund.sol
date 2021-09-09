// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import { Vault } from "./Vault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";

contract InsuranceFund is ReentrancyGuardUpgradeable, OwnerPausable {
    // TODO should be immutable, check how to achieve this in oz upgradeable framework.
    address public vault;
    address private _token;

    function initialize(address vaultArg) external initializer {
        __ReentrancyGuard_init();
        __OwnerPausable_init();

        vault = vaultArg;
        _token = Vault(vaultArg).settlementToken();
    }
}
