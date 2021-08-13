// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { ArbBlockContext } from "../arbitrum/ArbBlockContext.sol";

abstract contract Validation is ArbBlockContext {
    modifier checkDeadline(uint256 deadline) {
        // transaction expires
        require(_blockTimestamp() <= deadline, "V_TE");
        _;
    }
}
