// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { SafeOwnable } from "./SafeOwnable.sol";

abstract contract OwnerPausable is SafeOwnable, Pausable {
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
