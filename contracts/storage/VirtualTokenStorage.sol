// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { SafeOwnable } from "../base/SafeOwnable.sol";

abstract contract VirtualTokenStorageV1 is SafeOwnable, ERC20Upgradeable {
    mapping(address => bool) internal _whitelistMap;
}
