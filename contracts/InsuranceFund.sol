// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Vault } from "./Vault.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";

contract InsuranceFund is ReentrancyGuard, OwnerPausable {
    address public immutable vault;
    address private immutable _token;

    constructor(address vaultArg) public {
        vault = vaultArg;
        _token = Vault(vaultArg).settlementToken();
    }
}
